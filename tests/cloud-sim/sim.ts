/**
 * Cloud simulator: GoTrue + PostgREST subsets over PGlite loaded with the real migration, plus a
 * test-only control API under /__sim/. For tests only; see README.md for what it does not prove.
 *
 * `handle(request)` maps a Fetch Request to a Response, so the same code serves the browser through
 * server.ts and SupabaseRepository through `fetch` in the fast vitest test. A dropped connection
 * (fault injection) surfaces as `DropConnection`.
 */
import { createTestDb, type TestDb } from '../db/harness.ts'
import { createGotrue, verifyJwt, type AuthConfig } from './gotrue.ts'
import { json, readJson, SimUnsupported } from './http.ts'
import { createPostgrest, loadSchemaCache, type Identity } from './postgrest.ts'

/** The publishable key the app is configured with (src/data/config.ts accepts it). */
export const SIM_PUBLISHABLE_KEY = 'sb_publishable_cloudsim_test_key'

/** Closes the connection without an answer (the server may or may not have applied the request). */
export class DropConnection extends Error {
  constructor() {
    super('connection dropped by the simulator')
    this.name = 'DropConnection'
  }
}

/**
 * A planned failure for matching requests. `when: 'before'`: the request never reaches the database.
 * `when: 'after'`: the transaction committed, then the answer is replaced (or lost).
 * `action: 'replay'` (with `when: 'after'`): the request is delivered a second time and the client
 * gets the second answer, as when a browser re-sends a request after its connection died.
 */
export interface Fault {
  method?: string
  /** Regular expression tested against the path. */
  path: string
  when: 'before' | 'after'
  action: 'drop' | 'status' | 'delay' | 'replay'
  /** For 'status'. */
  status?: number
  body?: string
  contentType?: string
  /** For 'delay'. */
  delayMs?: number
  /** How many requests it hits (default 1). */
  times?: number
}

export interface RequestLogEntry {
  method: string
  path: string
  query: string
  status: number | 'dropped'
  role: string | null
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers':
    'Content-Range, Range-Unit, X-Supabase-Api-Version, x-sb-error-code',
}

export interface CloudSim {
  url: string
  db: TestDb
  handle(request: Request): Promise<Response>
  /** Requests the simulator refused because it does not implement them (must stay empty). */
  unsupported: string[]
  log: RequestLogEntry[]
  faults: Fault[]
  config: AuthConfig
  close(): Promise<void>
}

export interface CloudSimOptions {
  url?: string
  siteUrl?: string
  autoconfirm?: boolean
  maxRows?: number
}

function withCors(response: Response): Response {
  // Redirects and empty answers cannot be cloned with a body: rebuild the headers in place.
  for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value)
  return response
}

