import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RPC_SIGNATURES, TABLES } from './fixtures.ts'
import { createTestDb, readMigrations, type TestDb } from './harness.ts'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.close()
})

/** Column contract used by the Supabase repository mappers: [name, type, nullable]. */
const COLUMNS: Record<string, [string, string, boolean][]> = {
  projects: [
    ['id', 'uuid', false],
    ['user_id', 'uuid', false],
    ['name', 'text', false],
    ['description', 'text', true],
    ['status', 'text', false],
    ['color', 'text', false],
    ['start_date', 'date', true],
    ['due_date', 'date', true],
    ['schedule_mode', 'text', false],
    ['sort_order', 'text', false],
    ['created_at', 'timestamp with time zone', false],
    ['updated_at', 'timestamp with time zone', false],
  ],
  phases: [
    ['id', 'uuid', false],
    ['user_id', 'uuid', false],
    ['project_id', 'uuid', false],
    ['name', 'text', false],
    ['sort_order', 'text', false],
    ['created_at', 'timestamp with time zone', false],
    ['updated_at', 'timestamp with time zone', false],
    // Added by 20261106000000_phase_color.sql (appended, so it comes last).
    ['color', 'text', true],
  ],
  tasks: [
    ['id', 'uuid', false],
    ['user_id', 'uuid', false],
    ['project_id', 'uuid', false],
    ['phase_id', 'uuid', true],
    ['parent_task_id', 'uuid', true],
    ['title', 'text', false],
    ['description', 'text', true],
    ['status', 'text', false],
    ['priority', 'text', false],
    ['start_date', 'date', true],
    ['due_date', 'date', true],
    ['sort_order', 'text', false],
    ['completed_at', 'timestamp with time zone', true],
    ['created_at', 'timestamp with time zone', false],
    ['updated_at', 'timestamp with time zone', false],
  ],
  milestones: [
    ['id', 'uuid', false],
    ['user_id', 'uuid', false],
    ['project_id', 'uuid', false],
    ['phase_id', 'uuid', true],
    ['name', 'text', false],
    ['date', 'date', false],
    ['created_at', 'timestamp with time zone', false],
    ['updated_at', 'timestamp with time zone', false],
  ],
  task_dependencies: [
    ['id', 'uuid', false],
    ['user_id', 'uuid', false],
    ['project_id', 'uuid', false],
    ['predecessor_id', 'uuid', false],
    ['successor_id', 'uuid', false],
    ['type', 'text', false],
    ['created_at', 'timestamp with time zone', false],
  ],
  user_preferences: [
    ['user_id', 'uuid', false],
    ['theme', 'text', false],
    ['sidebar_collapsed', 'boolean', false],
    ['timezone', 'text', false],
    ['week_starts_on', 'smallint', false],
    ['created_at', 'timestamp with time zone', false],
    ['updated_at', 'timestamp with time zone', false],
  ],
}

