-- =============================================================================
-- Cairn: initial schema
-- Contract: docs/architecture.md §4 (table and column names are used by the data layer).
-- Requires PostgreSQL 15+ (ON DELETE SET NULL (column) on composite foreign keys).
--
-- Security model
--   * Every row carries user_id (default auth.uid()). RLS policies limit every command to the
--     owner: ((select auth.uid()) = user_id).
--   * Composite foreign keys, child (project_id, user_id) -> projects (id, user_id) and
--     child (..., project_id) -> phases/tasks (id, project_id), make cross-user and cross-project
--     references impossible even though foreign key checks themselves bypass RLS.
--   * Foreign key cascades (ON DELETE CASCADE / SET NULL) run as the table owner, so the row
--     triggers they fire see every row WITHOUT RLS. Only the composite keys (plus immutable id,
--     user_id and project_id) keep a cascade inside one user's project: never relax them.
--   * anon and PUBLIC get no privileges; authenticated gets select/insert/update/delete only.
--   * RPCs are SECURITY INVOKER (they run under the caller's RLS), with search_path = ''.
--
-- Errors raised by triggers and RPCs carry readable messages (the UI shows them):
--   23514 check_violation          business rule (hierarchy, dependency, date order, ...)
--   23503 foreign_key_violation    referenced row is missing or belongs to someone else
--   23505 unique_violation         duplicate dependency
--   22023 invalid_parameter_value  malformed RPC payload
--   22007 / 22008                  malformed or impossible date in an RPC payload
--   P0002 no_data_found            RPC target is missing or belongs to someone else
--   42501 insufficient_privilege   ownership change, or RPC called without a signed-in user
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active',
  color text not null default 'gray',
  start_date date,
  due_date date,
  schedule_mode text not null default 'manual',
  sort_order text collate "C" not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_id_user_id_key unique (id, user_id),
  -- 1..200 characters and not blank (the client stores the trimmed value). POSIX classes rather
  -- than backslash escapes keep the patterns independent of standard_conforming_strings.
  constraint projects_name_length check (
    char_length(name) between 1 and 200 and name ~ '[^[:space:]]'
  ),
  constraint projects_description_length check (char_length(description) <= 10000),
  constraint projects_status_check check (status in ('active', 'completed', 'archived')),
  constraint projects_color_check check (
    color in ('gray', 'blue', 'violet', 'pink', 'red', 'orange', 'yellow', 'green', 'teal')
  ),
  constraint projects_schedule_mode_check check (schedule_mode in ('manual', 'auto')),
  constraint projects_sort_order_not_empty check (sort_order <> ''),
  -- Dates must serialise as YYYY-MM-DD (no infinity, BC or 5-digit years).
  constraint projects_dates_range check (
    start_date between '0001-01-01' and '9999-12-31'
    and due_date between '0001-01-01' and '9999-12-31'
  ),
  constraint projects_due_after_start check (due_date >= start_date)
);

create table public.phases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  project_id uuid not null,
  name text not null,
  sort_order text collate "C" not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phases_project_fk foreign key (project_id, user_id)
    references public.projects (id, user_id) on delete cascade,
  constraint phases_id_project_id_key unique (id, project_id),
  constraint phases_name_length check (
    char_length(name) between 1 and 200 and name ~ '[^[:space:]]'
  ),
  constraint phases_sort_order_not_empty check (sort_order <> '')
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  project_id uuid not null,
  phase_id uuid,
  parent_task_id uuid,
  title text not null,
  description text,
  status text not null default 'todo',
  priority text not null default 'none',
  start_date date,
  due_date date,
  sort_order text collate "C" not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_project_fk foreign key (project_id, user_id)
    references public.projects (id, user_id) on delete cascade,
  -- Deleting a phase ungroups its tasks: only phase_id is cleared, project_id stays.
  constraint tasks_phase_fk foreign key (phase_id, project_id)
    references public.phases (id, project_id) on delete set null (phase_id),
  constraint tasks_parent_fk foreign key (parent_task_id, project_id)
    references public.tasks (id, project_id) on delete cascade,
  constraint tasks_id_project_id_key unique (id, project_id),
  constraint tasks_title_length check (
    char_length(title) between 1 and 500 and title ~ '[^[:space:]]'
  ),
  constraint tasks_description_length check (char_length(description) <= 10000),
  constraint tasks_status_check check (status in ('todo', 'in_progress', 'done')),
  constraint tasks_priority_check check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  constraint tasks_sort_order_not_empty check (sort_order <> ''),
  constraint tasks_dates_range check (
    start_date between '0001-01-01' and '9999-12-31'
    and due_date between '0001-01-01' and '9999-12-31'
  ),
  constraint tasks_due_after_start check (due_date >= start_date),
  constraint tasks_parent_not_self check (parent_task_id <> id)
);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  project_id uuid not null,
  phase_id uuid,
  name text not null,
  date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint milestones_project_fk foreign key (project_id, user_id)
    references public.projects (id, user_id) on delete cascade,
  constraint milestones_phase_fk foreign key (phase_id, project_id)
    references public.phases (id, project_id) on delete set null (phase_id),
  constraint milestones_name_length check (
    char_length(name) between 1 and 200 and name ~ '[^[:space:]]'
  ),
  constraint milestones_date_range check (date between '0001-01-01' and '9999-12-31')
);

