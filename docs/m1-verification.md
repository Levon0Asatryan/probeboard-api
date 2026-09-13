# M1 verification record

What was executed to accept M1 — accounts, sessions, and the two-limit rate
limiter — against the real container stack, and what it produced.

Kept for the same reason as [m0-verification.md](m0-verification.md): the tests
prove each unit behaves, and every defect this project has shipped so far was
an _interaction_ property that no unit test could see. Where a claim is a
security property, the evidence below is a measurement, not an assertion that
the code looks right.

Date: 2026-09-13 · commit `ee86b15` (merged `main`) · Postgres 17-alpine ·
Node 22-alpine · NestJS 12 · two worker replicas

## Method

The stack was started from an empty volume with `docker compose up -d --build
--scale worker=2`, and every check below ran against it over HTTP with `curl`,
with the database inspected directly through `psql` where the visible response
does not prove the stored state. Nothing was stubbed.

Two checks need to control the client address the rate limiter keys on. They
were run twice: once with `TRUST_PROXY` at its default (`false`), which is the
deployed configuration, and once with it enabled so that each request could
present a distinct address. Both results are reported.

## Results

### Lifecycle and routing

| Check                                               | Result                                              |
| --------------------------------------------------- | --------------------------------------------------- |
| `docker compose up` from an empty volume            | postgres, migrate, api, 2 workers — api healthy     |
| Migrations applied automatically before boot        | `0001_init`, `0002_accounts`                        |
| Worker ids distinct across replicas                 | `952c82f6275b-1`, `ec64ebe35b29-1`                  |
| `GET /healthz`                                      | `200 {"status":"ok"}`                               |
| `GET /readyz`                                       | `200 {"status":"ok","database":"ok"}`               |
| Unmatched route                                     | `404 {"code":"NOT_FOUND"}` — JSON, not Express HTML |
| Known route, wrong method (`DELETE /v1/auth/login`) | `404 {"code":"NOT_FOUND"}`                          |
| `POST /auth/login` without the `/v1` prefix         | `404` — the prefix is really applied                |
| `POST /v1/auth/login`                               | reaches the handler                                 |

The last two are a pair on purpose. An earlier catch-all route silently
disabled the global prefix, so _both_ paths served the API; checking only that
`/v1` works would not have caught it.

### Registration and login

| Check                                        | Result                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `POST /v1/auth/register`                     | `204`, no `Set-Cookie` — registration is not login               |
| Register an address that already exists      | `204`, byte-identical to the first (A-2)                         |
| `POST /v1/auth/login`                        | `200 {"status":"ok"}` + session cookie                           |
| Cookie attributes (`COOKIE_SECURE=false`)    | `pb_session=…; Path=/; Expires=…; HttpOnly; SameSite=Lax`        |
| Cookie attributes (`COOKIE_SECURE=true`)     | `__Host-pb_session=…; Path=/; …; HttpOnly; Secure; SameSite=Lax` |
| Guard reads the prefixed name back           | `__Host-pb_session` → `200`, bare `pb_session` → `401`           |
| Logout clears the cookie under the same name | expiry `Thu, 01 Jan 1970`, `Secure` preserved                    |
| `GET /v1/auth/me` with a valid cookie        | `200 {"id":"…","email":"…"}`                                     |
| …with no cookie / with a forged token        | `401 {"code":"UNAUTHENTICATED"}`                                 |
| Stored hash parameters                       | `$argon2id$v=19$m=19456,t=2,p=1` — OWASP minimum                 |

### Indistinguishable failures (A-2)

| Check                                     | Result                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Login, address not registered             | `401 {"code":"INVALID_CREDENTIALS","message":"email or password is incorrect"}` |
| Login, address registered, wrong password | byte-identical response                                                         |
| Median response time, unknown address     | 14.2 ms                                                                         |
| Median response time, wrong password      | 16.2 ms                                                                         |

The timings matter more than the bodies. Without the dummy verification an
unknown address returns as soon as the lookup misses while a wrong password
costs a full Argon2 verification, and the gap enumerates registered accounts
regardless of what the response says. The measured difference is inside the
noise of the two samples.

### Rate limiting

| Check                                                                            | Result                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Sequential logins from one address, cap `AUTH_MAX_PER_IP=20`                     | 401 up to the 20th attempt, `429` after                 |
| Same, each request presenting a different `X-Forwarded-For`, `TRUST_PROXY=false` | identical — spoofing gains nothing                      |
| Same with `TRUST_PROXY=true`                                                     | each address gets its own budget                        |
| 5 wrong passwords for one account from 5 different addresses                     | `401`                                                   |
| 6th, from a 6th address                                                          | `429` — the account limit is not per-IP                 |
| Correct password for that account, 7th address, while locked                     | `429` — lockout is not bypassed by knowing the password |
| A different account from the same address                                        | `200` — lockout does not spread                         |
| **30 concurrent logins against one address, cap 20**                             | **19 admitted, 11 rejected; 20 attempts in the window** |

The last row is the one this design exists for. Measured before the advisory
lock was written, the same burst admitted every request — counting and then
inserting is a read-modify-write, and credential stuffing arrives in parallel,
so the limiter was decoration against the only threat it addresses.

