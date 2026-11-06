/**
 * The subset of PostgREST that @supabase/postgrest-js sends in this app, translated to SQL the way
 * PostgREST itself does it: every request is one transaction as role anon/authenticated with
 * `request.jwt.claims` set, rows are read back through `json_agg`, inserts go through
 * `json_populate_recordset`. So RLS, GRANTs, triggers, constraints and the JSON Postgres produces
 * are all real. Anything else raises SimUnsupported: nothing here re-implements an app rule.
 */
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { json, SimUnsupported } from './http.ts'

export type Role = 'anon' | 'authenticated'

export interface Identity {
  role: Role
  claims: Record<string, unknown>
}

interface FunctionInfo {
  args: { name: string; type: string }[]
  /** How many trailing arguments have defaults. */
  defaults: number
  returnsSet: boolean
  returnsVoid: boolean
  returnsComposite: boolean
}

export interface SchemaCache {
  tables: Map<string, Set<string>>
  functions: Map<string, FunctionInfo>
}

/** Rows of the exposed schema: what PostgREST reads at startup into its schema cache. */
export async function loadSchemaCache(pg: PGlite): Promise<SchemaCache> {
  const tables = await pg.query<{ name: string; columns: string[] }>(`
    select c.relname::text as name, array_agg(a.attname::text order by a.attnum) as columns
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
    group by c.relname`)
  const functions = await pg.query<{
    name: string
    argnames: string[] | null
    argtypes: string[] | null
    defaults: number
    returns_set: boolean
    return_type: string
    return_kind: string
  }>(`
    select p.proname::text as name, p.proargnames as argnames,
      (select array_agg(format_type(u.t, null) order by u.o)
         from unnest(p.proargtypes) with ordinality as u (t, o)) as argtypes,
      p.pronargdefaults::int as defaults, p.proretset as returns_set,
      format_type(p.prorettype, null) as return_type, t.typtype::text as return_kind
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
    where n.nspname = 'public' and p.prokind = 'f'`)
  return {
    tables: new Map(tables.rows.map((row) => [row.name, new Set(row.columns)])),
    functions: new Map(
      functions.rows.map((row) => [
        row.name,
        {
          args: (row.argtypes ?? []).map((type, index) => ({
            name: row.argnames?.[index] ?? '',
            type,
          })),
          defaults: row.defaults,
          returnsSet: row.returns_set,
          returnsVoid: row.return_type === 'void',
          returnsComposite: row.return_kind === 'c',
        },
      ]),
    ),
  }
}

/** PostgREST's HTTP status for a Postgres error code (its documented table). */
export function statusForPgCode(code: string, role: Role): number {
  if (code === '42501') return role === 'anon' ? 401 : 403
  if (code === '23503' || code === '23505') return 409
  if (code === '25006') return 405
  if (code === '42883' || code === '42P01') return 404
  if (code === 'P0001') return 400
  const c2 = code.slice(0, 2)
  if (c2 === '08' || c2 === '53') return 503
  if (c2 === '0L' || c2 === '0P' || c2 === '28') return 403
  if (
    [
      '09',
      '25',
      '2D',
      '38',
      '39',
      '3B',
      '40',
      '54',
      '55',
      '57',
      '58',
      'F0',
      'HV',
      'P0',
      'XX',
    ].includes(c2) ||
    code === '42P17'
  ) {
    return 500
  }
  return 400
}