create table public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  project_id uuid not null,
  predecessor_id uuid not null,
  successor_id uuid not null,
  type text not null default 'FS',
  created_at timestamptz not null default now(),
  constraint task_dependencies_project_fk foreign key (project_id, user_id)
    references public.projects (id, user_id) on delete cascade,
  constraint task_dependencies_predecessor_fk foreign key (predecessor_id, project_id)
    references public.tasks (id, project_id) on delete cascade,
  constraint task_dependencies_successor_fk foreign key (successor_id, project_id)
    references public.tasks (id, project_id) on delete cascade,
  constraint task_dependencies_pair_key unique (predecessor_id, successor_id),
  constraint task_dependencies_not_self check (predecessor_id <> successor_id),
  constraint task_dependencies_type_check check (type = 'FS')
);

create table public.user_preferences (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  theme text not null default 'system',
  sidebar_collapsed boolean not null default false,
  timezone text not null default 'Asia/Taipei',
  week_starts_on smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_preferences_theme_check check (theme in ('system', 'light', 'dark')),
  constraint user_preferences_timezone_length check (char_length(timezone) between 1 and 100),
  constraint user_preferences_week_starts_on_check check (week_starts_on in (0, 1))
);

comment on table public.projects is 'Cairn projects. One row per project, owned by user_id.';
comment on table public.phases is 'Optional grouping of tasks and milestones inside a project.';
comment on table public.tasks is
  'Tasks and (one level of) subtasks. Shared by List, Board and Gantt.';
comment on table public.milestones is 'Single-day markers; never counted in progress.';
comment on table public.task_dependencies is 'Finish-to-start links between tasks of one project.';
comment on table public.user_preferences is
  'One row per user (theme, sidebar, time zone, week start).';

-- -----------------------------------------------------------------------------
-- Indexes: every foreign key (leading columns = FK columns) and every user_id.
-- -----------------------------------------------------------------------------

create index projects_user_id_idx on public.projects (user_id);

create index phases_user_id_idx on public.phases (user_id);
create index phases_project_id_user_id_idx on public.phases (project_id, user_id);

create index tasks_user_id_idx on public.tasks (user_id);
create index tasks_project_id_user_id_idx on public.tasks (project_id, user_id);
create index tasks_phase_id_project_id_idx on public.tasks (phase_id, project_id);
create index tasks_parent_task_id_project_id_idx on public.tasks (parent_task_id, project_id);

create index milestones_user_id_idx on public.milestones (user_id);
create index milestones_project_id_user_id_idx on public.milestones (project_id, user_id);
create index milestones_phase_id_project_id_idx on public.milestones (phase_id, project_id);

create index task_dependencies_user_id_idx on public.task_dependencies (user_id);
create index task_dependencies_project_id_user_id_idx
  on public.task_dependencies (project_id, user_id);
create index task_dependencies_predecessor_id_project_id_idx
  on public.task_dependencies (predecessor_id, project_id);
create index task_dependencies_successor_id_project_id_idx
  on public.task_dependencies (successor_id, project_id);

