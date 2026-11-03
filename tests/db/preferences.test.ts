import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectPgError, getRow, type PreferencesRow } from './fixtures.ts'
import { createTestDb, type DbClient, type TestDb } from './harness.ts'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.close()
})

/** What supabase-js `.upsert(row, { onConflict: 'user_id' })` sends through PostgREST. */
const upsert = (client: DbClient, values: Partial<PreferencesRow>) => {
  const columns = Object.keys(values)
  return client.query<PreferencesRow>(
    `insert into public.user_preferences (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
     on conflict (user_id) do update set ${columns
       .filter((column) => column !== 'user_id')
       .map((column) => `${column} = excluded.${column}`)
       .join(', ')}
     returning *`,
    Object.values(values),
  )
}

const full = {
  theme: 'dark',
  sidebar_collapsed: true,
  timezone: 'Asia/Taipei',
  week_starts_on: 0,
}

describe('user_preferences upsert', () => {
  it('creates the row on first upsert (user_id defaults to the caller)', async () => {
    const alice = await db.createUser()
    const { rows } = await upsert(alice, full)
    expect(rows[0]).toMatchObject({ user_id: alice.id, ...full })
  })

  it('updates the same row on later upserts, with or without an explicit user_id', async () => {
    const alice = await db.createUser()
    const first = (await upsert(alice, full)).rows[0]
    const second = (await upsert(alice, { ...full, theme: 'light' })).rows[0]
    const third = (await upsert(alice, { user_id: alice.id, ...full, week_starts_on: 1 })).rows[0]
    expect(second).toMatchObject({ theme: 'light', created_at: first.created_at })
    expect(third).toMatchObject({ theme: 'dark', week_starts_on: 1, created_at: first.created_at })
    const { rows } = await db.admin.query(
      'select * from public.user_preferences where user_id = $1',
      [alice.id],
    )
    expect(rows).toHaveLength(1)
  })

  it("cannot create or overwrite another user's preferences", async () => {
    const alice = await db.createUser()
    const bob = await db.createUser()
    await upsert(alice, full)
    const before = await getRow(db.admin, 'user_preferences', alice.id)

    // Existing row → ON CONFLICT path; RLS raises instead of silently skipping.
    await expectPgError(upsert(bob, { user_id: alice.id, ...full, theme: 'light' }), '42501')
    // No row yet → insert path.
    const carol = await db.createUser()
    await expectPgError(upsert(bob, { user_id: carol.id, ...full }), '42501')

    expect(await getRow(db.admin, 'user_preferences', alice.id)).toEqual(before)
    expect(await getRow(db.admin, 'user_preferences', carol.id)).toBeUndefined()
    const visible = await bob.query('select * from public.user_preferences')
    expect(visible.rows).toEqual([])
  })
})