The burst admitted 19 rather than 20 because one attempt from an earlier check
was still inside the fifteen-minute window; `select count(*) from auth_attempts`
for the contended key reads exactly 20. That is the number that matters: under
thirty-way contention the limiter landed on the cap precisely, and the error it
does make is on the conservative side.

### Sessions

| Check                                                        | Result                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| 14 logins, `MAX_SESSIONS_PER_USER=10`                        | 14 distinct tokens; the 4 oldest return `401`, the 10 newest `200` |
| Live rows in `sessions` for that account                     | 10                                                                 |
| `last_seen_at` after 6 requests crossing the 300 s threshold | written once                                                       |
| `last_seen_at` after 10 further requests inside the window   | unchanged — a read is not a write                                  |
| `POST /v1/auth/logout`                                       | `204`, that session `401`, siblings still `200`                    |
| Logout again with the dead cookie                            | `401`                                                              |
| `POST /v1/auth/logout-all`                                   | `204`, every session `401`                                         |

The `last_seen_at` pair is deliberately two-sided. A throttle that never writes
looks the same from outside as one that writes correctly, so it was shown to
write when the record is stale _and_ to stay silent when it is not.

### Password change

| Check                                 | Result                                                                |
| ------------------------------------- | --------------------------------------------------------------------- |
| Wrong current password                | `401`, password unchanged                                             |
| Correct current password              | `204`                                                                 |
| The session that performed the change | still `200` — the user is not signed out of the device they are using |
| Every other session for that account  | `401`, live rows drop from 10 to 1                                    |
| Login with the old password           | `401`                                                                 |
| Login with the new password           | `200`                                                                 |

### Input handling

| Check                             | Result                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid email                     | `400 VALIDATION_FAILED`, `details[].path = "email"`                                                                                                              |
| Password under the minimum        | `400 VALIDATION_FAILED`, `"must be at least 10 characters"`                                                                                                      |
| Empty body                        | `400` naming both missing fields                                                                                                                                 |
| Malformed JSON                    | `400 BAD_REQUEST` — parser failure does not leak a stack                                                                                                         |
| Wrong content type                | `400 VALIDATION_FAILED`                                                                                                                                          |
| 200 KB body against a 64 KB limit | `413 PAYLOAD_TOO_LARGE`, and **no** attempt recorded — the body is refused before the handler, so an oversized request cannot consume anyone's rate-limit budget |

### Failure and housekeeping

| Check                                                             | Result                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Database stopped: `GET /healthz`                                  | `200` — liveness unaffected                                                                         |
| Database stopped: `GET /readyz`                                   | `503 {"code":"DATABASE_UNAVAILABLE"}`                                                               |
| Database stopped: login                                           | `500 INTERNAL_ERROR` — no internal detail leaked                                                    |
| Database stopped: container states                                | api and both workers still `Up`                                                                     |
| Pool error logged                                                 | `idle database connection lost`, cause `57P01: terminating connection due to administrator command` |
| Database restarted                                                | `readyz` `200` and login `200` with no restart of anything                                          |
| Restart counters afterwards                                       | api 0, worker-1 0, worker-2 0                                                                       |
| 7 stale `auth_attempts` + 1 expired session seeded, api restarted | swept at startup: `{"sessions":1,"attempts":7}`, 0 remaining                                        |
| `docker compose stop` (SIGTERM)                                   | all three exit `0` in under 0.4 s; workers log the signal                                           |

An unhandled `'error'` on a `pg.Pool` is fatal to the process, so the row above
about restart counters is the assertion: the database went away and came back
and nothing needed restarting.

The housekeeping sweep logs only when it removes something, so silence is
ambiguous. Rows old enough to sweep were inserted deliberately to prove it runs
at startup rather than assuming the code path is reached.

### Suites and tooling

| Check                             | Result               |
| --------------------------------- | -------------------- |
| `npm test`                        | 246 passed, 26 files |
| `npm run test:int`                | 91 passed, 6 files   |
| `npm run lint`                    | clean                |
| `npm run typecheck`               | clean                |
| `npx prettier --check .`          | clean                |
| `docker compose build --no-cache` | clean                |

## Defects found

Two, both in the build rather than the application, and both invisible to CI
because CI always builds from a fresh checkout.

### 1. `rm -rf dist && npm run build` failed

`tsconfig.build.tsbuildinfo` sat beside the config, so it outlived the output
it described. With the marker present and `dist` gone, `tsc` considered the
project current and emitted nothing; the migration copy that runs after it then
had no directory to copy into and the build failed there, pointing at the
copy rather than at the compile that silently did nothing.

Fix: both projects write their marker under `dist/`, so deleting the output
resets the build. They take different names, because the build and typecheck
projects compile different file sets and a shared marker would make each run
invalidate the other.

### 2. Building twice nested the migrations

`cp -r src/core/db/migrations dist/core/db/migrations` copies the directory
_into_ the target once the target exists. A second build produced
`dist/core/db/migrations/migrations`, a third nested it again. Harmless today,
since the runner reads the top level, but it is a build that is not idempotent.

Fix: copy the files into a path created first.

## What this does not cover

- **Ownership.** A-4 — a user reaching only their own data — is policy in M1,
  not enforcement, because there is no resource to own yet. It is enforced and
  verified in M2 with monitors.
- **Load.** NFR-6 and NFR-7 are M4 concerns; nothing here probes anything.
- **Social login.** Not implemented; investigated next.