-- -----------------------------------------------------------------------------
-- Trigger functions (SECURITY INVOKER: lookups run under the caller's RLS)
-- -----------------------------------------------------------------------------

-- Maintains updated_at; created_at never changes.
create function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.created_at := old.created_at;
  return new;
end;
$$;

-- Rejects changes to the columns named in the trigger arguments (ids, owner, project).
create function public.tg_immutable_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_column text;
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  foreach v_column in array tg_argv loop
    if v_new -> v_column is distinct from v_old -> v_column then
      if v_column = 'user_id' then
        raise exception 'Rows cannot be moved to another account'
          using errcode = '42501';
      elsif v_column = 'project_id' then
        raise exception 'Moving items to another project is not supported'
          using errcode = '23514';
      else
        raise exception 'The % of a row cannot be changed', v_column
          using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

-- Hierarchy: one level of subtasks, same project, and no dependency between a task and its parent.
-- Locks, always in this order (row first, so a parent update that is itself waiting for the
-- advisory lock cannot deadlock with us):
--   1. FOR SHARE on the parent row. A concurrent change of the parent (its phase, its own parent)
--      waits for this transaction, and this transaction waits for such a change to commit. So
--      tg_tasks_subtask_phase reads the parent's final phase, and the parent's AFTER trigger
--      (tg_tasks_phase_to_subtasks) sees this subtask. Without it, a subtask added or moved while
--      its parent changes phase keeps the old phase for good.
--   2. The per-project advisory lock shared with tg_task_dependencies_rules, so concurrent
--      hierarchy and dependency changes in one project are serialised (each check then sees the
--      other's commit under READ COMMITTED, the PostgREST default). Taken only after the parent
--      proved to be a row of new.project_id that the caller can see.
create function public.tg_tasks_hierarchy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_project_id uuid;
  v_parent_parent_id uuid;
begin
  if new.parent_task_id is null
    or (tg_op = 'UPDATE' and new.parent_task_id is not distinct from old.parent_task_id) then
    return new;
  end if;

  if new.parent_task_id = new.id then
    raise exception 'A task cannot be its own parent' using errcode = '23514';
  end if;

  -- The share lock also keeps the parent's own parent_task_id stable until we commit.
  select t.project_id, t.parent_task_id
    into v_parent_project_id, v_parent_parent_id
  from public.tasks as t
  where t.id = new.parent_task_id
  for share;

  if not found then
    raise exception 'Parent task not found' using errcode = '23503';
  end if;
  if v_parent_project_id <> new.project_id then
    raise exception 'A subtask must be in the same project as its parent'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cairn.task_graph:' || new.project_id::text, 0));

  if v_parent_parent_id is not null then
    raise exception 'Subtasks can only be one level deep' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if exists (select 1 from public.tasks as t where t.parent_task_id = new.id) then
      raise exception 'A task that has subtasks cannot become a subtask'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.task_dependencies as d
      where (d.predecessor_id = new.id and d.successor_id = new.parent_task_id)
         or (d.predecessor_id = new.parent_task_id and d.successor_id = new.id)
    ) then
      raise exception 'A task cannot depend on its own parent. Remove that dependency first.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- A subtask always carries its parent's phase. When a task gets a parent (insert or move),
-- tg_tasks_hierarchy (which fires first) has already share-locked that parent, so the phase read
-- here is final.
create function public.tg_tasks_subtask_phase()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_phase_id uuid;
begin
  if new.parent_task_id is not null then
    select t.phase_id into v_phase_id from public.tasks as t where t.id = new.parent_task_id;
    if found then
      new.phase_id := v_phase_id;
    end if;
  end if;
  return new;
end;
$$;

-- When a parent's phase changes (including ON DELETE SET NULL of its phase), subtasks follow.
create function public.tg_tasks_phase_to_subtasks()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.tasks as t
  set phase_id = new.phase_id
  where t.parent_task_id = new.id
    and t.phase_id is distinct from new.phase_id;
  return null;
end;
$$;

-- completed_at: set when status becomes 'done', cleared when it leaves 'done'. An insert may
-- carry an existing completion time (backup import); otherwise the server time is used.
create function public.tg_tasks_completed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'done' then
    new.completed_at := null;
  elsif tg_op = 'INSERT' then
    new.completed_at := coalesce(new.completed_at, now());
  elsif old.status <> 'done' then
    new.completed_at := now();
  else
    new.completed_at := coalesce(old.completed_at, now());
  end if;
  return new;
end;
$$;

-- Dependency rules: same project, not between a task and its own parent/subtask, no duplicate,
-- no cycle. The per-project advisory lock serialises concurrent graph changes (see above).
create function public.tg_task_dependencies_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pred_project_id uuid;
  v_pred_parent_id uuid;
  v_succ_project_id uuid;
  v_succ_parent_id uuid;
begin
  if new.predecessor_id = new.successor_id then
    raise exception 'A task cannot depend on itself' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cairn.task_graph:' || new.project_id::text, 0));

  select t.project_id, t.parent_task_id
    into v_pred_project_id, v_pred_parent_id
  from public.tasks as t
  where t.id = new.predecessor_id;
  if not found then
    raise exception 'Predecessor task not found' using errcode = '23503';
  end if;

  select t.project_id, t.parent_task_id
    into v_succ_project_id, v_succ_parent_id
  from public.tasks as t
  where t.id = new.successor_id;
  if not found then
    raise exception 'Successor task not found' using errcode = '23503';
  end if;

  if v_pred_project_id <> new.project_id or v_succ_project_id <> new.project_id then
    raise exception 'Dependencies can only link tasks in the same project'
      using errcode = '23514';
  end if;

  if v_pred_parent_id = new.successor_id or v_succ_parent_id = new.predecessor_id then
    raise exception 'A task cannot depend on its own parent or subtask' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.task_dependencies as d
    where d.predecessor_id = new.predecessor_id
      and d.successor_id = new.successor_id
      and d.id is distinct from new.id
  ) then
    raise exception 'This dependency already exists' using errcode = '23505';
  end if;

  -- The new edge closes a cycle iff the predecessor is already reachable from the successor.
  if exists (
    with recursive downstream (task_id) as (
      select d.successor_id
      from public.task_dependencies as d
      where d.predecessor_id = new.successor_id
        and d.id is distinct from new.id
      union
      select d.successor_id
      from public.task_dependencies as d
      join downstream as s on d.predecessor_id = s.task_id
      where d.id is distinct from new.id
    )
    select 1 from downstream where task_id = new.predecessor_id
  ) then
    raise exception 'This dependency would create a cycle' using errcode = '23514';
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Triggers (same-timing triggers fire in name order, hence the numeric prefixes)
-- -----------------------------------------------------------------------------

