# Cloud simulator (tests only)

A small local stand-in for a Supabase project, so the real app in cloud mode can be tested end to end
without an account, Docker or the internet. **Nothing in `src/` may import it.**

| File             | What it is                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sim.ts`         | `createCloudSim()`: API-key check, roles, CORS, fault injection, the `/__sim/*` control API. `handle(Request) → Response`                                                                                            |
| `gotrue.ts`      | The Auth endpoints `@supabase/auth-js` uses here: `signup`, `token` (password, refresh_token), `user` (GET, PUT), `logout`, `recover`, `verify`. HS256 JWTs, `exp` enforced, refresh-token rotation, an email outbox |
| `postgrest.ts`   | The PostgREST requests `@supabase/postgrest-js` sends here: tables (GET/POST/PATCH/DELETE) and `rpc/<fn>`, translated to SQL the way PostgREST does it                                                               |
| `server.ts`      | HTTP front on `127.0.0.1:54399`; exits by itself after 15 idle minutes                                                                                                                                               |
| `vite.config.ts` | The second Vite server (port 5181): private dependency cache, no file watching, no HMR                                                                                                                               |

## What is real

- `supabase/migrations/*` on PGlite (real Postgres), set up by `tests/db/harness.ts`: roles, `auth.uid()`,
  RLS, GRANTs, triggers, constraints, RPCs.
- Every API request is one transaction as role `anon` or `authenticated` with `request.jwt.claims` set.
  Rows are read back through `json_agg`, so the JSON is what Postgres produces.
- The client is the real `@supabase/supabase-js` and the app is the real app.
- No app rule is re-implemented here, and nothing filters by owner. `tests/db/supabaseRepository.sim.test.ts`
  proves it: with RLS switched off the same request does return another account's row.
- Anything the simulator does not implement answers 501 and is recorded. Every spec fails on it, so a new
  request shape cannot slip through unnoticed.

## What it does NOT prove

It is not Supabase. Passing here does not show that:

- the migration applies to a hosted project, or that its Postgres version, extensions and default privileges
  behave the same;
- the real PostgREST or GoTrue behave as re-implemented here (their status codes and error bodies were written
  from their documentation, not recorded from a server), including any version the project is upgraded to;
- the hosted gateway, CORS configuration, TLS, HTTP/2 behaviour, request-size limits and rate limits (other than
  the 60 s email interval simulated here) work with this app;
- real email delivery, Site URL and Redirect URL settings, or dashboard Auth options such as secure password
  change, CAPTCHA and MFA work with this app;
- asymmetric JWT signing keys work (the simulator signs with HS256 only);
- real concurrency is safe: PGlite has one connection, so requests run strictly one after another and the lock
  and advisory-lock paths are never contended here (`tests/db` covers some of that with prepared transactions);
- timestamps look the same: PGlite's clock has millisecond resolution, real Postgres has microseconds;
- two real devices work. Two browser contexts are a proxy for AC-13.

The real two-device test and a run against a real Supabase project are still to be done by a person with an account.

## How to run

```bash
npm run test:cloud                                      # starts both servers, runs e2e-cloud/, stops them
npx vitest run --project db tests/db/supabaseRepository.sim.test.ts   # no browser, about 2 s
```

The specs in `e2e-cloud/` drive the app through the UI and check results with `/__sim/sql` (superuser, SELECT
only). Failures are injected with `/__sim/fault` so that the real client and database react:

| Fault                             | Meaning                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `when: 'before', action: 'drop'`  | The request never reaches the database                                          |
| `when: 'after', action: 'drop'`   | Committed, then the answer is lost                                              |
| `action: 'status'`                | The answer is replaced, e.g. 500 or a gateway's HTML page                       |
| `action: 'delay'`                 | A slow or hung server                                                           |
| `when: 'after', action: 'replay'` | Delivered twice, as when a browser re-sends a request after its connection died |

The control API has no authentication. It listens on loopback only and exists only in this test server.