describe('tables and columns', () => {
  it.each(TABLES)('%s has exactly the contracted columns', async (table) => {
    const { rows } = await db.admin.query<{
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `select column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = 'public' and table_name = $1
       order by ordinal_position`,
      [table],
    )
    expect(rows.map((row) => [row.column_name, row.data_type, row.is_nullable === 'YES'])).toEqual(
      COLUMNS[table],
    )
  })

  it.each(TABLES)('%s.user_id defaults to auth.uid()', async (table) => {
    const { rows } = await db.admin.query<{ column_default: string }>(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = 'user_id'`,
      [table],
    )
    expect(rows[0].column_default).toBe('auth.uid()')
  })

  it('stores every sort_order with the "C" collation (code-unit order, like the client)', async () => {
    const { rows } = await db.admin.query<{ table_name: string; collation: string }>(`
      select c.relname as table_name, co.collname as collation
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_collation co on co.oid = a.attcollation
      where c.relnamespace = 'public'::regnamespace and a.attname = 'sort_order'
      order by 1
    `)
    expect(rows).toEqual([
      { table_name: 'phases', collation: 'C' },
      { table_name: 'projects', collation: 'C' },
      { table_name: 'tasks', collation: 'C' },
    ])
    // Byte order: upper case before lower case, unlike most linguistic collations.
    const ordered = await db.admin.query<{ k: string }>(
      `select k from (values ('a0'), ('Zz'), ('a0V'), ('A1')) as v (k) order by k collate "C"`,
    )
    expect(ordered.rows.map((row) => row.k)).toEqual(['A1', 'Zz', 'a0', 'a0V'])
  })

  it('declares the composite keys and foreign keys of the contract', async () => {
    const { rows } = await db.admin.query<{ name: string; definition: string }>(`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where connamespace = 'public'::regnamespace and contype in ('f', 'u')
      order by conname
    `)
    expect(Object.fromEntries(rows.map((row) => [row.name, row.definition]))).toEqual({
      milestones_phase_fk:
        'FOREIGN KEY (phase_id, project_id) REFERENCES phases(id, project_id) ON DELETE SET NULL (phase_id)',
      milestones_project_fk:
        'FOREIGN KEY (project_id, user_id) REFERENCES projects(id, user_id) ON DELETE CASCADE',
      phases_id_project_id_key: 'UNIQUE (id, project_id)',
      phases_project_fk:
        'FOREIGN KEY (project_id, user_id) REFERENCES projects(id, user_id) ON DELETE CASCADE',
      projects_id_user_id_key: 'UNIQUE (id, user_id)',
      projects_user_id_fkey: 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
      task_dependencies_pair_key: 'UNIQUE (predecessor_id, successor_id)',
      task_dependencies_predecessor_fk:
        'FOREIGN KEY (predecessor_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE',
      task_dependencies_project_fk:
        'FOREIGN KEY (project_id, user_id) REFERENCES projects(id, user_id) ON DELETE CASCADE',
      task_dependencies_successor_fk:
        'FOREIGN KEY (successor_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE',
      tasks_id_project_id_key: 'UNIQUE (id, project_id)',
      tasks_parent_fk:
        'FOREIGN KEY (parent_task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE CASCADE',
      tasks_phase_fk:
        'FOREIGN KEY (phase_id, project_id) REFERENCES phases(id, project_id) ON DELETE SET NULL (phase_id)',
      tasks_project_fk:
        'FOREIGN KEY (project_id, user_id) REFERENCES projects(id, user_id) ON DELETE CASCADE',
      user_preferences_user_id_fkey:
        'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    })
  })
})

describe('indexes', () => {
  it('covers every foreign key with an index on exactly its leading columns', async () => {
    const { rows } = await db.admin.query<{ constraint_name: string }>(`
      select con.conname as constraint_name
      from pg_constraint con
      where con.connamespace = 'public'::regnamespace
        and con.contype = 'f'
        and not exists (
          select 1 from pg_index i
          where i.indrelid = con.conrelid
            and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] = con.conkey
        )
    `)
    expect(rows).toEqual([])
  })

  it.each(TABLES)('%s has an index leading with user_id', async (table) => {
    const { rows } = await db.admin.query<{ index_name: string }>(
      `select i.indexrelid::regclass::text as index_name
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = ('public.' || $1)::regclass and a.attname = 'user_id'`,
      [table],
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('row level security', () => {
  it.each(TABLES)(
    '%s has RLS enabled (not forced, so the owner/dashboard still work)',
    async (table) => {
      const { rows } = await db.admin.query<{ enabled: boolean; forced: boolean }>(
        `select relrowsecurity as enabled, relforcerowsecurity as forced
       from pg_class where oid = ('public.' || $1)::regclass`,
        [table],
      )
      expect(rows[0]).toEqual({ enabled: true, forced: false })
    },
  )

  it.each(TABLES)(
    '%s has one owner-only policy per command, for authenticated only',
    async (table) => {
      const { rows } = await db.admin.query<{
        cmd: string
        roles: string[]
        permissive: string
        qual: string | null
        with_check: string | null
      }>(
        `select cmd, roles, permissive, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = $1
       order by cmd`,
        [table],
      )
      const ownerOnly = '(( SELECT auth.uid() AS uid) = user_id)'
      expect(rows).toEqual([
        {
          cmd: 'DELETE',
          roles: ['authenticated'],
          permissive: 'PERMISSIVE',
          qual: ownerOnly,
          with_check: null,
        },
        {
          cmd: 'INSERT',
          roles: ['authenticated'],
          permissive: 'PERMISSIVE',
          qual: null,
          with_check: ownerOnly,
        },
        {
          cmd: 'SELECT',
          roles: ['authenticated'],
          permissive: 'PERMISSIVE',
          qual: ownerOnly,
          with_check: null,
        },
        {
          cmd: 'UPDATE',
          roles: ['authenticated'],
          permissive: 'PERMISSIVE',
          qual: ownerOnly,
          with_check: ownerOnly,
        },
      ])
    },
  )
})

describe('privileges', () => {
  it.each(TABLES)(
    '%s: anon and PUBLIC have nothing, authenticated has CRUD only',
    async (table) => {
      const { rows } = await db.admin.query<{ grantee: string; privileges: string[] }>(
        `select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
              array_agg(a.privilege_type order by a.privilege_type) as privileges
       from pg_class c, aclexplode(c.relacl) a
       where c.oid = ('public.' || $1)::regclass
       group by 1`,
        [table],
      )
      const grants = Object.fromEntries(rows.map((row) => [row.grantee, row.privileges]))
      expect(grants.anon).toBeUndefined()
      expect(grants.PUBLIC).toBeUndefined()
      expect(grants.authenticated).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    },
  )

  it('exposes exactly the three RPCs to authenticated, none to anon or PUBLIC', async () => {
    const { rows } = await db.admin.query<{
      signature: string
      anon: boolean
      authenticated: boolean
      public_grant: boolean
    }>(`
      select p.oid::regprocedure::text as signature,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             exists (
               select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where a.grantee = 0
             ) as public_grant
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
      order by 1
    `)
    expect(rows.filter((row) => row.anon || row.public_grant)).toEqual([])
    expect(rows.filter((row) => row.authenticated).map((row) => row.signature)).toEqual([
      ...RPC_SIGNATURES,
    ])
  })

  it('leaves nothing in public open to anon/PUBLIC, unprotected by RLS or bypassing it', async () => {
    // Guards future migrations too: a new table without RLS, a column-level grant, a view
    // (views run with their owner's rights unless security_invoker) or a sequence.
    const { rows } = await db.admin.query<{ name: string; problem: string }>(`
      select c.relname as name, r.role || ' has privileges' as problem
      from pg_class c
      cross join (values ('anon'), ('public')) as r (role)
      where c.relnamespace = 'public'::regnamespace
        and case
          when c.relkind = 'S' then has_sequence_privilege(r.role, c.oid, 'usage, select, update')
          when c.relkind in ('r', 'p', 'v', 'm', 'f') then
            has_table_privilege(
              r.role, c.oid, 'select, insert, update, delete, truncate, references, trigger'
            ) or has_any_column_privilege(r.role, c.oid, 'select, insert, update, references')
          else false
        end
      union all
      select c.relname, 'RLS disabled'
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and not c.relrowsecurity
      union all
      select c.relname, 'view without security_invoker'
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
        and not coalesce(
          'security_invoker=true' = any (c.reloptions) or 'security_invoker=on' = any (c.reloptions),
          false
        )
      union all
      select c.relname, 'materialized view readable by authenticated'
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'm'
        and has_table_privilege('authenticated', c.oid, 'select')
    `)
    expect(rows).toEqual([])
  })

  it('makes every function SECURITY INVOKER with an empty search_path', async () => {
    const { rows } = await db.admin.query<{
      name: string
      security_definer: boolean
      config: string[] | null
    }>(`
      select proname as name, prosecdef as security_definer, proconfig as config
      from pg_proc where pronamespace = 'public'::regnamespace
    `)
    expect(rows.length).toBe(10)
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ security_definer: false, config: ['search_path=""'] })
    }
  })
})

describe('portability', () => {
  it('avoids syntax newer than PostgreSQL 15 (PGlite runs 18; Supabase may run 15 or 17)', async () => {
    const newerThan15 = [
      /\buuidv7\s*\(/i, // PG 18
      /\bvirtual\b/i, // PG 18 virtual generated columns
      /\breturning\s+(old|new)\b/i, // PG 18
      /\bjson_table\b|\bjson_(exists|query|value)\s*\(/i, // PG 17
      /\bmerge\b[\s\S]*\breturning\b/i, // PG 17
      /\bpg_input_is_valid\b|\bany_value\s*\(|\bsystem_user\b/i, // PG 16
    ]
    for (const migration of await readMigrations()) {
      for (const pattern of newerThan15) {
        expect(migration.sql, `${migration.name} matches ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