function apiError(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
  hint: string | null = null,
): Response {
  return json(status, { code, details, hint, message })
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

/** Thrown inside a transaction so it rolls back, carrying the response to send. */
class Abort extends Error {
  readonly response: Response
  constructor(response: Response) {
    super('abort')
    this.response = response
  }
}

const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict'])

function parseFilters(table: string, url: URL): string[] {
  const conditions: string[] = []
  for (const [key, raw] of url.searchParams) {
    if (RESERVED_PARAMS.has(key)) continue
    if (key === 'columns') throw new SimUnsupported('the columns parameter')
    const match = /^(not\.)?(eq|gt|is)\.(.*)$/s.exec(raw)
    if (!match) throw new SimUnsupported(`the filter ${key}=${raw}`)
    const [, negated, op, operand] = match
    const column = `${table}.${quoteIdent(key)}`
    let condition: string
    if (op === 'is') {
      if (!['null', 'true', 'false', 'unknown'].includes(operand)) {
        throw new SimUnsupported(`the filter ${key}=${raw}`)
      }
      condition = `${column} IS ${operand.toUpperCase()}`
    } else {
      condition = `${column} ${op === 'eq' ? '=' : '>'} ${quoteLiteral(operand)}`
    }
    conditions.push(negated ? `NOT ${condition}` : condition)
  }
  return conditions
}

function parseOrder(table: string, url: URL): string {
  const order = url.searchParams.get('order')
  if (!order) return ''
  const terms = order.split(',').map((term) => {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/.exec(
      term,
    )
    if (!match) throw new SimUnsupported(`order=${order}`)
    const [, column, direction, nulls] = match
    const nullsSql = nulls ? ` NULLS ${nulls === 'nullsfirst' ? 'FIRST' : 'LAST'}` : ''
    return `${table}.${quoteIdent(column)} ${(direction ?? 'asc').toUpperCase()}${nullsSql}`
  })
  return `ORDER BY ${terms.join(', ')}`
}

/** `select` as a column list for the outer query ("*" or plain column names only). */
function parseSelect(url: URL): string {
  const select = url.searchParams.get('select') ?? '*'
  if (select === '*') return '*'
  const columns = select.split(',').map((column) => column.trim())
  if (columns.some((column) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column))) {
    throw new SimUnsupported(`select=${select}`)
  }
  return columns.map(quoteIdent).join(', ')
}

function nonNegativeInt(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null) return null
  if (!/^\d+$/.test(raw)) throw new SimUnsupported(`${name}=${raw}`)
  return Number(raw)
}

function parsePrefer(request: Request) {
  const prefer = {
    representation: false,
    minimal: false,
    countExact: false,
    resolution: null as 'merge' | 'ignore' | null,
  }
  const header = request.headers.get('prefer')
  if (!header) return prefer
  for (const token of header.split(',').map((part) => part.trim())) {
    if (token === 'return=representation') prefer.representation = true
    else if (token === 'return=minimal') prefer.minimal = true
    else if (token === 'count=exact') prefer.countExact = true
    else if (token === 'resolution=merge-duplicates') prefer.resolution = 'merge'
    else if (token === 'resolution=ignore-duplicates') prefer.resolution = 'ignore'
    else throw new SimUnsupported(`Prefer: ${token}`)
  }
  return prefer
}

/** Whether the client asked for one object (`.single()`); other media types fail loudly. */
function wantsSingleObject(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '*/*'
  if (accept === 'application/vnd.pgrst.object+json') return true
  if (accept === 'application/json' || accept === '*/*') return false
  throw new SimUnsupported(`Accept: ${accept}`)
}

function checkProfile(request: Request): Response | null {
  const profile = request.headers.get('accept-profile') ?? request.headers.get('content-profile')
  if (profile === null || profile === 'public') return null
  return apiError(
    406,
    'PGRST106',
    'The schema must be one of the following: public, graphql_public',
    null,
    'Only the following schemas are exposed: public, graphql_public',
  )
}

interface PgLikeError {
  code?: string
  message?: string
  detail?: string
  hint?: string
}

