/**
 * PGlite harness for the Supabase schema tests.
 *
 * Boots an in-memory Postgres, installs the Supabase pieces the migrations depend on and applies
 * every file in `supabase/migrations` in name order:
 * - roles `anon`, `authenticated` (NOLOGIN NOINHERIT) and `service_role` (BYPASSRLS);
 * - schema `auth` with `auth.users (id, email)` and `auth.uid()` reading the `sub` claim of
 *   `request.jwt.claims`, exactly like Supabase;
 * - Supabase's default privileges: USAGE on `public` for the API roles and ALL on every new
 *   table/function/sequence created by the migration owner (so a forgotten REVOKE shows up);
 * - a non-superuser `migrator` role that owns the schema, standing in for Supabase's `postgres`
 *   role (not a superuser on hosted projects).
 *
 * Clients run every call in its own transaction, the way PostgREST does per request:
 * `set local role authenticated` + `set_config('request.jwt.claims', '{"sub":…}', true)`.
 *
 * PGlite has a single connection, so two requests can never really overlap. `prepare()` gets
 * close: it leaves a transaction uncommitted (PREPARE TRANSACTION) with its rows invisible and its
 * row/advisory locks held, then later statements play the competing request. PGlite cannot time
 * out a lock wait, so those statements must probe with NOWAIT or pg_try_* instead of waiting.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { PGlite, types, type Results, type Transaction } from '@electric-sql/pglite'

const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url)

/** Role that owns the migrated schema (stand-in for Supabase's non-superuser `postgres`). */
export const MIGRATION_OWNER = 'migrator'

const SUPABASE_SHIM = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role ${MIGRATION_OWNER} nologin noinherit;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role, ${MIGRATION_OWNER};

  create table auth.users (
    id uuid primary key,
    email text unique
  );
  grant references on auth.users to ${MIGRATION_OWNER};

  create function auth.uid() returns uuid
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage, create on schema public to ${MIGRATION_OWNER};
  alter default privileges for role ${MIGRATION_OWNER} in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges for role ${MIGRATION_OWNER} in schema public
    grant all on functions to anon, authenticated, service_role;
  alter default privileges for role ${MIGRATION_OWNER} in schema public
    grant all on sequences to anon, authenticated, service_role;
`

/** A prepared, still uncommitted transaction (see `DbClient.prepare`). */
export interface PendingTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** Runs SQL in one transaction under a fixed identity. */
export interface DbClient {
  /** One statement in its own transaction. Rejects with the Postgres error (`code`, `message`). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Results<T>>
  /** Several statements in one transaction; rolls back when `fn` throws. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>
  /**
   * Runs `fn` in a transaction and leaves it prepared but uncommitted, standing in for a
   * concurrent request that has not finished. Always settle it (`commit`/`rollback`, e.g. in a
   * `finally`): until then its locks stay held, and any statement that would wait for them hangs.
   */
  prepare(fn: (tx: Transaction) => Promise<void>): Promise<PendingTransaction>
}

/** A signed-in Supabase user (role `authenticated`, JWT `sub` = id). */
export interface UserClient extends DbClient {
  id: string
  email: string
}

export interface TestDb {
  pg: PGlite
  /** Superuser: bypasses RLS. For setup and for asserting what is really stored. */
  admin: DbClient
  /** Not signed in (role `anon`). */
  anon: DbClient
  /** Creates an `auth.users` row and returns a client signed in as that user. */
  createUser(email?: string): Promise<UserClient>
  /** Client for an arbitrary JWT subject (the user row need not exist). */
  as(userId: string): DbClient
  close(): Promise<void>
}

type Role = 'anon' | 'authenticated'

/**
 * `transaction` that ends with PREPARE TRANSACTION instead of COMMIT. PGlite's own COMMIT then
 * finds no open transaction, which Postgres only answers with a warning.
 */
function prepareWith(
  pg: PGlite,
  transaction: (fn: (tx: Transaction) => Promise<void>) => Promise<void>,
) {
  return async (fn: (tx: Transaction) => Promise<void>): Promise<PendingTransaction> => {
    const gid = `pending_${randomUUID()}`
    await transaction(async (tx) => {
      await fn(tx)
      await tx.exec(`prepare transaction '${gid}'`)
    })
    return {
      commit: async () => void (await pg.exec(`commit prepared '${gid}'`)),
      rollback: async () => void (await pg.exec(`rollback prepared '${gid}'`)),
    }
  }
}

function roleClient(pg: PGlite, role: Role, claims: Record<string, string>): DbClient {
  const claimsJson = JSON.stringify(claims)
  const transaction = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`)
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claimsJson])
      return fn(tx)
    })
  return {
    transaction,
    query: <T>(sql: string, params: unknown[] = []) =>
      transaction((tx) => tx.query<T>(sql, params)),
    prepare: prepareWith(pg, transaction),
  }
}

/** SQL of every migration file, in apply order. */
export async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort()
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, MIGRATIONS_DIR), 'utf8'),
    })),
  )
}

/** Boots PGlite, installs the Supabase shim and applies all migrations as the schema owner. */
export async function createTestDb(): Promise<TestDb> {
  const pg = await PGlite.create({
    // Enables PREPARE TRANSACTION (`DbClient.prepare`); the Postgres default is 0.
    postgresqlconf: ['max_prepared_transactions = 8'],
    parsers: {
      // Keep calendar dates as 'YYYY-MM-DD' strings (what PostgREST returns) and counts as numbers.
      [types.DATE]: (value: string) => value,
      [types.INT8]: (value: string) => Number(value),
    },
  })
  await pg.exec(SUPABASE_SHIM)

  for (const migration of await readMigrations()) {
    try {
      await pg.exec(`set role ${MIGRATION_OWNER};\n${migration.sql}\n;reset role;`)
    } catch (error) {
      await pg.exec('reset role')
      throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }

  const admin: DbClient = {
    query: <T>(sql: string, params: unknown[] = []) => pg.query<T>(sql, params),
    transaction: (fn) => pg.transaction(fn),
    prepare: prepareWith(pg, (fn) => pg.transaction(fn)),
  }
  const as = (userId: string) =>
    roleClient(pg, 'authenticated', { sub: userId, role: 'authenticated' })

  return {
    pg,
    admin,
    anon: roleClient(pg, 'anon', { role: 'anon' }),
    as,
    async createUser(email) {
      const id = randomUUID()
      const address = email ?? `${id}@example.test`
      await pg.query('insert into auth.users (id, email) values ($1, $2)', [id, address])
      return { id, email: address, ...as(id) }
    },
    async close() {
      // A test that failed before settling its prepared transaction must not leak its locks.
      const { rows } = await pg.query<{ gid: string }>('select gid from pg_prepared_xacts')
      for (const { gid } of rows) await pg.exec(`rollback prepared '${gid}'`)
      await pg.close()
    },
  }
}
