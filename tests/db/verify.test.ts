/**
 * supabase/verify.sql is what the owner runs against a real project. A check that can't fail proves
 * nothing, so each safeguard is removed here (on the real migrations) and its check must report it.
 */
import { readFile } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, MIGRATION_OWNER, type TestDb } from './harness.ts'

const VERIFY_SQL = await readFile(new URL('../../supabase/verify.sql', import.meta.url), 'utf8')

interface CheckRow {
  check_name: string
  pass: boolean
  detail: string | null
}

let db: TestDb

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db?.close()
  db = await createTestDb()
})

/** Runs the file exactly as written: no parameters, as the SQL Editor would. */
async function verify(): Promise<CheckRow[]> {
  const { rows } = await db.pg.query<CheckRow>(VERIFY_SQL)
  return rows
}

const failing = (rows: CheckRow[]) => rows.filter((row) => !row.pass).map((row) => row.check_name)

/** Runs tampering SQL as the migration owner, then goes back. */
async function tamper(sql: string): Promise<void> {
  await db.pg.exec(`set role ${MIGRATION_OWNER};\n${sql}\n;reset role;`)
}

describe('supabase/verify.sql', { timeout: 60_000 }, () => {
  it('passes on a correctly migrated database, and failures would sort first', async () => {
    const rows = await verify()
    expect(failing(rows)).toEqual([])
    expect(rows.length).toBeGreaterThanOrEqual(18)
  })

  it('reads only: it contains no statement that could change anything', () => {
    // Comments and string literals may mention anything; only the SQL itself counts.
    const body = VERIFY_SQL.replace(/--.*$/gm, '')
      .replace(/'(?:[^']|'')*'/g, "''")
      .toLowerCase()
    expect(body).not.toMatch(
      /\b(insert into|update\s+\w|delete from|drop|alter|truncate|grant|revoke|create)\b/,
    )
  })

  it.each([
    [
      'RLS turned off on one table',
      'alter table public.tasks disable row level security',
      'Every table in public has RLS enabled',
    ],
    [
      'a new table without RLS',
      'create table public.leftovers (id uuid primary key)',
      'Every table in public has RLS enabled',
    ],
    [
      'a policy removed',
      'drop policy tasks_delete_own on public.tasks',
      'Each Cairn table has its 4 owner-only policies',
    ],
    [
      'a policy that lets everyone read',
      'create policy tasks_read_all on public.tasks for select to public using (true)',
      'No policy outside the owner-only set',
    ],
    [
      'an owner-only policy rewritten to allow everything',
      `drop policy tasks_select_own on public.tasks;
       create policy tasks_select_own on public.tasks for select to authenticated using (true)`,
      'Each Cairn table has its 4 owner-only policies',
    ],
    [
      'anon granted a table',
      'grant select on public.tasks to anon',
      'anon and PUBLIC have no privilege on any table',
    ],
    [
      'PUBLIC granted a table',
      'grant select on public.tasks to public',
      'anon and PUBLIC have no privilege on any table',
    ],
    [
      'authenticated granted TRUNCATE',
      'grant truncate on public.tasks to authenticated',
      'authenticated has exactly select, insert, update, delete',
    ],
    [
      'authenticated losing DELETE',
      'revoke delete on public.tasks from authenticated',
      'authenticated has exactly select, insert, update, delete',
    ],
    [
      'a SECURITY DEFINER function',
      `create function public.sneaky() returns int language sql security definer
       set search_path = '' as 'select 1'`,
      'No SECURITY DEFINER function in public',
    ],
    [
      'a function without a pinned search_path',
      `create function public.loose() returns int language sql as 'select 1'`,
      'Every function pins search_path',
    ],
    [
      'anon allowed to run an RPC',
      'grant execute on function public.import_workspace(jsonb) to anon',
      'anon can execute no function',
    ],
    [
      'authenticated allowed to run a trigger function',
      'grant execute on function public.tg_set_updated_at() to authenticated',
      'authenticated can execute exactly the 3 RPCs',
    ],
    [
      'a view that would bypass RLS',
      'create view public.everything as select * from public.tasks',
      'No view in public can bypass RLS',
    ],
    [
      'the colour migration missing: column',
      'alter table public.phases drop column color cascade',
      'Migration 20261106 applied: phases.color exists',
    ],
    [
      'the colour migration missing: constraint',
      'alter table public.phases drop constraint phases_color_valid',
      'Migration 20261106 applied: phase colours are constrained',
    ],
    [
      'a composite foreign key removed',
      'alter table public.tasks drop constraint tasks_phase_fk',
      'Composite foreign keys keep rows inside one owner and project',
    ],
    [
      'a rule trigger removed',
      'drop trigger trg_20_dependency_rules on public.task_dependencies',
      'Triggers that enforce the rules are in place',
    ],
    ['a table missing', 'drop table public.milestones', 'All 6 Cairn tables exist'],
  ])('fails when: %s', async (_name, sql, expected) => {
    await tamper(sql)
    const rows = await verify()
    expect(failing(rows)).toContain(expected)
    // Sorted so that a failure is the first thing on the screen.
    expect(rows[0].pass).toBe(false)
  })

  it('names the import function that still lacks phase colours (init migration only)', async () => {
    await tamper(`
      create or replace function public.import_workspace(p_data jsonb)
      returns jsonb language plpgsql security invoker set search_path = ''
      as $$ begin return '{}'::jsonb; end; $$`)
    expect(failing(await verify())).toContain(
      'Migration 20261106 applied: backup import keeps phase colours',
    )
  })
})