export function createPostgrest(pg: PGlite, schema: SchemaCache, maxRows = 1000) {
  /** One request = one transaction under the caller's role and claims, like PostgREST. */
  function inRequestTransaction<T>(
    identity: Identity,
    request: Request,
    url: URL,
    run: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return pg.transaction(async (tx) => {
      await tx.exec(`set local role ${identity.role}`)
      await tx.query(
        `select set_config('request.jwt.claims', $1, true),
                set_config('request.method', $2, true),
                set_config('request.path', $3, true),
                set_config('search_path', 'public, extensions', true)`,
        [JSON.stringify(identity.claims), request.method, url.pathname],
      )
      return run(tx)
    })
  }

  async function runQuery(
    identity: Identity,
    request: Request,
    url: URL,
    sql: string,
    params: unknown[],
    respond: (row: { total: number | null; page: number; body: string }) => Response,
  ): Promise<Response> {
    try {
      return await inRequestTransaction(identity, request, url, async (tx) => {
        const { rows } = await tx.query<{ total: number | null; page: number; body: string }>(
          sql,
          params,
        )
        const response = respond(rows[0])
        if (!response.ok) throw new Abort(response) // e.g. .single() with 0 rows rolls back
        return response
      })
    } catch (error) {
      if (error instanceof Abort) return error.response
      return fromPgError(error, identity)
    }
  }

  function fromPgError(error: unknown, identity: Identity): Response {
    const e = error as PgLikeError
    if (typeof e.code !== 'string') throw error
    return apiError(
      statusForPgCode(e.code, identity.role),
      e.code,
      e.message ?? '',
      e.detail ?? null,
      e.hint ?? null,
    )
  }

  /** Builds the answer from the outer query's row: array or `.single()` object. */
  function responder(
    single: boolean,
    status: number | ((row: { total: number | null; page: number }) => number),
    extraHeaders: (row: {
      total: number | null
      page: number
    }) => Record<string, string> = () => ({}),
  ) {
    return (row: { total: number | null; page: number; body: string }): Response => {
      const page = Number(row.page)
      if (single) {
        if (page !== 1) {
          return apiError(
            406,
            'PGRST116',
            'Cannot coerce the result to a single JSON object',
            `The result contains ${page} rows`,
          )
        }
        const object = JSON.stringify(JSON.parse(row.body)[0])
        return new Response(object, {
          status: typeof status === 'number' ? status : status(row),
          headers: {
            'Content-Type': 'application/vnd.pgrst.object+json; charset=utf-8',
            ...extraHeaders(row),
          },
        })
      }
      return new Response(row.body, {
        status: typeof status === 'number' ? status : status(row),
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders(row) },
      })
    }
  }

  const outerSelect = (projection: string) =>
    `SELECT NULL::bigint AS total, count(_t) AS page, coalesce(json_agg(_t), '[]')::text AS body
     FROM (SELECT ${projection} FROM pgrst_source) _t`

  async function read(
    request: Request,
    url: URL,
    tableName: string,
    identity: Identity,
  ): Promise<Response> {
    const prefer = parsePrefer(request)
    const single = wantsSingleObject(request)
    const table = `"public".${quoteIdent(tableName)}`
    const conditions = parseFilters(table, url)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const offset = nonNegativeInt(url, 'offset') ?? 0
    const limit = Math.min(nonNegativeInt(url, 'limit') ?? maxRows, maxRows)
    const projection = parseSelect(url)
    const sql = `
      WITH pgrst_source AS (
        SELECT ${table}.* FROM ${table} ${where} ${parseOrder(table, url)}
        LIMIT ${limit} OFFSET ${offset}
      )
      SELECT ${prefer.countExact ? `(SELECT count(*) FROM ${table} ${where})` : 'NULL::bigint'} AS total,
        count(_t) AS page, coalesce(json_agg(_t), '[]')::text AS body
      FROM (SELECT ${projection} FROM pgrst_source) _t`
    return runQuery(
      identity,
      request,
      url,
      sql,
      [],
      responder(
        single,
        ({ total, page }) => (total !== null && Number(page) < Number(total) ? 206 : 200),
        ({ total, page }) => {
          const count = Number(page)
          const range = count === 0 ? '*' : `${offset}-${offset + count - 1}`
          return { 'Content-Range': `${range}/${total === null ? '*' : Number(total)}` }
        },
      ),
    )
  }

  function parseBody(text: string): { rows: Record<string, unknown>[]; raw: string } | null {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
    const rows = Array.isArray(value) ? value : [value]
    if (rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row)))
      return null
    return { rows: rows as Record<string, unknown>[], raw: JSON.stringify(rows) }
  }

  function unknownColumn(tableName: string, columns: string[]): Response | null {
    const known = schema.tables.get(tableName)
    const missing = columns.find((column) => !known?.has(column))
    if (missing === undefined) return null
    return apiError(
      400,
      'PGRST204',
      `Could not find the '${missing}' column of '${tableName}' in the schema cache`,
    )
  }

  async function write(
    request: Request,
    url: URL,
    tableName: string,
    identity: Identity,
  ): Promise<Response> {
    const prefer = parsePrefer(request)
    const single = wantsSingleObject(request)
    const table = `"public".${quoteIdent(tableName)}`
    const projection = parseSelect(url)
    const final = outerSelect(projection)
    const returning = prefer.representation
    const empty = (status: number) => () => new Response(null, { status })

    if (request.method === 'DELETE') {
      const conditions = parseFilters(table, url)
      if (conditions.length === 0) {
        return apiError(400, '21000', 'DELETE requires a WHERE clause')
      }
      const sql = `WITH pgrst_source AS (
        DELETE FROM ${table} WHERE ${conditions.join(' AND ')} RETURNING ${table}.*) ${final}`
      return runQuery(
        identity,
        request,
        url,
        sql,
        [],
        returning ? responder(single, 200) : empty(204),
      )
    }

    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.startsWith('application/json')) {
      throw new SimUnsupported(`Content-Type: ${contentType}`)
    }
    const body = parseBody(await request.text())
    if (!body) return apiError(400, 'PGRST102', 'Empty or invalid json')
    const columns = Object.keys(body.rows[0] ?? {})
    if (body.rows.some((row) => Object.keys(row).sort().join() !== [...columns].sort().join())) {
      return apiError(400, 'PGRST102', 'All object keys must match')
    }
    const invalid = unknownColumn(tableName, columns)
    if (invalid) return invalid
    const columnList = columns.map(quoteIdent).join(', ')

    if (request.method === 'PATCH') {
      const conditions = parseFilters(table, url)
      if (conditions.length === 0) {
        return apiError(400, '21000', 'UPDATE requires a WHERE clause')
      }
      if (columns.length === 0) throw new SimUnsupported('an empty PATCH body')
      if (body.rows.length !== 1) throw new SimUnsupported('a PATCH with an array body')
      const assignments = columns.map((column) => `${quoteIdent(column)} = _.${quoteIdent(column)}`)
      const sql = `WITH pgrst_source AS (
        UPDATE ${table} SET ${assignments.join(', ')}
        FROM (SELECT * FROM json_populate_recordset(null::${table}, $1::text::json)) _
        WHERE ${conditions.join(' AND ')}
        RETURNING ${table}.*) ${final}`
      return runQuery(
        identity,
        request,
        url,
        sql,
        [body.raw],
        returning ? responder(single, 200) : empty(204),
      )
    }

    // POST: insert or upsert.
    if (columns.length === 0) throw new SimUnsupported('an empty POST body')
    if (parseFilters(table, url).length > 0) throw new SimUnsupported('filters on a POST')
    let conflict = ''
    if (prefer.resolution) {
      const target = url.searchParams.get('on_conflict')
      if (!target) throw new SimUnsupported('an upsert without on_conflict')
      const keys = target.split(',').map((column) => column.trim())
      const invalidKey = unknownColumn(tableName, keys)
      if (invalidKey) return invalidKey
      const update = columns
        .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
        .join(', ')
      conflict = `ON CONFLICT (${keys.map(quoteIdent).join(', ')}) DO ${
        prefer.resolution === 'merge' ? `UPDATE SET ${update}` : 'NOTHING'
      }`
    }
    const sql = `WITH pgrst_source AS (
      INSERT INTO ${table} (${columnList})
      SELECT ${columnList} FROM json_populate_recordset(null::${table}, $1::text::json) _
      ${conflict}
      RETURNING ${table}.*) ${final}`
    return runQuery(
      identity,
      request,
      url,
      sql,
      [body.raw],
      returning ? responder(single, 201) : empty(201),
    )
  }

  async function rpc(
    request: Request,
    url: URL,
    name: string,
    identity: Identity,
  ): Promise<Response> {
    if (request.method !== 'POST') throw new SimUnsupported(`${request.method} on rpc/${name}`)
    if (request.headers.get('prefer')) parsePrefer(request)
    wantsSingleObject(request)
    const text = await request.text()
    let args: unknown = {}
    if (text !== '') {
      try {
        args = JSON.parse(text)
      } catch {
        return apiError(400, 'PGRST102', 'Empty or invalid json')
      }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new SimUnsupported(`rpc/${name} with a non-object body`)
    }
    const given = Object.keys(args)
    const fn = schema.functions.get(name)
    const required = fn ? fn.args.slice(0, fn.args.length - fn.defaults).map((arg) => arg.name) : []
    if (
      !fn ||
      given.some((key) => !fn.args.some((arg) => arg.name === key)) ||
      required.some((arg) => !given.includes(arg))
    ) {
      const list = [...given].sort().join(', ')
      return apiError(
        404,
        'PGRST202',
        `Could not find the function public.${name}(${list}) in the schema cache`,
        `Searched for the function public.${name} with parameters ${list} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
      )
    }
    const passed = fn.args.filter((arg) => given.includes(arg.name))
    const recordType = passed.map((arg) => `${quoteIdent(arg.name)} ${arg.type}`).join(', ')
    const call = `"public".${quoteIdent(name)}(${passed
      .map((arg) => `${quoteIdent(arg.name)} := (SELECT ${quoteIdent(arg.name)} FROM pgrst_args)`)
      .join(', ')})`
    const argsCte =
      passed.length > 0
        ? `pgrst_args AS (SELECT * FROM json_to_record($1::text::json) AS _ (${recordType}))`
        : `pgrst_args AS (SELECT $1::text AS _ignored)`
    const params = [JSON.stringify(args)]

    if (fn.returnsVoid) {
      const sql = `WITH ${argsCte}, pgrst_source AS (SELECT ${call} AS pgrst_scalar)
        SELECT NULL::bigint AS total, count(*) AS page, '' AS body FROM pgrst_source`
      return runQuery(
        identity,
        request,
        url,
        sql,
        params,
        () => new Response(null, { status: 204 }),
      )
    }
    if (fn.returnsSet && fn.returnsComposite) {
      const sql = `WITH ${argsCte}, pgrst_source AS (SELECT pgrst_call.* FROM ${call} pgrst_call)
        ${outerSelect('*')}`
      return runQuery(identity, request, url, sql, params, responder(false, 200))
    }
    if (!fn.returnsSet && !fn.returnsComposite) {
      const sql = `WITH ${argsCte}, pgrst_source AS (SELECT ${call} AS pgrst_scalar)
        SELECT NULL::bigint AS total, 1 AS page, to_json(pgrst_scalar)::text AS body FROM pgrst_source`
      return runQuery(identity, request, url, sql, params, responder(false, 200))
    }
    throw new SimUnsupported(`the return type of rpc/${name}`)
  }

  return {
    /** Handles /rest/v1/<path> for an already authenticated caller. */
    async handle(request: Request, url: URL, path: string, identity: Identity): Promise<Response> {
      const badProfile = checkProfile(request)
      if (badProfile) return badProfile
      if (path.startsWith('rpc/')) return rpc(request, url, path.slice(4), identity)
      if (path === '' || path.includes('/')) throw new SimUnsupported(`the path /rest/v1/${path}`)
      if (!schema.tables.has(path)) {
        return apiError(
          404,
          'PGRST205',
          `Could not find the table 'public.${path}' in the schema cache`,
        )
      }
      if (request.method === 'GET') return read(request, url, path, identity)
      if (['POST', 'PATCH', 'DELETE'].includes(request.method)) {
        return write(request, url, path, identity)
      }
      throw new SimUnsupported(`${request.method} on a table`)
    },
  }
}
