import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectPgError } from './fixtures.ts'
import { createTestDb, MIGRATION_OWNER, readMigrations, type TestDb } from './harness.ts'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.close()
})

describe('migrations', () => {
  it('applies every migration file as the non-superuser schema owner', async () => {
    const migrations = await readMigrations()
    expect(migrations.map((migration) => migration.name)).toContain('20261102000000_init.sql')

    const { rows } = await db.admin.query<{ table_name: string; owner: string }>(`
      select c.relname as table_name, pg_get_userbyid(c.relowner) as owner
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      order by 1
    `)
    expect(rows).toEqual(
      ['milestones', 'phases', 'projects', 'task_dependencies', 'tasks', 'user_preferences'].map(
        (table_name) => ({ table_name, owner: MIGRATION_OWNER }),
      ),
    )
    const owner = await db.admin.query<{ rolsuper: boolean }>(
      'select rolsuper from pg_roles where rolname = $1',
      [MIGRATION_OWNER],
    )
    expect(owner.rows[0].rolsuper).toBe(false)
  })
})

describe('Supabase emulation', () => {
  it('runs user clients as the non-superuser authenticated role with the JWT subject', async () => {
    const alice = await db.createUser()
    const { rows } = await alice.query<{
      current_user: string
      uid: string
      rolsuper: boolean
      rolbypassrls: boolean
    }>(`
      select current_user, auth.uid() as uid, r.rolsuper, r.rolbypassrls
      from pg_roles r where r.rolname = current_user
    `)
    expect(rows[0]).toEqual({
      current_user: 'authenticated',
      uid: alice.id,
      rolsuper: false,
      rolbypassrls: false,
    })
  })

  it('runs anon clients as anon with no auth.uid()', async () => {
    const { rows } = await db.anon.query<{ current_user: string; uid: string | null }>(
      'select current_user, auth.uid() as uid',
    )
    expect(rows[0]).toEqual({ current_user: 'anon', uid: null })
  })

  it('resets the role after each client call', async () => {
    const alice = await db.createUser()
    await alice.query('select 1')
    const { rows } = await db.admin.query<{ current_user: string; uid: string | null }>(
      'select current_user, auth.uid() as uid',
    )
    expect(rows[0]).toEqual({ current_user: 'postgres', uid: null })
  })

  it('really enforces RLS for the authenticated role (fails if RLS were bypassed)', async () => {
    await db.admin.query('create table public.rls_probe (owner uuid, note text)')
    await db.admin.query('alter table public.rls_probe enable row level security')
    await db.admin.query(
      'create policy rls_probe_own on public.rls_probe for select to authenticated using (owner = auth.uid())',
    )
    await db.admin.query('grant select on public.rls_probe to authenticated')
    const alice = await db.createUser()
    const bob = await db.createUser()
    await db.admin.query('insert into public.rls_probe values ($1, $2), ($3, $4)', [
      alice.id,
      'alice',
      bob.id,
      'bob',
    ])

    const asAlice = await alice.query<{ note: string }>('select note from public.rls_probe')
    expect(asAlice.rows).toEqual([{ note: 'alice' }])
    const asAdmin = await db.admin.query<{ note: string }>(
      'select note from public.rls_probe order by note',
    )
    expect(asAdmin.rows).toEqual([{ note: 'alice' }, { note: 'bob' }])

    // The migrated tables behave the same way.
    await db.admin.query(
      'insert into public.projects (user_id, name, sort_order) values ($1, $2, $3)',
      [bob.id, 'Bob only', 'a0'],
    )
    const projects = await alice.query('select * from public.projects')
    expect(projects.rows).toEqual([])
  })

  it('grants new public objects to anon like Supabase does, so the migration must revoke', async () => {
    await db.admin.query(`set role ${MIGRATION_OWNER}`)
    try {
      await db.admin.query('create table public.default_grant_probe (id int)')
      await db.admin.query(
        'create function public.default_grant_probe_fn() returns int language sql as $$ select 1 $$',
      )
    } finally {
      await db.admin.query('reset role')
    }
    const { rows } = await db.admin.query<{ table_select: boolean; fn_execute: boolean }>(`
      select
        has_table_privilege('anon', 'public.default_grant_probe', 'select') as table_select,
        has_function_privilege('anon', 'public.default_grant_probe_fn()', 'execute') as fn_execute
    `)
    expect(rows[0]).toEqual({ table_select: true, fn_execute: true })
  })

  it('prepare() leaves a request uncommitted: invisible to others, locks held until settled', async () => {
    const alice = await db.createUser()
    const id = crypto.randomUUID()
    const visible = async () =>
      (await db.admin.query('select id from public.projects where id = $1', [id])).rows.length

    const pending = await alice.prepare(async (tx) => {
      await tx.query('insert into public.projects (id, name, sort_order) values ($1, $2, $3)', [
        id,
        'Pending',
        'a0',
      ])
    })
    expect(await visible()).toBe(0)
    await pending.commit()
    expect(await visible()).toBe(1)

    const rename = await alice.prepare(async (tx) => {
      await tx.query(`update public.projects set name = 'Renamed' where id = $1`, [id])
    })
    try {
      await expectPgError(
        db.admin.query('select id from public.projects where id = $1 for update nowait', [id]),
        '55P03',
      )
    } finally {
      await rename.rollback()
    }
    const { rows } = await db.admin.query<{ name: string }>(
      'select name from public.projects where id = $1 for update nowait',
      [id],
    )
    expect(rows).toEqual([{ name: 'Pending' }])
  })

  it('rejects writes from a JWT whose user does not exist in auth.users', async () => {
    const ghost = db.as('00000000-0000-4000-8000-000000000000')
    await expectPgError(
      ghost.query('insert into public.projects (name, sort_order) values ($1, $2)', ['X', 'a0']),
      '23503',
    )
  })
})
