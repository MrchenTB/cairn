-- Phase colours (UX iteration 2). Incremental: the init migration is already applied wherever the
-- app runs and is never rewritten.
--
-- phases.color: the name of one of the project colour tokens (--project-<name>), or NULL = inherit
-- the project's colour. Existing rows get NULL, so nothing changes visually for existing data.
-- Red is left out on purpose: it is the signal colour for conflicts and overdue work.
-- Applying this is a manual step (`supabase db push`); the app works without it (it only sends
-- `color` for a phase that has one), but choosing a phase colour fails until it is applied.

alter table public.phases add column color text;

alter table public.phases
  add constraint phases_color_valid check (
    color is null
    or color in ('gray', 'blue', 'violet', 'pink', 'orange', 'yellow', 'green', 'teal')
  );

comment on column public.phases.color is
  'Phase colour (a project colour token name, never red) or NULL to inherit the project colour.';

-- Backup import now carries phases.color (backups made before this migration have none → NULL).
-- CREATE OR REPLACE keeps the function's privileges; the body is the init version plus `color`.
create or replace function public.import_workspace(p_data jsonb)
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

  insert into public.phases (id, user_id, project_id, name, color, sort_order)
  select r.id, v_user_id, r.project_id, r.name, r.color, r.sort_order
  from jsonb_to_recordset(v_phases) as r (
    id uuid, project_id uuid, name text, color text, sort_order text
  );
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
