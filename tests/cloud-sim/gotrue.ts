/**
 * The subset of Supabase Auth (GoTrue) that @supabase/auth-js uses in this app: signup, token
 * (password, refresh_token), user (GET, PUT), logout, recover, verify. Responses follow the
 * 2024-01-01 API version the client asks for (`{ code, message }`). Users live in memory; each also
 * gets a row in `auth.users` so foreign keys and RLS see a real account. Mail goes to an outbox.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { json, readJson, SimUnsupported } from './http.ts'

export const JWT_SECRET = 'cloud-sim-jwt-secret-not-a-real-secret'

export interface AuthConfig {
  /** false = sign-up needs the emailed link first (the default of hosted projects). */
  autoconfirm: boolean
  accessTokenTtlSeconds: number
  /** Moves the server's clock, e.g. to make a token expire while the browser still trusts it. */
  clockOffsetSeconds: number
  /** Minimum time between two emails to one address (hosted default: 60 s). */
  emailIntervalSeconds: number
  otpExpirySeconds: number
  /** A rotated refresh token still works this long (hosted default: 10 s). */
  refreshReuseSeconds: number
  siteUrl: string
}

export interface Mail {
  to: string
  type: 'signup' | 'recovery'
  token: string
  link: string
  sentAt: number
}

interface SimUser {
  id: string
  email: string
  salt: string
  passwordHash: string
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
  lastSignInAt: string | null
  lastEmailAt: number | null
}

interface RefreshToken {
  token: string
  sessionId: string
  userId: string
  rotatedAt: number | null
  child: string | null
}

type JwtCheck =
  { ok: true; claims: Record<string, unknown> } | { ok: false; reason: 'invalid' | 'expired' }

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

