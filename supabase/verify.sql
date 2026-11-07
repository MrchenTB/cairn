-- =============================================================================
-- Cairn: read-only check of a Supabase project's schema and permissions.
--
-- Paste the whole file into Dashboard -> SQL Editor and press Run, or run it with psql. It only reads
-- system catalogs: it changes nothing and reads no user data.
--
-- Expected result: every row says pass = true. Sort order puts failures first, so one look at the
-- top row is enough. tests/db/verify.test.ts proves that each check really fails when its
-- safeguard is removed.
-- =============================================================================

with
expected_tables (name) as (
  values ('projects'), ('phases'), ('tasks'), ('milestones'), ('task_dependencies'),
    ('user_preferences')
),
expected_rpcs (signature) as (
  values
    ('apply_task_schedule(jsonb)'),
    ('delete_task(uuid, boolean, jsonb)'),
    ('import_workspace(jsonb)')
),
public_tables as (
  select c.oid, c.relname as name, c.relrowsecurity as rls
  from pg_class as c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
),
public_functions as (
  -- Not ::regprocedure: its text depends on the search_path of whoever runs this.
  select
    p.oid,
    p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
    p.prosecdef,
    p.proconfig
  from pg_proc as p
  where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
),
checks (name, pass, detail) as (
  -- PostgreSQL
  select
    'PostgreSQL 15 or newer',
    current_setting('server_version_num')::int >= 150000,
    current_setting('server_version')

  -- Migrations
  union all
  select
    'All 6 Cairn tables exist',
    not exists (
      select 1 from expected_tables as e
      where not exists (select 1 from public_tables as t where t.name = e.name)
    ),
    coalesce((
      select 'missing: ' || string_agg(e.name, ', ')
      from expected_tables as e
      where not exists (select 1 from public_tables as t where t.name = e.name)
    ), 'found all')
  union all
  select
    'Migration 20261106 applied: phases.color exists',
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'phases' and column_name = 'color'
    ),
    'run supabase/migrations/20261106000000_phase_color.sql if this fails'
  union all
  select
    'Migration 20261106 applied: phase colours are constrained',
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('public.phases') and conname = 'phases_color_valid'
    ),
    'phases_color_valid'
  union all
  select
    'Migration 20261106 applied: backup import keeps phase colours',
    exists (
      select 1 from pg_proc
      where proname = 'import_workspace'
        and pronamespace = 'public'::regnamespace
        and prosrc like '%insert into public.phases (id, user_id, project_id, name, color,%'
    ),
    'without it, a restored backup silently loses phase colours'

  -- Row level security
  union all
  select
    'Every table in public has RLS enabled',
    not exists (select 1 from public_tables where not rls),
    coalesce(
      (select 'no RLS: ' || string_agg(name, ', ') from public_tables where not rls),
      'all enabled'
    )
  union all
  select
    'Each Cairn table has its 4 owner-only policies',
    not exists (
      select 1 from expected_tables as e
      where (
        select count(*) from pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = e.name
          and p.roles = '{authenticated}'
          and p.permissive = 'PERMISSIVE'
          and coalesce(p.qual, p.with_check) like '%auth.uid()%user_id%'
      ) <> 4
    ),
    coalesce((
      select 'wrong: ' || string_agg(e.name, ', ')
      from expected_tables as e
      where (
        select count(*) from pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = e.name
          and p.roles = '{authenticated}'
          and p.permissive = 'PERMISSIVE'
          and coalesce(p.qual, p.with_check) like '%auth.uid()%user_id%'
      ) <> 4
    ), 'select, insert, update, delete on all 6')
  union all
  select
    'No policy outside the owner-only set',
    not exists (
      select 1 from pg_policies as p
      where p.schemaname = 'public'
        and (p.roles <> '{authenticated}' or p.permissive <> 'PERMISSIVE')
    ),
    coalesce((
      select string_agg(p.tablename || '.' || p.policyname, ', ')
      from pg_policies as p
      where p.schemaname = 'public'
        and (p.roles <> '{authenticated}' or p.permissive <> 'PERMISSIVE')
    ), 'none')

  -- Table privileges
  union all
  select
    'anon and PUBLIC have no privilege on any table',
    not exists (
      select 1 from public_tables as t
      where has_table_privilege('anon', t.oid, 'select, insert, update, delete, truncate, references, trigger')
        or exists (
          select 1 from pg_class as c, aclexplode(c.relacl) as acl
          where c.oid = t.oid and acl.grantee = 0
        )
    ),
    coalesce((
      select 'exposed: ' || string_agg(t.name, ', ')
      from public_tables as t
      where has_table_privilege('anon', t.oid, 'select, insert, update, delete, truncate, references, trigger')
        or exists (
          select 1 from pg_class as c, aclexplode(c.relacl) as acl
          where c.oid = t.oid and acl.grantee = 0
        )
    ), 'none')
  union all
  select
    'authenticated has exactly select, insert, update, delete',
    not exists (
      select 1 from expected_tables as e
      join public_tables as t on t.name = e.name
      where not has_table_privilege('authenticated', t.oid, 'select')
        or not has_table_privilege('authenticated', t.oid, 'insert')
        or not has_table_privilege('authenticated', t.oid, 'update')
        or not has_table_privilege('authenticated', t.oid, 'delete')
        or has_table_privilege('authenticated', t.oid, 'truncate, references, trigger')
    ),
    'no truncate, references or trigger'

  -- Functions
  union all
  select
    'No SECURITY DEFINER function in public',
    not exists (select 1 from public_functions where prosecdef),
    coalesce(
      (select string_agg(signature, ', ') from public_functions where prosecdef),
      'none'
    )
  union all
  select
    'Every function pins search_path',
    not exists (
      select 1 from public_functions as f
      where not coalesce(f.proconfig @> array['search_path=""'], false)
        and not coalesce(f.proconfig @> array['search_path='], false)
    ),
    coalesce((
      select string_agg(f.signature, ', ')
      from public_functions as f
      where not coalesce(f.proconfig @> array['search_path=""'], false)
        and not coalesce(f.proconfig @> array['search_path='], false)
    ), 'all pinned')
  union all
  select
    'anon can execute no function',
    not exists (
      select 1 from public_functions as f where has_function_privilege('anon', f.oid, 'execute')
    ),
    coalesce((
      select string_agg(f.signature, ', ')
      from public_functions as f
      where has_function_privilege('anon', f.oid, 'execute')
    ), 'none')
  union all
  select
    'authenticated can execute exactly the 3 RPCs',
    (
      select coalesce(array_agg(f.signature order by f.signature), '{}')
      from public_functions as f
      where has_function_privilege('authenticated', f.oid, 'execute')
    ) = (select array_agg(e.signature order by e.signature) from expected_rpcs as e),
    coalesce((
      select string_agg(f.signature, ', ' order by f.signature)
      from public_functions as f
      where has_function_privilege('authenticated', f.oid, 'execute')
    ), 'none')

  -- Exposure through views
  union all
  select
    'No view in public can bypass RLS',
    not exists (
      select 1 from pg_class as c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('v', 'm')
        and not coalesce(c.reloptions @> array['security_invoker=true'], false)
    ),
    coalesce((
      select string_agg(c.relname, ', ')
      from pg_class as c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('v', 'm')
        and not coalesce(c.reloptions @> array['security_invoker=true'], false)
    ), 'none')

  -- Integrity the app relies on
  union all
  select
    'Composite foreign keys keep rows inside one owner and project',
    (
      select count(*) from pg_constraint
      where connamespace = 'public'::regnamespace
        and contype = 'f'
        and conname in (
          'phases_project_fk', 'tasks_project_fk', 'tasks_phase_fk', 'tasks_parent_fk',
          'milestones_project_fk', 'milestones_phase_fk', 'task_dependencies_project_fk',
          'task_dependencies_predecessor_fk', 'task_dependencies_successor_fk'
        )
        and cardinality(conkey) = 2
    ) = 9,
    '9 two-column foreign keys'
  union all
  select
    'Sort order uses the C collation (same order as the app)',
    (
      select count(*) from pg_attribute as a
      join pg_collation as coll on coll.oid = a.attcollation
      where a.attrelid in (to_regclass('public.projects'), to_regclass('public.phases'), to_regclass('public.tasks'))
        and a.attname = 'sort_order'
        and coll.collname = 'C'
    ) = 3,
    'projects, phases, tasks'
  union all
  select
    'Triggers that enforce the rules are in place',
    (
      select count(*) from pg_trigger
      where tgrelid = to_regclass('public.tasks')
        and not tgisinternal
        and tgname in (
          'trg_10_immutable_columns', 'trg_20_hierarchy', 'trg_30_subtask_phase',
          'trg_40_completed_at', 'trg_50_phase_to_subtasks', 'trg_90_updated_at'
        )
    ) = 6
    and exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('public.task_dependencies')
        and tgname = 'trg_20_dependency_rules'
    ),
    'tasks: 6, task_dependencies: cycle check'
)
select name as check_name, pass, detail
from checks
order by pass, name;