create trigger trg_10_immutable_columns
  before update on public.projects
  for each row execute function public.tg_immutable_columns('id', 'user_id');
create trigger trg_90_updated_at
  before update on public.projects
  for each row execute function public.tg_set_updated_at();

create trigger trg_10_immutable_columns
  before update on public.phases
  for each row execute function public.tg_immutable_columns('id', 'user_id', 'project_id');
create trigger trg_90_updated_at
  before update on public.phases
  for each row execute function public.tg_set_updated_at();

create trigger trg_10_immutable_columns
  before update on public.tasks
  for each row execute function public.tg_immutable_columns('id', 'user_id', 'project_id');
create trigger trg_20_hierarchy
  before insert or update of parent_task_id on public.tasks
  for each row execute function public.tg_tasks_hierarchy();
create trigger trg_30_subtask_phase
  before insert or update of parent_task_id, phase_id on public.tasks
  for each row execute function public.tg_tasks_subtask_phase();
create trigger trg_40_completed_at
  before insert or update of status, completed_at on public.tasks
  for each row execute function public.tg_tasks_completed_at();
create trigger trg_50_phase_to_subtasks
  after update of phase_id on public.tasks
  for each row
  when (new.parent_task_id is null and old.phase_id is distinct from new.phase_id)
  execute function public.tg_tasks_phase_to_subtasks();
create trigger trg_90_updated_at
  before update on public.tasks
  for each row execute function public.tg_set_updated_at();

create trigger trg_10_immutable_columns
  before update on public.milestones
  for each row execute function public.tg_immutable_columns('id', 'user_id', 'project_id');
create trigger trg_90_updated_at
  before update on public.milestones
  for each row execute function public.tg_set_updated_at();

create trigger trg_10_immutable_columns
  before update on public.task_dependencies
  for each row execute function public.tg_immutable_columns('id', 'user_id', 'project_id');
create trigger trg_20_dependency_rules
  before insert or update of predecessor_id, successor_id on public.task_dependencies
  for each row execute function public.tg_task_dependencies_rules();