export function signJwt(claims: Record<string, unknown>, secret = JWT_SECRET): string {
  const head = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`
}

/** HS256 only (`alg: none` and friends are refused); `exp` is checked against `now` (seconds). */
export function verifyJwt(token: string, now: number): JwtCheck {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return { ok: false, reason: 'invalid' }
  try {
    const { alg } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: unknown }
    if (alg !== 'HS256') return { ok: false, reason: 'invalid' }
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { ok: false, reason: 'invalid' }
    }
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >
    if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'expired' }
    return { ok: true, claims }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

const AUTH_HEADERS = { 'X-Supabase-Api-Version': '2024-01-01' }

function authError(status: number, code: string, message: string, extra: object = {}): Response {
  return json(status, { code, message, ...extra }, { ...AUTH_HEADERS, 'x-sb-error-code': code })
}

function hashPassword(salt: string, password: string): string {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex')
}

export function createGotrue(pg: PGlite, config: AuthConfig, issuerUrl: string) {
  const usersByEmail = new Map<string, SimUser>()
  const usersById = new Map<string, SimUser>()
  const liveSessions = new Set<string>()
  const refreshTokens = new Map<string, RefreshToken>()
  const otps = new Map<
    string,
    { type: Mail['type']; userId: string; expiresAt: number; used: boolean }
  >()
  const outbox: Mail[] = []

  const now = () => Math.floor(Date.now() / 1000) + config.clockOffsetSeconds
  const iso = () => new Date(now() * 1000).toISOString()

  function userJson(user: SimUser) {
    return {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: user.confirmedAt,
      confirmed_at: user.confirmedAt,
      phone: '',
      last_sign_in_at: user.lastSignInAt,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      is_anonymous: false,
    }
  }

  function newRefreshToken(sessionId: string, userId: string): RefreshToken {
    const entry: RefreshToken = {
      token: randomBytes(9).toString('base64url'),
      sessionId,
      userId,
      rotatedAt: null,
      child: null,
    }
    refreshTokens.set(entry.token, entry)
    return entry
  }

  /** What /token answers (and the fields of a redirect's hash). */
  function sessionFields(user: SimUser, sessionId: string, refreshToken: string) {
    const issuedAt = now()
    const expiresAt = issuedAt + config.accessTokenTtlSeconds
    return {
      access_token: signJwt({
        iss: `${issuerUrl}/auth/v1`,
        sub: user.id,
        aud: 'authenticated',
        exp: expiresAt,
        iat: issuedAt,
        email: user.email,
        phone: '',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        role: 'authenticated',
        aal: 'aal1',
        amr: [{ method: 'password', timestamp: issuedAt }],
        session_id: sessionId,
        is_anonymous: false,
      }),
      token_type: 'bearer',
      expires_in: config.accessTokenTtlSeconds,
      expires_at: expiresAt,
      refresh_token: refreshToken,
    }
  }

  function startSession(user: SimUser) {
    const sessionId = randomUUID()
    liveSessions.add(sessionId)
    user.lastSignInAt = iso()
    const refresh = newRefreshToken(sessionId, user.id)
    return sessionFields(user, sessionId, refresh.token)
  }

  function revokeSession(sessionId: string): void {
    liveSessions.delete(sessionId)
  }

  function revokeUserSessions(userId: string, exceptSessionId: unknown = null): void {
    for (const entry of refreshTokens.values()) {
      if (entry.userId === userId && entry.sessionId !== exceptSessionId) {
        liveSessions.delete(entry.sessionId)
      }
    }
  }

  function sendMail(user: SimUser, type: Mail['type'], redirectTo: string | null): void {
    const token = randomBytes(16).toString('hex')
    otps.set(token, {
      type,
      userId: user.id,
      expiresAt: now() + config.otpExpirySeconds,
      used: false,
    })
    const target = safeRedirect(redirectTo)
    const link =
      `${issuerUrl}/auth/v1/verify?token=${token}&type=${type}` +
      `&redirect_to=${encodeURIComponent(target)}`
    outbox.push({ to: user.email, type, token, link, sentAt: now() })
    user.lastEmailAt = now()
  }

  /** Like the Redirect URLs allow list: anything but this machine falls back to the Site URL. */
  function safeRedirect(redirectTo: string | null): string {
    if (!redirectTo) return config.siteUrl
    try {
      return new URL(redirectTo).hostname === 'localhost' ? redirectTo : config.siteUrl
    } catch {
      return config.siteUrl
    }
  }

  /** The signed-in user of a request, or the error GoTrue answers with. */
  function requireUser(
    request: Request,
  ): { user: SimUser; claims: Record<string, unknown> } | Response {
    const header = request.headers.get('authorization') ?? ''
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]
    if (!token) {
      return authError(401, 'no_authorization', 'This endpoint requires a valid Bearer token')
    }
    const check = verifyJwt(token, now())
    if (!check.ok) {
      return authError(
        403,
        'bad_jwt',
        check.reason === 'expired'
          ? 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired'
          : 'invalid JWT: unable to parse or verify signature, signature is invalid',
      )
    }
    const user = usersById.get(String(check.claims.sub))
    if (!user) {
      return authError(403, 'user_not_found', 'User from sub claim in JWT does not exist')
    }
    if (!liveSessions.has(String(check.claims.session_id))) {
      return authError(
        403,
        'session_not_found',
        'Session from session_id claim in JWT does not exist',
      )
    }
    return { user, claims: check.claims }
  }

  function credentials(body: unknown): { email: string; password: unknown } {
    const value = (typeof body === 'object' && body !== null ? body : {}) as {
      email?: unknown
      password?: unknown
    }
    return {
      email: typeof value.email === 'string' ? value.email.trim().toLowerCase() : '',
      password: value.password,
    }
  }

  const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

  function weakPassword(password: unknown): Response | null {
    if (typeof password === 'string' && password.length >= 6) return null
    return authError(422, 'weak_password', 'Password should be at least 6 characters.', {
      weak_password: { reasons: ['length'] },
    })
  }

  async function signup(request: Request, url: URL): Promise<Response> {
    const { email, password } = credentials(await readJson(request))
    if (!validEmail(email)) {
      return authError(400, 'validation_failed', 'Unable to validate email address: invalid format')
    }
    const weak = weakPassword(password)
    if (weak) return weak
    const existing = usersByEmail.get(email)
    if (existing) {
      if (config.autoconfirm)
        return authError(422, 'user_already_exists', 'User already registered')
      // With confirmations on, GoTrue does not reveal whether an address has an account.
      return json(
        200,
        { ...userJson({ ...existing, id: randomUUID(), confirmedAt: null }), role: '' },
        AUTH_HEADERS,
      )
    }
    const salt = randomBytes(8).toString('hex')
    const stamp = iso()
    const user: SimUser = {
      id: randomUUID(),
      email,
      salt,
      passwordHash: hashPassword(salt, password as string),
      confirmedAt: config.autoconfirm ? stamp : null,
      createdAt: stamp,
      updatedAt: stamp,
      lastSignInAt: null,
      lastEmailAt: null,
    }
    await pg.query('insert into auth.users (id, email) values ($1, $2)', [user.id, email])
    usersByEmail.set(email, user)
    usersById.set(user.id, user)
    if (config.autoconfirm) {
      return json(200, { ...startSession(user), user: userJson(user) }, AUTH_HEADERS)
    }
    sendMail(user, 'signup', url.searchParams.get('redirect_to'))
    return json(200, userJson(user), AUTH_HEADERS)
  }

  async function token(request: Request, url: URL): Promise<Response> {
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const { email, password } = credentials(await readJson(request))
      const user = usersByEmail.get(email)
      if (!user || user.passwordHash !== hashPassword(user.salt, String(password))) {
        return authError(400, 'invalid_credentials', 'Invalid login credentials')
      }
      if (!user.confirmedAt) return authError(400, 'email_not_confirmed', 'Email not confirmed')
      return json(200, { ...startSession(user), user: userJson(user) }, AUTH_HEADERS)
    }
    if (grant === 'refresh_token') {
      const body = (await readJson(request)) as { refresh_token?: unknown } | undefined
      const entry = refreshTokens.get(String(body?.refresh_token))
      if (!entry || !liveSessions.has(entry.sessionId)) {
        return authError(
          400,
          'refresh_token_not_found',
          'Invalid Refresh Token: Refresh Token Not Found',
        )
      }
      const user = usersById.get(entry.userId)
      if (!user) {
        return authError(
          400,
          'refresh_token_not_found',
          'Invalid Refresh Token: Refresh Token Not Found',
        )
      }
      let current = entry
      if (entry.rotatedAt !== null) {
        if (now() - entry.rotatedAt > config.refreshReuseSeconds) {
          revokeSession(entry.sessionId) // Reuse past the grace period: the whole session is gone.
          return authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used')
        }
        // Inside the grace period the client gets the token that replaced this one.
        while (current.child) current = refreshTokens.get(current.child) ?? current
      } else {
        current = newRefreshToken(entry.sessionId, entry.userId)
        entry.rotatedAt = now()
        entry.child = current.token
      }
      return json(
        200,
        { ...sessionFields(user, entry.sessionId, current.token), user: userJson(user) },
        AUTH_HEADERS,
      )
    }
    throw new SimUnsupported(`grant_type=${grant}`)
  }

  async function updateUser(request: Request): Promise<Response> {
    const auth = requireUser(request)
    if (auth instanceof Response) return auth
    const body = (await readJson(request)) as Record<string, unknown> | undefined
    // auth-js always adds the PKCE fields; GoTrue ignores them for a password change.
    const keys = Object.keys(body ?? {}).filter((key) => !key.startsWith('code_challenge'))
    if (keys.some((key) => key !== 'password')) {
      throw new SimUnsupported(`PUT /user with ${keys.join(', ')}`)
    }
    const password = body?.password
    const weak = weakPassword(password)
    if (weak) return weak
    const { user, claims } = auth
    if (user.passwordHash === hashPassword(user.salt, password as string)) {
      return authError(
        422,
        'same_password',
        'New password should be different from the old password.',
      )
    }
    user.passwordHash = hashPassword(user.salt, password as string)
    user.updatedAt = iso()
    // A password change ends the account's other sessions.
    revokeUserSessions(user.id, claims.session_id)
    return json(200, userJson(user), AUTH_HEADERS)
  }

  async function recover(request: Request, url: URL): Promise<Response> {
    const { email } = credentials(await readJson(request))
    if (!validEmail(email)) {
      return authError(400, 'validation_failed', 'Unable to validate email address: invalid format')
    }
    const user = usersByEmail.get(email)
    if (user) {
      const since = user.lastEmailAt === null ? null : now() - user.lastEmailAt
      if (since !== null && since < config.emailIntervalSeconds) {
        return authError(
          429,
          'over_email_send_rate_limit',
          `For security purposes, you can only request this after ${config.emailIntervalSeconds - since} seconds.`,
        )
      }
      sendMail(user, 'recovery', url.searchParams.get('redirect_to'))
    }
    return json(200, {}, AUTH_HEADERS) // Same answer whether or not the address has an account.
  }

  /** The link in an email: redirects back to the app with a session (or an error) in the hash. */
  function verify(url: URL): Response {
    const type = url.searchParams.get('type')
    if (type !== 'signup' && type !== 'recovery') throw new SimUnsupported(`verify type=${type}`)
    const target = safeRedirect(url.searchParams.get('redirect_to'))
    const otp = otps.get(url.searchParams.get('token') ?? '')
    const redirect = (hash: string) =>
      new Response(null, { status: 303, headers: { Location: `${target}#${hash}` } })
    const user = otp && otp.type === type && !otp.used ? usersById.get(otp.userId) : undefined
    if (!otp || !user || otp.expiresAt <= now()) {
      return redirect(
        new URLSearchParams({
          error: 'access_denied',
          error_code: 'otp_expired',
          error_description: 'Email link is invalid or has expired',
        }).toString(),
      )
    }
    otp.used = true
    if (!user.confirmedAt) user.confirmedAt = iso()
    const session = startSession(user)
    return redirect(
      new URLSearchParams({
        access_token: session.access_token,
        expires_at: String(session.expires_at),
        expires_in: String(session.expires_in),
        refresh_token: session.refresh_token,
        token_type: session.token_type,
        type,
      }).toString(),
    )
  }

  function logout(request: Request, url: URL): Response {
    const auth = requireUser(request)
    if (auth instanceof Response) return auth
    const scope = url.searchParams.get('scope') ?? 'global'
    const sessionId = auth.claims.session_id
    if (scope === 'local') revokeSession(String(sessionId))
    else if (scope === 'others') revokeUserSessions(auth.user.id, sessionId)
    else if (scope === 'global') {
      revokeSession(String(sessionId))
      revokeUserSessions(auth.user.id)
    } else throw new SimUnsupported(`logout scope=${scope}`)
    return new Response(null, { status: 204, headers: AUTH_HEADERS })
  }

  return {
    outbox,
    now,
    /** Test control: every session of this address stops working (refresh included). */
    revokeSessions(email: string): void {
      const user = usersByEmail.get(email.toLowerCase())
      if (user) revokeUserSessions(user.id)
    },
    /** Handles /auth/v1/<endpoint>. */
    async handle(request: Request, url: URL, endpoint: string): Promise<Response> {
      const route = `${request.method} ${endpoint}`
      switch (route) {
        case 'POST signup':
          return signup(request, url)
        case 'POST token':
          return token(request, url)
        case 'GET user': {
          const auth = requireUser(request)
          return auth instanceof Response ? auth : json(200, userJson(auth.user), AUTH_HEADERS)
        }
        case 'PUT user':
          return updateUser(request)
        case 'POST recover':
          return recover(request, url)
        case 'GET verify':
          return verify(url)
        case 'POST logout':
          return logout(request, url)
        default:
          throw new SimUnsupported(`auth endpoint ${route}`)
      }
    },
  }
}