export async function createCloudSim(options: CloudSimOptions = {}): Promise<CloudSim> {
  const url = options.url ?? 'http://cloud-sim.test'
  const db = await createTestDb()
  const config: AuthConfig = {
    autoconfirm: options.autoconfirm ?? true,
    accessTokenTtlSeconds: 3600,
    clockOffsetSeconds: 0,
    emailIntervalSeconds: 60,
    otpExpirySeconds: 3600,
    refreshReuseSeconds: 10,
    siteUrl: options.siteUrl ?? 'http://localhost:5181',
  }
  const gotrue = createGotrue(db.pg, config, url)
  const postgrest = createPostgrest(db.pg, await loadSchemaCache(db.pg), options.maxRows ?? 1000)
  const unsupported: string[] = []
  const log: RequestLogEntry[] = []
  const faults: Fault[] = []
  /** Network latency of every API request, uniform in [min, max] ms (0 = off). */
  const latency = { minMs: 0, maxMs: 0 }

  function takeFault(method: string, path: string): Fault | undefined {
    const index = faults.findIndex(
      (fault) =>
        (fault.method === undefined || fault.method === method) &&
        new RegExp(fault.path).test(path),
    )
    if (index < 0) return undefined
    const fault = faults[index]
    fault.times = (fault.times ?? 1) - 1
    if (fault.times <= 0) faults.splice(index, 1)
    return fault
  }

  async function applyFault(fault: Fault): Promise<Response | null> {
    if (fault.action === 'drop') throw new DropConnection()
    if (fault.action === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs ?? 0))
      return null
    }
    return new Response(fault.body ?? '{"message":"Internal Server Error"}', {
      status: fault.status ?? 500,
      headers: { 'Content-Type': fault.contentType ?? 'application/json' },
    })
  }

  function apiKeyError(request: Request): Response | null {
    const key = request.headers.get('apikey')
    if (key === SIM_PUBLISHABLE_KEY) return null
    return key === null
      ? json(401, {
          message: 'No API key found in request',
          hint: 'No `apikey` request header or url param was found.',
        })
      : json(401, {
          message: 'Invalid API key',
          hint: 'Double check your Supabase `anon` or `service_role` API key.',
        })
  }

  /** Role + claims from the Authorization header; a bad token is answered as PostgREST does. */
  function identify(request: Request): Identity | Response {
    const header = request.headers.get('authorization')
    const token = header === null ? null : /^Bearer\s+(.+)$/i.exec(header)?.[1]
    // The gateway swaps a publishable key for the internal anon JWT.
    if (header === null || token === SIM_PUBLISHABLE_KEY) {
      return { role: 'anon', claims: { role: 'anon' } }
    }
    const check = verifyJwt(token ?? '', gotrue.now())
    if (!check.ok) {
      const expired = check.reason === 'expired'
      return json(
        401,
        {
          code: expired ? 'PGRST303' : 'PGRST301',
          details: null,
          hint: null,
          message: expired ? 'JWT expired' : 'No suitable key or wrong key type',
        },
        { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      )
    }
    if (check.claims.role !== 'authenticated') {
      throw new SimUnsupported(`the JWT role ${String(check.claims.role)}`)
    }
    return { role: 'authenticated', claims: check.claims }
  }

  async function control(request: Request, parsed: URL, action: string): Promise<Response> {
    const route = `${request.method} ${action}`
    switch (route) {
      case 'GET health':
        return json(200, { ok: true })
      case 'POST config': {
        const changes = (await readJson(request)) as Partial<AuthConfig>
        for (const key of Object.keys(changes) as (keyof AuthConfig)[]) {
          if (!(key in config)) throw new SimUnsupported(`the config key ${key}`)
        }
        Object.assign(config, changes)
        return json(200, config)
      }
      case 'GET mail': {
        const to = parsed.searchParams.get('to')?.toLowerCase()
        return json(
          200,
          gotrue.outbox.filter((mail) => mail.to === to),
        )
      }
      case 'POST revoke-sessions': {
        const { email } = (await readJson(request)) as { email: string }
        gotrue.revokeSessions(email)
        return json(200, { ok: true })
      }
      case 'POST sql': {
        // Superuser reads, to assert what is really stored. Never a way to change state.
        const { sql, params } = (await readJson(request)) as { sql: string; params?: unknown[] }
        if (!/^\s*select\b/i.test(sql))
          throw new SimUnsupported('a non-SELECT statement on /__sim/sql')
        const { rows } = await db.pg.query(sql, params ?? [])
        return json(200, { rows })
      }
      case 'POST fault':
        faults.push((await readJson(request)) as Fault)
        return json(200, { ok: true })
      case 'POST latency': {
        const { minMs, maxMs } = (await readJson(request)) as { minMs: number; maxMs: number }
        latency.minMs = minMs
        latency.maxMs = Math.max(minMs, maxMs)
        return json(200, { ok: true })
      }
      case 'DELETE faults':
        faults.length = 0
        return json(200, { ok: true })
      case 'GET requests':
        return json(200, log)
      case 'GET unsupported':
        return json(200, unsupported)
      case 'DELETE unsupported':
        unsupported.length = 0
        return json(200, { ok: true })
      default:
        throw new SimUnsupported(`the control route ${route}`)
    }
  }

  async function route(request: Request, parsed: URL, entry: RequestLogEntry): Promise<Response> {
    const keyError = apiKeyError(request)
    if (keyError) return keyError
    if (parsed.pathname.startsWith('/auth/v1/')) {
      return gotrue.handle(request, parsed, parsed.pathname.slice('/auth/v1/'.length))
    }
    if (parsed.pathname.startsWith('/rest/v1/')) {
      const identity = identify(request)
      if (identity instanceof Response) return identity
      entry.role = identity.role
      return postgrest.handle(request, parsed, parsed.pathname.slice('/rest/v1/'.length), identity)
    }
    throw new SimUnsupported(`the path ${parsed.pathname}`)
  }

  async function handle(request: Request): Promise<Response> {
    const parsed = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return withCors(
        new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
            'Access-Control-Allow-Headers':
              request.headers.get('access-control-request-headers') ?? '*',
            'Access-Control-Max-Age': '600',
          },
        }),
      )
    }

    try {
      if (parsed.pathname.startsWith('/__sim/')) {
        return withCors(await control(request, parsed, parsed.pathname.slice('/__sim/'.length)))
      }
      const isEmailLink = parsed.pathname === '/auth/v1/verify'
      const entry: RequestLogEntry = {
        method: request.method,
        path: parsed.pathname,
        query: parsed.search,
        status: 'dropped',
        role: null,
      }
      log.push(entry)
      if (log.length > 2000) log.shift()

      if (latency.maxMs > 0) {
        const wait = latency.minMs + Math.random() * (latency.maxMs - latency.minMs)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      const fault = takeFault(request.method, parsed.pathname)
      if (fault?.when === 'before') {
        const early = await applyFault(fault)
        if (early) {
          entry.status = early.status
          return withCors(early)
        }
      }
      const replay = fault?.action === 'replay' ? request.clone() : null
      // An email link is opened by the browser itself, without the API key.
      const response = isEmailLink
        ? await gotrue.handle(request, parsed, 'verify')
        : await route(request, parsed, entry)
      entry.status = response.status
      if (replay) {
        const second = await route(replay, parsed, entry)
        entry.status = second.status
        return withCors(second)
      }
      if (fault?.when === 'after') {
        entry.status = 'dropped'
        const late = await applyFault(fault)
        entry.status = late?.status ?? response.status
        if (late) return withCors(late)
      }
      return withCors(response)
    } catch (error) {
      if (error instanceof DropConnection) throw error
      // Fail loudly: a bug in the simulator or a request shape it does not implement.
      const message = error instanceof Error ? error.message : String(error)
      unsupported.push(`${request.method} ${parsed.pathname}${parsed.search}: ${message}`)
      console.error(`[cloud-sim] ${request.method} ${parsed.pathname}${parsed.search}: ${message}`)
      return withCors(json(501, { code: 'SIM001', details: null, hint: null, message }))
    }
  }

  return {
    url,
    db,
    handle,
    unsupported,
    log,
    faults,
    config,
    close: () => db.close(),
  }
}

/** A `fetch` over `sim.handle` for in-process clients; a dropped connection rejects like fetch. */
export function simFetch(sim: CloudSim): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    try {
      return await sim.handle(request)
    } catch (error) {
      if (error instanceof DropConnection) throw new TypeError('fetch failed', { cause: error })
      throw error
    }
  }
}