create trigger trg_10_immutable_columns
  before update on public.user_preferences
  for each row execute function public.tg_immutable_columns('user_id');
create trigger trg_90_updated_at
  before update on public.user_preferences
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Row level security: owner-only access for every command
-- -----------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.phases enable row level security;
alter table public.tasks enable row level security;
alter table public.milestones enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.user_preferences enable row level security;

create policy projects_select_own on public.projects
  for select to authenticated using ((select auth.uid()) = user_id);
create policy projects_insert_own on public.projects
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy projects_update_own on public.projects
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy projects_delete_own on public.projects
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy phases_select_own on public.phases
  for select to authenticated using ((select auth.uid()) = user_id);
create policy phases_insert_own on public.phases
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy phases_update_own on public.phases
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy phases_delete_own on public.phases
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy tasks_select_own on public.tasks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy tasks_insert_own on public.tasks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy tasks_update_own on public.tasks
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy tasks_delete_own on public.tasks
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy milestones_select_own on public.milestones
  for select to authenticated using ((select auth.uid()) = user_id);
create policy milestones_insert_own on public.milestones
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy milestones_update_own on public.milestones
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy milestones_delete_own on public.milestones
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy task_dependencies_select_own on public.task_dependencies
  for select to authenticated using ((select auth.uid()) = user_id);
create policy task_dependencies_insert_own on public.task_dependencies
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy task_dependencies_update_own on public.task_dependencies
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy task_dependencies_delete_own on public.task_dependencies
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy user_preferences_select_own on public.user_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_preferences_insert_own on public.user_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_preferences_update_own on public.user_preferences
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy user_preferences_delete_own on public.user_preferences
  for delete to authenticated using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- RPC functions (SECURITY INVOKER, search_path = '', all-or-nothing)
-- -----------------------------------------------------------------------------

-- Atomic multi-task date update: p_changes = [{"id","start_date","due_date"}], dates are
-- 'YYYY-MM-DD' or null (all three keys required). Raises, changing nothing, if any entry is
-- malformed, has due < start, repeats a task, or names a task that is missing or not the caller's.
create function public.apply_task_schedule(p_changes jsonb)
returns setof public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_change jsonb;
  v_id uuid;
  v_start date;
  v_due date;
  v_ids uuid[] := '{}';
  v_starts date[] := '{}';
  v_dues date[] := '{}';
  v_updated integer;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'Schedule changes must be a JSON array' using errcode = '22023';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_change) <> 'object'
      or not (v_change ? 'id' and v_change ? 'start_date' and v_change ? 'due_date') then
      raise exception 'Each schedule change needs "id", "start_date" and "due_date"'
        using errcode = '22023';
    end if;
    if (v_change ->> 'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_change ->> 'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Dates must use the YYYY-MM-DD format' using errcode = '22007';
    end if;

    begin
      v_id := (v_change ->> 'id')::uuid;
      v_start := (v_change ->> 'start_date')::date;
      v_due := (v_change ->> 'due_date')::date;
    exception
      when invalid_text_representation then
        raise exception 'Invalid task id: %', v_change ->> 'id' using errcode = '22023';
      when datetime_field_overflow or invalid_datetime_format then
        raise exception 'Invalid date in the schedule change for task %', v_change ->> 'id'
          using errcode = '22008';
    end;

    if v_id is null then
      raise exception 'Each schedule change needs a task id' using errcode = '22023';
    end if;
    if v_due < v_start then
      raise exception 'Due date cannot be before start date' using errcode = '23514';
    end if;
    if v_id = any (v_ids) then
      raise exception 'A task appears more than once in the schedule changes'
        using errcode = '22023';
    end if;

    v_ids := array_append(v_ids, v_id);
    v_starts := array_append(v_starts, v_start);
    v_dues := array_append(v_dues, v_due);
  end loop;

  if cardinality(v_ids) = 0 then
    return;
  end if;

  return query
    update public.tasks as t
    set start_date = c.start_date, due_date = c.due_date
    from unnest(v_ids, v_starts, v_dues) as c (id, start_date, due_date)
    where t.id = c.id
    returning t.*;

  -- RLS hides other users' rows, so a short count means missing or not owned: undo everything.
  get diagnostics v_updated = row_count;
  if v_updated <> cardinality(v_ids) then
    raise exception 'Some tasks could not be found. Refresh and try again.'
      using errcode = 'P0002';
  end if;
end;
$$;

-- Atomic task delete. p_keep_subtasks = false: the task and its subtasks (and their
-- dependencies) are deleted. p_keep_subtasks = true: p_promoted = [{"id","sort_order"}] must list
-- exactly the task's current subtasks; each becomes top-level with that sort_order (keeping its
-- phase), then the task is deleted.
create function public.delete_task(
  p_task_id uuid,
  p_keep_subtasks boolean default false,
  p_promoted jsonb default '[]'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_id uuid;
  v_promoted_ids uuid[] := '{}';
  v_sort_orders text[] := '{}';
  v_subtask_ids uuid[];
begin
  if p_task_id is null then
    raise exception 'A task id is required' using errcode = '22023';
  end if;

  perform 1 from public.tasks as t where t.id = p_task_id for update;
  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;

  if coalesce(p_keep_subtasks, false) then
    if p_promoted is null or jsonb_typeof(p_promoted) <> 'array' then
      raise exception 'Promoted subtasks must be a JSON array' using errcode = '22023';
    end if;

    for v_item in select value from jsonb_array_elements(p_promoted) loop
      if jsonb_typeof(v_item) <> 'object'
        or jsonb_typeof(v_item -> 'sort_order') is distinct from 'string' then
        raise exception 'Each promoted subtask needs "id" and "sort_order"'
          using errcode = '22023';
      end if;
      begin
        v_id := (v_item ->> 'id')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'Invalid subtask id: %', v_item ->> 'id' using errcode = '22023';
      end;
      if v_id is null then
        raise exception 'Each promoted subtask needs "id" and "sort_order"'
          using errcode = '22023';
      end if;
      if v_id = any (v_promoted_ids) then
        raise exception 'A subtask appears more than once in the promotion list'
          using errcode = '22023';
      end if;
      v_promoted_ids := array_append(v_promoted_ids, v_id);
      v_sort_orders := array_append(v_sort_orders, v_item ->> 'sort_order');
    end loop;

    select coalesce(array_agg(t.id), '{}')
      into v_subtask_ids
    from public.tasks as t
    where t.parent_task_id = p_task_id;

    if not (v_subtask_ids @> v_promoted_ids and v_promoted_ids @> v_subtask_ids) then
      raise exception '%', 'The subtasks to keep do not match the task''s current subtasks. '
        || 'Refresh and try again.'
        using errcode = '22023';
    end if;

    update public.tasks as t
    set parent_task_id = null, sort_order = p.sort_order
    from unnest(v_promoted_ids, v_sort_orders) as p (id, sort_order)
    where t.id = p.id;
  end if;

  delete from public.tasks as t where t.id = p_task_id;
end;
$$;

-- Atomic import of an id-remapped backup as NEW rows owned by the caller. p_data =
-- {"projects","phases","tasks","milestones","dependencies"}: arrays of snake_case rows. user_id in
-- the payload is ignored (always auth.uid()); timestamps are fresh except tasks.completed_at.
-- The payload must be self-contained (rows only reference rows of the same payload), so an import
-- never attaches data to existing projects. Any invalid row aborts the whole import.
-- Returns {"projects":n,"phases":n,"tasks":n,"milestones":n,"dependencies":n}.
create function public.import_workspace(p_data jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_projects jsonb;
  v_phases jsonb;
  v_tasks jsonb;
  v_milestones jsonb;
  v_dependencies jsonb;
  v_project_ids uuid[];
  v_phase_ids uuid[];
  v_task_ids uuid[];
  v_count_projects integer;
  v_count_phases integer;
  v_count_tasks integer;
  v_count_subtasks integer;
  v_count_milestones integer;
  v_count_dependencies integer;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to import data' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Import data must be a JSON object' using errcode = '22023';
  end if;

  v_projects := coalesce(nullif(p_data -> 'projects', 'null'::jsonb), '[]'::jsonb);
  v_phases := coalesce(nullif(p_data -> 'phases', 'null'::jsonb), '[]'::jsonb);
  v_tasks := coalesce(nullif(p_data -> 'tasks', 'null'::jsonb), '[]'::jsonb);
  v_milestones := coalesce(nullif(p_data -> 'milestones', 'null'::jsonb), '[]'::jsonb);
  v_dependencies := coalesce(nullif(p_data -> 'dependencies', 'null'::jsonb), '[]'::jsonb);

  if jsonb_typeof(v_projects) <> 'array'
    or jsonb_typeof(v_phases) <> 'array'
    or jsonb_typeof(v_tasks) <> 'array'
    or jsonb_typeof(v_milestones) <> 'array'
    or jsonb_typeof(v_dependencies) <> 'array' then
    raise exception '%', 'Import data must contain arrays of projects, phases, tasks, '
      || 'milestones and dependencies'
      using errcode = '22023';
  end if;

  -- Ids come from the client (already remapped). They must all be present: the containment check
  -- below needs NULL-free id lists, since `x = any (ids)` is NULL rather than false once `ids`
  -- holds a NULL, which would wave every row of that section through.
  if exists (select 1 from jsonb_to_recordset(v_projects) as r (id uuid) where r.id is null)
    or exists (select 1 from jsonb_to_recordset(v_phases) as r (id uuid) where r.id is null)
    or exists (select 1 from jsonb_to_recordset(v_tasks) as r (id uuid) where r.id is null)
    or exists (select 1 from jsonb_to_recordset(v_milestones) as r (id uuid) where r.id is null)
    or exists (select 1 from jsonb_to_recordset(v_dependencies) as r (id uuid) where r.id is null)
  then
    raise exception 'Every imported row needs an id' using errcode = '22023';
  end if;

  select coalesce(array_agg(r.id), '{}') into v_project_ids
  from jsonb_to_recordset(v_projects) as r (id uuid);
  select coalesce(array_agg(r.id), '{}') into v_phase_ids
  from jsonb_to_recordset(v_phases) as r (id uuid);
  select coalesce(array_agg(r.id), '{}') into v_task_ids
  from jsonb_to_recordset(v_tasks) as r (id uuid);

  if exists (
      select 1 from jsonb_to_recordset(v_phases) as r (project_id uuid)
      where not (r.project_id = any (v_project_ids)))
    or exists (
      select 1
      from jsonb_to_recordset(v_tasks) as r (project_id uuid, phase_id uuid, parent_task_id uuid)
      where not (r.project_id = any (v_project_ids))
        or (r.phase_id is not null and not (r.phase_id = any (v_phase_ids)))
        or (r.parent_task_id is not null and not (r.parent_task_id = any (v_task_ids))))
    or exists (
      select 1 from jsonb_to_recordset(v_milestones) as r (project_id uuid, phase_id uuid)
      where not (r.project_id = any (v_project_ids))
        or (r.phase_id is not null and not (r.phase_id = any (v_phase_ids))))
    or exists (
      select 1
      from jsonb_to_recordset(v_dependencies)
        as r (project_id uuid, predecessor_id uuid, successor_id uuid)
      where not (r.project_id = any (v_project_ids))
        or not (r.predecessor_id = any (v_task_ids))
        or not (r.successor_id = any (v_task_ids)))
  then
    raise exception 'Import data references rows that are not part of the import'
      using errcode = '23503';
  end if;

  insert into public.projects (
    id, user_id, name, description, status, color, start_date, due_date, schedule_mode, sort_order
  )
  select
    r.id, v_user_id, r.name, r.description, coalesce(r.status, 'active'),
    coalesce(r.color, 'gray'), r.start_date, r.due_date, coalesce(r.schedule_mode, 'manual'),
    r.sort_order
  from jsonb_to_recordset(v_projects) as r (
    id uuid, name text, description text, status text, color text, start_date date,
    due_date date, schedule_mode text, sort_order text
  );
  get diagnostics v_count_projects = row_count;

  insert into public.phases (id, user_id, project_id, name, sort_order)
  select r.id, v_user_id, r.project_id, r.name, r.sort_order
  from jsonb_to_recordset(v_phases) as r (id uuid, project_id uuid, name text, sort_order text);
  get diagnostics v_count_phases = row_count;

  -- Parents first: the hierarchy trigger looks the parent up when a subtask is inserted.
  insert into public.tasks (
    id, user_id, project_id, phase_id, parent_task_id, title, description, status, priority,
    start_date, due_date, sort_order, completed_at
  )
  select
    r.id, v_user_id, r.project_id, r.phase_id, null, r.title, r.description,
    coalesce(r.status, 'todo'), coalesce(r.priority, 'none'), r.start_date, r.due_date,
    r.sort_order, r.completed_at
  from jsonb_to_recordset(v_tasks) as r (
    id uuid, project_id uuid, phase_id uuid, parent_task_id uuid, title text, description text,
    status text, priority text, start_date date, due_date date, sort_order text,
    completed_at timestamptz
  )
  where r.parent_task_id is null;
  get diagnostics v_count_tasks = row_count;

  insert into public.tasks (
    id, user_id, project_id, phase_id, parent_task_id, title, description, status, priority,
    start_date, due_date, sort_order, completed_at
  )
  select
    r.id, v_user_id, r.project_id, r.phase_id, r.parent_task_id, r.title, r.description,
    coalesce(r.status, 'todo'), coalesce(r.priority, 'none'), r.start_date, r.due_date,
    r.sort_order, r.completed_at
  from jsonb_to_recordset(v_tasks) as r (
    id uuid, project_id uuid, phase_id uuid, parent_task_id uuid, title text, description text,
    status text, priority text, start_date date, due_date date, sort_order text,
    completed_at timestamptz
  )
  where r.parent_task_id is not null;
  get diagnostics v_count_subtasks = row_count;

  insert into public.milestones (id, user_id, project_id, phase_id, name, date)
  select r.id, v_user_id, r.project_id, r.phase_id, r.name, r.date
  from jsonb_to_recordset(v_milestones) as r (
    id uuid, project_id uuid, phase_id uuid, name text, date date
  );
  get diagnostics v_count_milestones = row_count;

  insert into public.task_dependencies (id, user_id, project_id, predecessor_id, successor_id, type)
  select
    r.id, v_user_id, r.project_id, r.predecessor_id, r.successor_id, coalesce(r.type, 'FS')
  from jsonb_to_recordset(v_dependencies) as r (
    id uuid, project_id uuid, predecessor_id uuid, successor_id uuid, type text
  );
  get diagnostics v_count_dependencies = row_count;

  return jsonb_build_object(
    'projects', v_count_projects,
    'phases', v_count_phases,
    'tasks', v_count_tasks + v_count_subtasks,
    'milestones', v_count_milestones,
    'dependencies', v_count_dependencies
  );
end;
$$;

comment on function public.apply_task_schedule(jsonb) is
  'Atomically sets start_date/due_date of several tasks: [{"id","start_date","due_date"}].';
comment on function public.delete_task(uuid, boolean, jsonb) is
  'Atomically deletes a task; optionally promotes its subtasks ([{"id","sort_order"}]) first.';
comment on function public.import_workspace(jsonb) is
  'Atomically imports an id-remapped backup as new rows owned by the caller; returns counts.';

-- -----------------------------------------------------------------------------
-- Privileges: nothing for anon/PUBLIC; CRUD (no TRUNCATE/REFERENCES/TRIGGER) for authenticated.
-- Explicit either way: hosted projects stopped auto-granting new public tables to the API roles
-- (2026-10-30), the local CLI stack may still grant ALL to anon/authenticated, and PostgreSQL
-- always grants EXECUTE on new functions to PUBLIC.
-- -----------------------------------------------------------------------------

revoke all on table
  public.projects,
  public.phases,
  public.tasks,
  public.milestones,
  public.task_dependencies,
  public.user_preferences
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.projects,
  public.phases,
  public.tasks,
  public.milestones,
  public.task_dependencies,
  public.user_preferences
to authenticated;

-- Trigger functions are never called directly (triggers fire without EXECUTE privilege).
revoke all on function
  public.tg_set_updated_at(),
  public.tg_immutable_columns(),
  public.tg_tasks_hierarchy(),
  public.tg_tasks_subtask_phase(),
  public.tg_tasks_phase_to_subtasks(),
  public.tg_tasks_completed_at(),
  public.tg_task_dependencies_rules()
from public, anon, authenticated;

revoke all on function
  public.apply_task_schedule(jsonb),
  public.delete_task(uuid, boolean, jsonb),
  public.import_workspace(jsonb)
from public, anon;

grant execute on function
  public.apply_task_schedule(jsonb),
  public.delete_task(uuid, boolean, jsonb),
  public.import_workspace(jsonb)
to authenticated;
