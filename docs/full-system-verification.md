# Full-system verification, M0–M5

The acceptance pass before M6. Every milestone so far was verified on its own
terms, by the chat that built it; this record exercises them **together**, as
one system, through the HTTP surface, against the built container image, from
an empty database, in one run.

Date: 2026-09-25, 09:10–09:47 UTC · `main` at `cf1454b` · PostgreSQL 17
(`postgres:17-alpine`) · Node 22 in the image · two `worker` replicas.

## Summary

**104 checks: 90 pass, 5 fail, 9 gaps.**

| Part                           | Checks | Pass | Fail | Gap |
| ------------------------------ | -----: | ---: | ---: | --: |
| A — one continuous journey     |     19 |   17 |    0 |   2 |
| B — accounts and sessions (M1) |     11 |   11 |    0 |   0 |
| B — social login               |      8 |    5 |    1 |   2 |
| B — registration (M2)          |     13 |   10 |    2 |   1 |
| B — probing (M3)               |     21 |   16 |    2 |   3 |
| B — scheduler (M4)             |      6 |    6 |    0 |   0 |
| B — storage and rollup (M5)    |      6 |    5 |    0 |   1 |
| B — operations                 |      5 |    5 |    0 |   0 |
| C — security                   |     11 |   11 |    0 |   0 |
| D — resilience                 |      4 |    4 |    0 |   0 |

**What failed** — five defects, detailed with reproductions in
[Defects](#defects):

1. **A DNS resolver error on the monitored name is recorded as `unknown`, not
   as a DNS failure** (FR-20, D-7) — _high_. With the SSRF guard on, its
   production default, `SERVFAIL` stores `unknown / unknown_error / ESERVFAIL`,
   which uptime excludes: a DNS outage reads as missing data.
2. **A host-unreachable error is recorded as `unknown`** (FR-20, D-7) —
   _medium_. `EHOSTUNREACH` is not in the classification table.
3. **A malformed OAuth state cookie answers `500`** instead of the documented
   `302 …?error=OAUTH_STATE_INVALID` — _medium_. Unauthenticated, repeatable,
   one error-level log line each.
4. **`openapi.yaml` omits two status codes the routes reach**: `400` for a
   malformed UUID path parameter and `413` for an oversized body on the
   registration routes — _low_.
5. **PRD §6.5's per-endpoint bounds are not enforced as written**: a timeout
   equal to the interval is accepted, and thresholds and methods are wider —
   _low_.

**What is missing** — nine gaps. Five were known before the run and are
confirmed as they stand: no HTTP route for statistics (NFR-9's user half);
`degraded` and `count_maintenance` never written (M6); probe history survives
endpoint deletion (B-6); real Google and GitHub unverified (F2–F5); a
`fetch`-blocked port records `unknown` (M3 D73). Two are new: the stored row
cannot say **which** assertion failed (C-3, D-4), and the endpoint list carries
no current status or latest response time (FR-10). Two could not be
exercised here: the connect-time SSRF pin inside a single probe, and Google's
`/start` redirect, which needs a discovery document the overlay's resolver
cannot fetch.

**No merged verification record is contradicted.** Two findings bear on
merged documents: M3's plan (D14) maps a resolver error to `DNS_FAILURE` only
on a code the real resolver never produces, which is defect 1; and tracker
follow-up #61 — the above-lease reclaim regime, until now proved only by the
suite — is demonstrated live (M4-3).

## Method

1. `docker-compose down -v`, then
   `docker-compose -f docker-compose.yml -f <overlay> up -d --build --scale worker=2`.
   The build hit cache on every layer, so the image is byte-identical to
   `cf1454b`'s sources. `migrate` applied `0001`–`0008` and exited 0.
2. Every functional step went through `curl` against `http://127.0.0.1:3000`.
   Where no HTTP surface exists, the record says so and names the closest
   honest route: SQL against the running database (marked **SQL**), the
   shipped `dist` code called from a script inside the image (marked
   **dist**), or the integration suite (marked **suite**).
3. Stored state was read with `psql` inside the `postgres` container. Every
   figure below is the output of a query or a request made during the run.

### The overlay

The SSRF guard refuses every address a compose network uses, so a target the
run controls cannot be probed with it on. The run therefore has three phases:

| Phase | Time (UTC)  | `SSRF_GUARD_ENABLED` | Used for                                                                       |
| ----- | ----------- | -------------------- | ------------------------------------------------------------------------------ |
| 1     | 09:11–09:28 | `false`              | Part A; M1–M5 functional checks; failure classes; Part C (non-SSRF)            |
| 2     | 09:28–09:34 | `true` (default)     | SSRF at save time and probe time; DNS classes under the guard; database outage |
| 3     | 09:34–09:47 | `false`              | Part D; scheduler kills; interval change; late commit                          |

`api` and both workers were recreated between phases; the database was not.
The overlay, not committed, adds:

- **`target`** (`node:22-alpine`, fixed `172.30.0.10`, aliases `target.test`
  and `other.test`): HTTP on 8080 with `/ok` (JSON
  `{"status":"ok","data":{"items":[{"status":"ok"}]}}`), `/slow?ms=N`,
  `/status/N`, `/hang` (never answers), `/body-stall` (headers, then
  nothing), `/reset` (headers, then socket destroyed), `/redirect/N`
  (a chain ending at `/ok`), `/big?bytes=N`; HTTPS on 8443 with a
  `target.test` certificate issued by the repository's test CA (expires
  2026-12-24), 8444 with `expired.crt`, 8445 with `wrong-name.crt`, 8446 with
  `self-signed.crt`; 8447 accepts TCP and never speaks. Every request is
  logged with its headers.
- **`dns`** (fixed `172.30.0.53`): an authoritative resolver whose answers are
  re-read from a JSON file on every query, so a name can be re-pointed
  mid-run. `api` and `worker` use it through Docker's embedded resolver
  (`dns:`), which still answers compose service names itself.
- **`worker`**: `NODE_EXTRA_CA_CERTS` = the test CA;
  `STORAGE_MAINTENANCE_INTERVAL_MS=10000` and `RETENTION_RAW_DAYS=2` (both
  inside their validated bounds) so retention acts within the run.

Everything else ran at the image's defaults. Nothing probed outside the
compose network: the one public address in play (`rebind.test` →
`93.184.216.34` at save time) was never dialled, and TEST-NET-1
(`192.0.2.1`) is not routed.

### Identifiers

| Object                      | Id                                     |
| --------------------------- | -------------------------------------- |
| alice                       | `13713c1b-5cff-43c0-a2fc-dce01ff9a938` |
| bob                         | `18a12db5-de29-4d79-9398-de61b51c4314` |
| service "Target HTTP"       | `a8517e80-61cd-4823-a7fa-2f66313ec456` |
| service "Target TLS"        | `e807618f-fc63-4824-855a-f31d2f01c4ae` |
| service "Closed port"       | `dcd00183-e425-482b-9293-b7c54a96f6a7` |
| endpoint `/ok` (succeeds)   | `1134cd2c-e862-4ca0-b22a-ec59b8ee99c3` |
| endpoint `/slow?ms=1500`    | `482e75a5-b893-4385-9bb6-29969bb75701` |
| endpoint `/ok?variant=body` | `2af0718f-b00d-4ce3-b3d5-9fa7e22ccfad` |
| endpoint TLS `/ok`          | `81639d04-7c8d-44ef-af02-dec72c88acfd` |
| endpoint closed port `/`    | `3e0d30b1-9669-428b-8ce6-a1143e39723e` |
| bob's service               | `a745e76d-0484-4e0f-a3a6-b4d1f83ed7e5` |

## Part A — one continuous journey

| #   | Requirement                                       | How                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                  | Result |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1  | NFR-16: one command from nothing                  | `down -v`, `up -d --build --scale worker=2`                                                                                                                   | `probeboard_pgdata` removed first. `migrate`: `applied 0001_init` … `applied 0008_storage`, `Exited (0)`. `GET /healthz` → `200 {"status":"ok"}`; `GET /readyz` → `200 {"status":"ok","database":"ok"}`; `api` `Up (healthy)`                                             | PASS   |
| A2  | FR-1, FR-2, A-1: register, log in, `/me`          | `POST /v1/auth/register`, `/login`, `GET /me`                                                                                                                 | register → `204`, no cookie; duplicate → `204`, identical; login → `200 {"status":"ok"}` + `pb_session`; `/me` → `{"id":"13713c1b-…","email":"alice@example.com","identities":[]}`                                                                                        | PASS   |
| A3  | FR-4, A-5: password change invalidates sessions   | two sessions (`a`, `a2`); change on `a`                                                                                                                       | change → `204`; old password → `401 INVALID_CREDENTIALS`; `a2` `/me` → `401 UNAUTHENTICATED`; `a` (the changing session) → `200`; new password → `200`                                                                                                                    | PASS   |
| A4  | FR-6, FR-11, B-1, B-2, B-4: service and endpoints | 3 services, 5 endpoints: succeeds, refused, slow, failing assertion, HTTPS                                                                                    | `baseUrl "http://target.test:8080/ignored/path"` stored as the origin. The secret header returns as `{"name":"X-Api-Key","isSecret":true}`, no value. Endpoint `x-client-id` overrides the service's `X-Client-Id` in `effectiveHeaders`                                  | PASS   |
| A5  | B-5, list: tags, pagination, cursor               | 24 endpoints, 11 services                                                                                                                                     | `?tag=env:prod` → the two prod services; `?tag=critical:true` → 2; `?tag=env:nope` → `[]`. `limit=10` pages of 10+10+4 concatenate to the unpaged list in order; 19 tagged endpoints page 7+7+5 with no repeat                                                            | PASS   |
| A6  | FR-17: probed without operator action             | `endpoint_runtime`, `claim_log`, `probe_results` after 60 s                                                                                                   | 24/24 adopted, claimed and probed; claims split 19/11 between the two workers, one result per claim                                                                                                                                                                       | PASS   |
| A7  | NFR-2: drift < 10 % of T, not accumulating        | `started_at − scheduled_at` over 162 results; consecutive `scheduled_at` gaps                                                                                 | drift p50 601 ms, p99 999 ms, **max 1002 ms** against a 3000 ms budget; all 138 gaps exactly 30.000000 s; first vs last drift per endpoint unrelated (e.g. 653 → 174 ms)                                                                                                  | PASS   |
| A8  | NFR-3: no slot probed twice                       | duplicate `(endpoint_id, scheduled_at)` in `claim_log` and `probe_results`                                                                                    | 0 and 0; 149 claims, each with exactly one result                                                                                                                                                                                                                         | PASS   |
| A9  | FR-18, FR-19: what a row carries                  | invariants over all 172 rows, and the latest row per Part A endpoint                                                                                          | `started_before_slot` 0, phases exceeding `total_ms` 0, `up` with a class 0, failure without a class 0, `up` without `ttfb_ms` 0. `/slow?ms=1500`: `up 200 total 1510 ttfb 1507`; closed port: `down connection_refused ECONNREFUSED`; TLS: `tls_ms 2`, `cert 2026-12-24` | PASS   |
| A10 | NFR-9, ADR-0003: rollup agrees with raw           | one `REPEATABLE READ` snapshot: folded raw rows vs `probe_stats`, per endpoint and grain                                                                      | m1, h1, d1: 194 raw = 194 aggregated; 0 mismatches in counts, seconds, `sum`/`min`/`max`, histogram totals. Histogram **placement** recomputed from the edges: 25/25 endpoints identical, bucket for bucket                                                               | PASS   |
| A11 | FR-9: a paused endpoint is not probed             | pause `/ok` at 09:16:46.9 (next slot was 09:16:57.581)                                                                                                        | 0 claims, 0 results after the pause. One target hit on `/ok` at 09:17:09.781 is `/redirect/3`'s final hop (`/redirect/3` 09:17:09.776 → `/2` → `/1` → `/ok`)                                                                                                              | PASS   |
| A12 | M5 D20: a resumed row inherits its slot           | resume at 09:17:36.1                                                                                                                                          | next probe `scheduled_at 09:16:57.581`, `started_at 09:17:36.863` (once, at once), then `09:17:57.581` — the original grid, 09:17:27 left as a gap                                                                                                                        | PASS   |
| A13 | B-6: delete, and what cascades                    | delete the closed-port endpoint, then the TLS service                                                                                                         | both `204`, then `404`. `endpoints`, `endpoint_runtime`, `headers`, `tags` rows gone. **Kept**: 13 `probe_results`, 9 `probe_stats`, 13 `claim_log` rows for each deleted endpoint, none written after the deletion                                                       | PASS   |
| A14 | NFR-8: retention drops raw, keeps aggregates      | **SQL**: a `probe_results` partition for 2026-09-20 with the `/ok` rows copied 5 days back (14 rows); the live worker runs retention                          | `probe_results_p20260920` dropped at 09:20:32.770; 0 raw rows before 09-21 afterwards; m1 (8 buckets), h1 and d1 each still hold `count_up 14`, `covered_seconds 420`, histogram total 14                                                                                 | PASS   |
| A15 | M5 guard: nothing unfolded is dropped             | **SQL**: a transaction holding xid 1597 open for 50 s, started before the seed                                                                                | `retention refused to drop: unfolded rows in probe_results partition past retention` from 09:19:42 to 09:20:22 (7 lines, both workers). Holder committed 09:20:27; rollup folded 56 at 09:20:32.357; the drop followed at 09:20:32.770                                    | PASS   |
| A16 | M5: `claim_log` retention                         | **SQL**: a `claim_log` partition for 2026-09-20 with 14 rows                                                                                                  | dropped at 09:19:42.672 on the first tick (`claim_log` has no fold to wait for)                                                                                                                                                                                           | PASS   |
| A17 | NFR-9: 30 days served from aggregates             | **dist**: `StatsRepository.windowStats` run in the image as a role with no `SELECT` on `probe_results` (control: `permission denied for table probe_results`) | `from 2026-08-26T00:00Z to 09:23Z`: `up 33` = 14 whose raw is gone + 19 live, `coveredSeconds 990`, **`rowsRead 11`**, `tiles {d1:30,h1:9,m1:23}`. Bob's id on alice's endpoint → `NOT_FOUND`                                                                             | PASS   |
| A18 | NFR-9, FR-32: a user can read it                  | `openapi.yaml`, live `/docs-json`                                                                                                                             | no statistics route exists — known                                                                                                                                                                                                                                        | GAP    |

A13 records the cascade, which behaves as designed. Its surviving rows mean
B-6's "delete removes probe history" is not met; that is the known follow-up
from #68, recorded as a gap rather than a new failure:

| #    | Requirement                       | Evidence                                                                                                                                                                         | Result |
| ---- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A13b | B-6: delete removes probe history | raw rows stay until retention; `probe_stats` for deleted endpoints stay (5 orphaned endpoint ids at the end, `d1` kept for ever); unreadable through `windowStats` (`NOT_FOUND`) | GAP    |

**Two details worth carrying into M8.** The trailing window must be aligned
by the caller: `now − 30 d` at minute precision is refused with
`WINDOW_GRAIN_RETIRED` (m1 for 08-26 no longer exists), and hour-aligned is
refused the same way because the first `h1` partition is 2026-09-01 — on a
young installation "retired" also means "never existed". Day-aligned works.
And A12's resume probe carries a 39 s `started_at − scheduled_at`: an NFR-2
evidence query must exclude resume probes or report them separately.

## Part B — per module

### Accounts and sessions (M1)

| #     | Requirement                          | How                                                                    | Evidence                                                                                                                                                                                               | Result |
| ----- | ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| M1-1  | A-1 validation                       | bad email, 9-char password, unknown field, `{}`                        | `400 VALIDATION_FAILED` with `details[].path` `email` / `password` ("must be at least 10 characters") / `(root)` ("Unrecognized key: \"isAdmin\"") / both fields at once                               | PASS   |
| M1-2  | A-1: no enumeration on register      | `ALICE@Example.COM` again                                              | `204`, indistinguishable; still one `alice@example.com` row                                                                                                                                            | PASS   |
| M1-3  | NFR-10                               | **SQL** `users.password_hash`                                          | `$argon2id$v=19$m=19456,t=2,p=1`                                                                                                                                                                       | PASS   |
| M1-4  | A-2: wrong password ≡ unknown email  | 3 pairs                                                                | both `401`, bodies byte-identical (md5 `26ada14b…` twice); 12–25 ms either way, no side consistently slower                                                                                            | PASS   |
| M1-5  | A-6: per-account lockout             | 5 wrong for bob, then his correct password                             | five `401`, sixth `429 RATE_LIMITED`; alice from the same address `200`                                                                                                                                | PASS   |
| M1-6  | A-6: per-address limit, concurrently | 30 parallel logins naming 30 accounts                                  | exactly **20 `401` + 10 `429`**; `auth_attempts` holds 20 `ip` rows                                                                                                                                    | PASS   |
| M1-7  | logout vs logout-all                 | bob: three sessions                                                    | `logout` on b1 → b1 `401`, b2 and b3 `200`; `logout-all` on b2 → b2, b3 `401`; alice unaffected. Both clear the cookie (`Expires=Thu, 01 Jan 1970`)                                                    | PASS   |
| M1-8  | session cap                          | 12 logins, `MAX_SESSIONS_PER_USER=10`                                  | sessions 1–2 `401`, 3–12 `200`; 10 active                                                                                                                                                              | PASS   |
| M1-9  | A-3: touch and expiry                | **SQL**: back-date `last_seen_at` 10 min; set `expires_at` in the past | `/me` moved `last_seen_at` to 09:14:45.148; a second `/me` inside the 5-minute interval did not; `expires_at` unchanged (absolute, 30 days). Expired session → `401`                                   | PASS   |
| M1-10 | cookie flags, in the response        | compose stack; a one-off container of the same image at defaults       | compose: `pb_session=…; Path=/; Expires=+30 d; HttpOnly; SameSite=Lax` (`COOKIE_SECURE=false` is set there). Defaults: `__Host-pb_session=…; Path=/; …; HttpOnly; Secure; SameSite=Lax`; `/docs` `404` | PASS   |
| M1-11 | `/me` shape                          | —                                                                      | `{"id","email","identities":[]}`; the token never in a body                                                                                                                                            | PASS   |

Rate-limit counters were reset between M1-5 and M1-6 with
`truncate auth_attempts`, the reset `http/common.http` documents.

### Social login

The provider issuer is not configurable in the image (the Google and GitHub
URLs are constructor defaults, injectable only in tests), so the compose stack
cannot reach the local stub. Every provider-free path went over HTTP; the round
trip went through its suite.

| #     | Requirement                                 | How                                                                                                                               | Evidence                                                                                                                                                                                           | Result |
| ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| SL-1a | `start` builds the redirect (GitHub)        | `GET /v1/auth/oauth/github/start`                                                                                                 | `302 https://github.com/login/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fv1%2Fauth%2Foauth%2Fgithub%2Fcallback&…&state=…&code_challenge=…&code_challenge_method=S256`            | PASS   |
| SL-1b | `start` builds the redirect (Google)        | `GET /v1/auth/oauth/google/start`                                                                                                 | `502 OAUTH_PROVIDER_ERROR`, a clean failure: Google's redirect needs its discovery document, and the overlay's resolver cannot resolve `accounts.google.com`. The redirect itself was not observed | GAP    |
| SL-2  | unknown provider                            | `/v1/auth/oauth/bitbucket/start`, `DELETE /v1/auth/oauth/bitbucket`                                                               | `404 {"code":"NOT_FOUND","message":"route not found"}`                                                                                                                                             | PASS   |
| SL-3  | callback refusals                           | no cookie; `/start`'s real cookie with a wrong state; `?error=access_denied`; a well-formed UUID never issued                     | each `302 http://127.0.0.1:5173/login?error=OAUTH_STATE_INVALID`                                                                                                                                   | PASS   |
| SL-4  | callback with a malformed cookie            | `Cookie: pb_oauth=forged-value-123` (and `not-a-uuid`, `abc%20def`; GitHub too)                                                   | **`500 {"code":"INTERNAL_ERROR"}`**; log `cause: "22P02: invalid input syntax for type uuid"` — [defect 3](#3-a-malformed-oauth-state-cookie-answers-500)                                          | FAIL   |
| SL-5  | link, identities, unlink without a provider | —                                                                                                                                 | `link` without a session `401`; `identities` → `[]`; unlink never-linked `404 identity not found`; unlink without a session `401`                                                                  | PASS   |
| SL-6  | the round trip against the local stub       | **suite**: `oauth-signin`, `oauth-linking`, `passwordless-account` `.int.test.ts` against a throwaway database on the same server | 3 files, **38 tests passed** — locally on Node 24, and in CI on Node 22.23.2 at this record's head (`Integration tests` job: `oauth-linking` 12, `oauth-signin` 20, `passwordless-account` 6)      | PASS   |
| SL-7  | real Google and GitHub                      | —                                                                                                                                 | not attempted: F2–F5 open in the tracker                                                                                                                                                           | GAP    |

### Registration (M2)

| #     | Requirement                                | How                                                                                 | Evidence                                                                                                                                                                                                                                                           | Result |
| ----- | ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| M2-1  | CRUD                                       | create, get, list, `PATCH`, delete, for both resources                              | `201`/`200`/`204`/`404` as documented; `PATCH` rename → `200` with new `updatedAt`                                                                                                                                                                                 | PASS   |
| M2-2  | B-3: one URL, one form                     | `{"url":"http://target.test:8081/v1/orders"}`, then `/v1/users`                     | both `201` with the **same** `service.id` and different `endpointId`s. Explicit duplicate origin → `409 CONFLICT`; both forms at once → `400`                                                                                                                      | PASS   |
| M2-3  | owner XOR, ownership consistency           | **SQL** inserts                                                                     | header with both owners / neither → `headers_one_owner` violation; tag with both → `tags_one_owner`; moving an endpoint to bob by `user_id` → `endpoints_service_owner_fkey` violation                                                                             | PASS   |
| M2-4  | FR-16, B-8: quota                          | bob: 99 explicit + 1 implicit, then one of each form over                           | both `409 {"code":"QUOTA_EXCEEDED","message":"endpoint quota reached: 100 of 100 used","details":{"limit":100,"count":100}}`; the refused implicit form left no service behind. **Concurrent**: 5 free, 20 parallel creates → exactly 5 `201` + 15 `409`, 100 rows | PASS   |
| M2-5  | B-4: secret headers                        | **SQL** at rest; every list and get as both users; `PATCH` keeping a secret by name | `X-Api-Key`: `value NULL`, ciphertext 25 B, IV 12 B, tag 16 B, plaintext not a substring. 0 occurrences in all responses. keep-by-name → `200`, the row still `is_secret` with its ciphertext; keeping a secret that does not exist → `400 HEADER_INVALID`         | PASS   |
| M2-6  | B-4: inheritance and override, on the wire | the target's request log                                                            | `/ok`'s own probes (its :27/:57 grid) carry `x-client-id: endpoint-override`; `/slow` carries the service's `probeboard-e2e` and `x-api-key: sk_live_…` (the secret, decrypted, on the wire where it belongs)                                                      | PASS   |
| M2-7  | B-5: tags                                  | `key:value`, split on the first colon                                               | tag key `a:b` → `400 "must not contain a colon"`; value `v:w` accepted and `?tag=k:v:w` finds it; duplicate key → `400`                                                                                                                                            | PASS   |
| M2-8  | pagination                                 | cursor forms                                                                        | keyset by id (A5); unknown UUID as cursor pages from its position; `limit=0`/`1001` → `400`; unknown query key → `400`                                                                                                                                             | PASS   |
| M2-9  | FR-7, FR-8, FR-21: bounds                  | `intervalS 7`, `timeoutMs 60000`, `maxRedirects 11`, `baseUrl …:6379`               | `400 "must be one of 30, 60, 300, 900, 3600"`, `"must not exceed 30000"`, `"must not exceed 10"`, `400 PORT_NOT_ALLOWED` (checked with the guard off too)                                                                                                          | PASS   |
| M2-10 | PRD §6.5 bounds                            | `intervalS 30, timeoutMs 30000`                                                     | **`201`**: timeout equal to the interval accepted — [defect 5](#5-prd-65s-per-endpoint-bounds-are-not-enforced-as-written)                                                                                                                                         | FAIL   |
| M2-11 | OpenAPI matches the routes                 | `openapi.yaml`, live `/docs-json`, `http/*.http`                                    | 26 operations in each; every one has a request in `http/`; `openapi:check` "up to date"; committed and live deep-equal except the cookie name, which the document says follows `COOKIE_SECURE`                                                                     | PASS   |
| M2-12 | documented status codes                    | malformed ids, 70 KB bodies                                                         | **`400 BAD_REQUEST`** and **`413 PAYLOAD_TOO_LARGE`** on routes whose documented responses list neither — [defect 4](#4-openapiyaml-omits-400-and-413-where-the-routes-reach-them)                                                                                 | FAIL   |
| M2-13 | FR-10: list with status and latest time    | `EndpointDto`                                                                       | no status or response-time field                                                                                                                                                                                                                                   | GAP    |

### Probing (M3)

Each class reached through the real transport, one endpoint per class, with
the stored row as evidence. Phase 1 (guard off) unless marked.

| #     | Class / requirement                   | Target                                                                                                                          | Stored (`outcome / failure_class / failure_code`, `total_ms`)                                                                                                                                                                                                                                      | Result |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M3-1  | success                               | `/ok`, `/slow?ms=1500`, `https://target.test:8443/ok`                                                                           | `up`, `200`; slow `ttfb 1507`; TLS `tls_ms 2`                                                                                                                                                                                                                                                      | PASS   |
| M3-2  | connection refused                    | `http://target.test:8099`                                                                                                       | `down / connection_refused / ECONNREFUSED`, 1 ms                                                                                                                                                                                                                                                   | PASS   |
| M3-3  | connection timeout                    | `http://192.0.2.1:8080`, timeout 5 s; `:8447` (TLS stall)                                                                       | TEST-NET-1: 22 × `CONNECTION_TIMEOUT` at the 5 s timeout (worker `outcome` log lines — the rows went with the volume); stall: `down / connection_timeout`, 5002 ms                                                                                                                                 | PASS   |
| M3-4  | DNS NXDOMAIN                          | `http://nx.test`                                                                                                                | guard off `down / dns_nxdomain / ENOTFOUND`; guard on `down / dns_nxdomain / URL_UNRESOLVABLE`, `dns_ms 1–2`                                                                                                                                                                                       | PASS   |
| M3-5  | DNS timeout (phase 2)                 | resolver silent for `servfail.test`, timeout 5 s                                                                                | `down / dns_failure`, 5002 ms, `dns_ms NULL`                                                                                                                                                                                                                                                       | PASS   |
| M3-6  | DNS resolver error                    | `SERVFAIL` for `servfail.test`                                                                                                  | guard on: **`unknown / unknown_error / ESERVFAIL`**; guard off: `down / connection_timeout` at 5003 ms — [defect 1](#1-a-dns-resolver-error-is-recorded-as-unknown)                                                                                                                                | FAIL   |
| M3-7  | host unreachable                      | `http://172.30.0.250:8080` (unused address in the subnet)                                                                       | **`unknown / unknown_error / EHOSTUNREACH`**, 3094 ms — [defect 2](#2-a-host-unreachable-error-is-recorded-as-unknown)                                                                                                                                                                             | FAIL   |
| M3-8  | TLS classes                           | ports 8444, 8445, 8446, and `https://target.test:8080`                                                                          | `tls_expired / CERT_HAS_EXPIRED`; `tls_hostname_mismatch / ERR_TLS_CERT_ALTNAME_INVALID`; `tls_untrusted / DEPTH_ZERO_SELF_SIGNED_CERT`; `tls_handshake_failed / ERR_SSL_WRONG_VERSION_NUMBER`                                                                                                     | PASS   |
| M3-9  | FR-19: response timeout               | `/hang`, timeout 3 s                                                                                                            | `down / response_timeout`, 3001 ms, `ttfb NULL`                                                                                                                                                                                                                                                    | PASS   |
| M3-10 | body timeout                          | `/body-stall`, timeout 3 s                                                                                                      | `down / body_timeout`, `200`, 2999–3003 ms                                                                                                                                                                                                                                                         | PASS   |
| M3-11 | connection reset                      | `/reset`                                                                                                                        | `down / connection_reset / UND_ERR_SOCKET`, `200`                                                                                                                                                                                                                                                  | PASS   |
| M3-12 | FR-12: status                         | `/status/500`; `/redirect/2` with `followRedirects false`                                                                       | `down / status_mismatch`, `500`; `down / status_mismatch`, `302`                                                                                                                                                                                                                                   | PASS   |
| M3-13 | FR-13, FR-15: assertions              | `body_contains` absent; `json_path $.data.items[0].status = "bad"`; `data.items[0].status = "ok"` + `body_not_contains "error"` | `down / assertion_failed`, `200`; same; `up`                                                                                                                                                                                                                                                       | PASS   |
| M3-14 | C-3, D-4: which assertion failed      | the rows of M3-13                                                                                                               | a body and a `json_path` failure store identical rows (`assertion_failed`, no code); the evaluator's `reason` is not persisted                                                                                                                                                                     | GAP    |
| M3-15 | FR-21: redirects                      | `/redirect/3`; `/redirect/7` with `maxRedirects 5`                                                                              | `up`, `redirects 3`; `down / too_many_redirects`, `redirects 5`                                                                                                                                                                                                                                    | PASS   |
| M3-16 | NFR-13: body cap                      | `/big?bytes=1000000`; `1000001` with `body_not_contains`                                                                        | `up`, `truncated true`; `down / assertion_failed`, `truncated true` (absence unprovable on a truncated body, M3 D23)                                                                                                                                                                               | PASS   |
| M3-17 | FR-22: certificate expiry             | the four TLS targets                                                                                                            | `cert_expires_at` 2026-12-24 (valid), 2021-01-01 (expired), 2046-09-15 (self-signed, wrong name) — recorded on failure too                                                                                                                                                                         | PASS   |
| M3-18 | `json_path` never walks the prototype | `constructor.name = "Object"`, `__proto__ = {}`, `data.items.length = 1`, `status.length = 2` (all pass the save-time grammar)  | each `down / assertion_failed`                                                                                                                                                                                                                                                                     | PASS   |
| M3-19 | NFR-12, NFR-15: what goes on the wire | the target's request log                                                                                                        | only `host`, `connection`, the configured headers, `accept`, `accept-language`, `sec-fetch-mode`, `user-agent: undici`, `accept-encoding`; no cookie, no credential of probeboard's. `Host`, `Content-Length`, `Transfer-Encoding` refused at save (C-11). a Latin-1 value (`café`) arrives intact | PASS   |
| M3-20 | `fetch`-blocked port                  | **dist**: the shipped `probe()` with the worker's deps factory                                                                  | `http://127.0.0.1:1/` → `unknown / UNKNOWN_ERROR`, no code; `:2/` → `down / CONNECTION_REFUSED` — known (M3 D73)                                                                                                                                                                                   | GAP    |
| M3-21 | connect-time SSRF pin                 | —                                                                                                                               | not exercised live: it needs a name answering a public address at the guard and a private one at connect, and dialling the public one is off limits. Covered by the M3 suite                                                                                                                       | GAP    |

With the guard off (test-only configuration), `dns_ms` is `0` on every
hostname target, NXDOMAIN included: resolution happens inside undici and is
not measured. With the guard on it is measured (1–3 ms) and is `NULL` when
resolution did not finish (M3-5).

### Scheduler (M4)

| #    | Requirement                                   | How                                                                                                      | Evidence                                                                                                                                                                                                                 | Result |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| M4-1 | NFR-3: disjoint claims, whole run             | `claim_log`, end of run                                                                                  | **3043 claims, 6 worker identities, 0 duplicate slots**; 0 duplicate results                                                                                                                                             | PASS   |
| M4-2 | NFR-4, below-lease regime, live               | `docker kill -s SIGKILL` worker-1 at 09:37:21.96 under 40 hanging endpoints                              | 37 slots died with it; **all 37 reclaimed by worker-2 60.4–60.6 s after their claim** (bound: lease 60 s + tick 1 s), 27.5–58.6 s after the kill; each on the **next** slot (D5), 0 retries of a dead slot, 0 duplicates | PASS   |
| M4-3 | NFR-4, above-lease regime, live (tracker #61) | interval-300 endpoint claimed by worker-2 at 09:39:45.705 (lease to 09:40:45.705); SIGKILL at 09:39:56.4 | next slot claimed by worker-1 at **09:44:45.428** — 299.7 s after the dead claim, 289.0 s after the kill, inside D6's `max(300 s, 60 s) + 1 s`; result `up 20008`; the dead slot never retried                           | PASS   |
| M4-4 | interval change honoured by reconcile         | `PATCH intervalS 30 → 60` at 09:41:47                                                                    | within one tick: `next_run_at 09:41:57.581 → 09:42:27.581` (from the slot, not `now()`), `scheduled_interval_s 60`; then five slots exactly 60.000000 s apart                                                            | PASS   |
| M4-5 | NFR-1: a slow endpoint does not delay others  | 40 endpoints hanging for their full 25 s every 30 s                                                      | clean window, 36 hanging in flight: claim delay max **1001 ms** (hang) and **983 ms** (others), 0 over 3 s                                                                                                               | PASS   |
| M4-6 | NFR-5: the recorded latency is the endpoint's | `/slow?ms=1500` under load and across claim delays                                                       | `total_ms` 1502–1514 over 47 probes whatever the claim delay; `ttfb` ≈ 1506                                                                                                                                              | PASS   |

Graceful shutdown is D2 below. One window was discarded from M4-5: between
09:37:03.2 and 09:37:12.0 **every** container went silent at once — no claims
from either worker, no target requests, and the `api` healthcheck due at
09:37:08 never ran — then worker-1 claimed 21 rows in one batch. That is this
machine's recorded intermittent freeze (tracker, M5 process), not the
scheduler; it put 7 of 138 claims over 3 s in that window, and the clean
window above has none.

### Storage and rollup (M5)

| #    | Requirement                                     | How                                                                                             | Evidence                                                                                                                                                                    | Result |
| ---- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M5-1 | partitions ahead of need                        | `pg_inherits` after startup                                                                     | raw, m1 and `claim_log`: 09-25 … 09-28; h1: 2026-09 … 2026-11; `partitions ensured` every tick, `horizonDays` 3.6                                                           | PASS   |
| M5-2 | the xid8 watermark never loses a late commit    | **SQL**: transaction A inserts a row (xid 5239) and stays open 25 s while probes commit         | during A: `last_xid = 5239` exactly, 9 later rows visible, A's row not folded. After A commits: m1, h1, d1 each `count_up 1`, histogram 1, `sum_total_ms 42`                | PASS   |
| M5-3 | rollup idempotent across restarts and kills     | A10's comparison at the end: 6 worker identities, 2 recreates, 2 SIGKILLs, 3 container restarts | 2954 raw = 2954 aggregated at every grain, 202 endpoints, 0 mismatches of any kind                                                                                          | PASS   |
| M5-4 | retention under a live worker                   | A14's drop                                                                                      | claims around 09:20:32 on time (0 over 3 s); no error lines. Blocking under a long reader was measured in M5 and not re-measured here                                       | PASS   |
| M5-5 | percentiles from aggregates within bucket width | **dist** `windowStats` (24 h) vs `percentile_disc` over the same raw rows                       | `/slow` p95 1513.4 vs 1514; `/slow?ms=20000` p50 20012 vs 20007; `/reset` p95 63.4 vs 60 (bucket 50–75); `/ok` p95 9.7 vs 4 (bucket 0–10). Counts, averages, min, max exact | PASS   |
| M5-6 | `degraded`, `count_maintenance`                 | end-of-run aggregates                                                                           | both 0 everywhere — known, M6's                                                                                                                                             | GAP    |

### Operations

| #     | Requirement                                   | How                                                            | Evidence                                                                                                                                                                                                      | Result |
| ----- | --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| OPS-1 | migrations, both directions                   | `migrate:dist` in the image against a fresh database `migtest` | `applied 0001`…`0008`; again → `nothing to apply`; `migrate:down:dist` ×9 → `rolled back 0008`…`0001`, then `nothing to roll back`, leaving only `schema_migrations` and 0 enum types; `up` again applies all | PASS   |
| OPS-2 | the `:dist` twins exist where they are needed | the runtime image                                              | `migrate:dist`, `migrate:down:dist`, `audit:json-path-assertions:dist` run; `npm run migrate` → `sh: tsx: not found`, as designed                                                                             | PASS   |
| OPS-3 | the audit runs in the container               | `audit:json-path-assertions:dist` against the live database    | `audit: no unsupported json_path assertions found`, exit 0                                                                                                                                                    | PASS   |
| OPS-4 | `/readyz` reflects a database that is gone    | `docker stop probeboard-postgres-1` for 40 s                   | `/readyz` → `503 {"code":"DATABASE_UNAVAILABLE"}` from +2 s; `/healthz` stays `200`; `api` turns `unhealthy`; after `start`, `200` with no restart                                                            | PASS   |
| OPS-5 | NFR-17: structured logs                       | all container logs                                             | every `api`/`worker` line is JSON; headers logged as `"[redacted]"`; no secret (C-9)                                                                                                                          | PASS   |

## Part C — security, as an attacker

| #    | Attack                                         | How                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Result |
| ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C-1  | A-4, FR-3: another user's objects              | alice on bob's service and endpoint, and bob on alice's: get, patch, list nested, create nested, get, patch, pause, resume, delete, delete service                                                                            | **20 of 20 → `404`**, bodies identical to a nonexistent id's (`service not found` / `endpoint not found`). Nothing changed: bob's service name, alice's timeout and state, no `/injected` row                                                                                                                                                                                                                                                                                                                                                                                                                             | PASS   |
| C-2  | leakage through lists                          | alice: `?tag=owner:bob`; her full list; bob's endpoint id as her cursor                                                                                                                                                       | `[]`; 0 of bob's ids; the cursor pages alice's own services only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PASS   |
| C-3  | ownership rewriting                            | `PATCH` with `serviceId` (bob's), `service_id`, `userId`, `user_id`, `id`, `__proto__`; a service `PATCH` with `userId`                                                                                                       | 7 of 7 → `400 VALIDATION_FAILED` at `(root)`, unrecognised key; no route moves an endpoint between services. The database refuses it too (M2-3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS   |
| C-4  | NFR-11, B-7: private targets at save (phase 2) | 29 private or special targets                                                                                                                                                                                                 | `400 ADDRESS_NOT_ALLOWED` for `127.0.0.1`, `[::1]`, `169.254.169.254`, `[fd00:ec2::254]`, `10.0.0.1`, `172.30.0.10`, `192.168.1.1`, `100.64.0.1`, `0.0.0.0`, `2130706433`, `0x7f.0.0.1`, `127.1`, `[fe80::1]`, `[::ffff:127.0.0.1]`, `[::ffff:a9fe:a9fe]`, `[64:ff9b::a9fe:a9fe]`, `[2002:7f00:1::]`, `[fc00::1]`, `[fec0::1]`, `224.0.0.1`, `192.0.2.1`, and names answering privately: `target.test`, `loop.test`, `private.test`, `meta.test`, `v6loop.test` (AAAA `::1`), `v6mapped.test`, `mixed.test` (one public + one private address). `localhost` → `URL_UNRESOLVABLE` (resolved through DNS, not `/etc/hosts`) | PASS   |
| C-5  | resolution fails closed at save                | `SERVFAIL`, `REFUSED`, a silent resolver                                                                                                                                                                                      | each `400 URL_UNRESOLVABLE "the hostname could not be resolved"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PASS   |
| C-6  | NFR-11: rebinding between save and probe       | `rebind.test` → `93.184.216.34` at save (`201`); endpoint paused at once; re-pointed to `172.30.0.10`; resumed                                                                                                                | `unknown / blocked_by_policy / ADDRESS_NOT_ALLOWED`, `dns_ms 2`, never connected; **0 requests** reached the target with `Host: rebind.test`; the public address was never dialled                                                                                                                                                                                                                                                                                                                                                                                                                                        | PASS   |
| C-7  | M2 D10: every save re-validates                | the same service and endpoint, now resolving privately                                                                                                                                                                        | `PATCH` replaying the unchanged `baseUrl` → `400 ADDRESS_NOT_ALLOWED`; endpoint `PATCH {"timeoutMs":4000}` → `400`; a new endpoint under it → `400`. A name-only service `PATCH` → `200`: D10's route table says "if present", which this is not                                                                                                                                                                                                                                                                                                                                                                          | PASS   |
| C-8  | rows saved before the guard came on            | phase-1 services on private addresses                                                                                                                                                                                         | all 10 that came due probe as `unknown / blocked_by_policy / ADDRESS_NOT_ALLOWED`; **0 target requests** after 09:28:05                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | PASS   |
| C-9  | secrets anywhere                               | `sk_live_SECRETVALUE_7f3a9`, `BOB_SECRET_TOKEN_91c2`, session tokens, passwords; 11,908 log lines from every container but the target; every list and get as both users; `probe_results`; the error responses seen in the run | 0 hits everywhere. The target received the secret 621 times, which is the feature. `HEADER_INVALID` names the header, never the value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PASS   |
| C-10 | every `/v1` route without a valid session      | 20 authenticated operations × no cookie, an expired session, a forged token, a revoked session                                                                                                                                | **80 of 80 → `401`**; alice's service untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS   |
| C-11 | malformed input                                | ids, cursors, bodies, header values, `json_path`, tags                                                                                                                                                                        | non-UUID path id → `400` (8 requests, 6 routes); cursor `not-a-uuid` → `400`; 70 KB body → `413` on 3 routes; 3000-byte path → `400 "at most 2048 bytes"`; emoji or CR/LF in a header value → `400 HEADER_INVALID`; `Host`/`Content-Length`/`Transfer-Encoding` → `400 HEADER_NOT_ALLOWED`; duplicate header name (case-insensitive) → `400`; `$.a[*]`, `$..a`, `$.a[-1]` → `400`; top-level `__proto__` key → `400`; `[]`, `null`, `"str"` → `400`. No `500` from any of them                                                                                                                                            | PASS   |

The OAuth callback's `500` (SL-4) is the one route an attacker can make fail
this way; it is counted once, under social login.

`ADDRESS_NOT_ALLOWED` returns the resolved address in `details` (C-7's
response: `"details":{"address":"172.30.0.10"}`). That is M2 §6's decision,
so the UI can explain the refusal; it also lets any signed-in user learn what
an internal name resolves to. Recorded as a decision to revisit, not as a
defect.

## Part D — resilience

| #   | Fault                                  | How                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                     | Result |
| --- | -------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | restart `api` mid-request              | 20 creates, 250 ms apart; `docker restart` at 09:34:52.166                 | restart took 0.2 s; requests 5 and 6 failed at the connection (`000`), and **neither was persisted**; all 18 `201`s are in the database                                                                                                                                                                                                                                                      | PASS   |
| D2  | restart `worker` mid-probe             | `docker restart -t 40` with 33 slots in flight (hanging probes)            | `worker stopping` 09:45:38.234 → `worker stopped` 09:46:02.564 (**24.3 s**, inside the 35 s grace and compose's 40 s). All 84 slots it claimed in the 40 s before `SIGTERM` have exactly one result, the last written 11 ms before it stopped; 0 claims after `SIGTERM`; 0 leases left. Phase recreates showed the same: a 20 s probe finished `up 20021` and the stop completed right after | PASS   |
| D3  | stop `postgres` under both processes   | 40 s outage                                                                | no container restarted or exited. Workers logged every failed tick at error level (`tick failed`, `adopt() failed`, `reconcile() failed`: 80 each), plus rollup, retention and partition failures per maintenance tick. On recovery 45 probes ran in the first 10 s; every claim in the window has exactly one result                                                                        | PASS   |
| D4  | a slow target beyond the probe timeout | 40 × `/hang` with `timeoutMs 25000`, 30 s interval, `PROBE_CONCURRENCY 50` | 420 results, all `down / response_timeout`, **24,999–25,029 ms**: the probe's own deadline, not a pool's                                                                                                                                                                                                                                                                                     | PASS   |

SIGKILL and reclaim are M4-2 and M4-3.

Notes from this part, none of them failures:

- During the outage an authenticated route answers `500 INTERNAL_ERROR`
  while `/readyz` answers `503 DATABASE_UNAVAILABLE`. M1's record accepts the
  `500`; a client cannot tell "try again" from "broken".
- The workers log three error lines per tick per worker while the database is
  down — roughly six a second for two workers, with no backoff.
- `docker kill` leaves a worker `Exited (137)`: `restart: unless-stopped`
  treats it as a manual stop. A container restarted any other way keeps its
  `WORKER_ID` (`<hostname>-1`, the pid is always 1), so two incarnations of
  one container are indistinguishable in `claim_log`.

## Not verified

- **Real Google and GitHub** (F2–F5), deliberately.
- **The connect-time SSRF pin inside one probe** (M3-21).
- **Google's `/start` redirect** (SL-1b): the overlay's resolver cannot
  resolve Google's discovery document.
- **The 500-monitor load test** (NFR-6, NFR-7) — M10's.
- **Retention under a long-running reader**, re-measured — M5's record has it.
- **`SCHEDULER_LOAD_BUDGET_MS` overrunning under pool contention** — M10's.
- **Save-time acceptance of a `fetch`-blocked port** — M3-20 checked the probe,
  not whether `POST` accepts port 1.
- **Probe rows for the TEST-NET-1 endpoint**: its guard-off results are
  evidenced from the worker's `outcome` log lines, because they were read
  after the volume was removed.

## Defects

Severity: _high_ — a wrong number reaches the database; _medium_ — a wrong
result or a contract violation a user or attacker can trigger; _low_ — a
documentation or bound mismatch with no wrong result.

### 1. A DNS resolver error is recorded as unknown

- **Breaks:** FR-20 ("DNS resolution failure" is a distinguishable kind), D-7
  and §3.5.2 (`UNKNOWN` is monitoring failure, excluded from uptime), and M3
  plan D14's stated purpose — "would have made `DNS_NXDOMAIN`/`DNS_FAILURE`
  unreachable through the real resolve path and told M6 to treat real outages
  as `UNKNOWN`".
- **Severity:** high. A domain whose authoritative servers fail — a DNSSEC
  break, a lapsed delegation — is down for every user and reads as missing
  data: uptime is overstated and M6 will never open an incident.
- **Reproduction:** with the guard on, an endpoint on a name whose resolver
  answers `SERVFAIL`. Stored: `unknown / unknown_error / ESERVFAIL`, 2 ms.
- **Cause:** the guard resolves with `dns.resolve4`/`resolve6` (c-ares). M3
  D14 maps a resolver error to `DNS_FAILURE` only when `cause.code` is
  `EAI_AGAIN` — a `getaddrinfo` code c-ares never produces. c-ares reports
  `ESERVFAIL`, `EREFUSED`, `ETIMEOUT` and others, and
  `classifyGuardRejection` (`src/worker/probing/utils/ssrf-pin.ts:81-82`)
  sends every one of them to `UNKNOWN_ERROR`. That is deliberate — its comment
  names `SERVFAIL`, a timeout and `EREFUSED` and cites architecture §7.4's
  rule against coercing an _unrecognised_ signal — but the premise does not
  hold: chapter 3 §3.4 defines `DNS_FAILURE` as "resolver itself is failing",
  which is exactly what `ESERVFAIL` says; `EAI_AGAIN` is only `getaddrinfo`'s
  spelling of it. Only a resolver that stays silent until the probe deadline
  reaches `DNS_FAILURE` (M3-5), through the abort path. With the guard off,
  undici's lookup did not return before the connect deadline and the row read
  `connection_timeout`. Inside Docker every non-NXDOMAIN resolver failure
  arrives as `ESERVFAIL` (the embedded resolver folds `REFUSED` and silence
  into it), so the other codes were not produced here.
- **Fix shape:** map the c-ares codes that mean "the resolver failed" to
  `DNS_FAILURE` in `classifyGuardRejection`, keeping the raw code, with a
  real-resolver test per code a test resolver can produce. The comment's
  §7.4 reasoning is the thing to overturn, so the fix PR should say so.

### 2. A host-unreachable error is recorded as unknown

- **Breaks:** FR-20 and D-7, as above.
- **Severity:** medium. A route that reports the host unreachable is an
  endpoint failure; recording it `unknown` removes it from uptime. On the
  public internet a dead host more often times out, which is classified
  correctly (M3-3), so this is rarer than defect 1.
- **Reproduction:** an endpoint on an unused address that answers ARP with
  nothing (`http://172.30.0.250:8080`, guard off). Stored:
  `unknown / unknown_error / EHOSTUNREACH`, ~3 s.
- **Cause:** `SIGNAL_TO_CLASS` in `failure-classes.ts` has no row for
  `EHOSTUNREACH` or `ENETUNREACH`. The table is the same with the guard on;
  the guard-off run was the only way to produce the code inside the compose
  network.
- **Fix shape:** one PR with defect 1 — both are rows in the same
  classification.

### 3. A malformed OAuth state cookie answers 500

- **Breaks:** `openapi.yaml` (the callback documents `302` and `429` only),
  the social-login plan's refusal contract (every bad state → `302` to
  `/login?error=OAUTH_STATE_INVALID`), and the rule that internal detail stays
  out of responses and a caller cannot produce an unexpected error at will.
- **Severity:** medium. Unauthenticated and repeatable; each request writes an
  error-level log line with the PostgreSQL cause, and a user with a mangled
  cookie lands on a JSON error instead of the login page. No data exposure.
- **Reproduction:**
  `curl -i -H 'Cookie: pb_oauth=forged' 'http://127.0.0.1:3000/v1/auth/oauth/github/callback?code=x&state=y'`
  → `500 {"code":"INTERNAL_ERROR"}`; log
  `"cause":"22P02: invalid input syntax for type uuid: \"forged\""`. A
  well-formed UUID answers the documented `302`, which is why
  `http/oauth.http`'s forged-cookie request (all zeros) never showed it.
- **Fix shape:** validate the cookie's shape before the lookup and treat a
  malformed one as absent, with a test that sends a non-UUID cookie.

### 4. `openapi.yaml` omits 400 and 413 where the routes reach them

- **Breaks:** `AGENTS.md`, "a documented route missing a status code it can
  reach through shared middleware".
- **Severity:** low.
- **Reproduction:** `GET /v1/services/not-a-uuid` → `400 BAD_REQUEST`, while
  that operation documents `200, 401, 404, 429`. Six of the ten operations
  with a UUID path parameter (`ParseUUIDPipe`) document no `400`: `GET` and
  `DELETE /v1/services/{id}`, `GET` and `DELETE /v1/endpoints/{id}`, `pause`,
  `resume`; the other four list it for their body or query. A 70 KB body to
  `POST /v1/services`, `POST /v1/services/{id}/endpoints` or
  `PATCH /v1/endpoints/{id}` → `413 PAYLOAD_TOO_LARGE`; none of them, nor
  `PATCH /v1/services/{id}` (same body limit, not sent), documents `413`,
  while the auth routes do.
- **Fix shape:** add the responses where the pipe and the body limit apply,
  and extend the drift test to cover them.

### 5. PRD §6.5's per-endpoint bounds are not enforced as written

- **Breaks:** PRD §6.5's table: timeout "≤ 30 s, < interval"; failures and
  successes to open/close an incident "1–10"; methods "GET, HEAD, POST, PUT,
  PATCH, DELETE".
- **Severity:** low — nothing reads the thresholds until M6, and a timeout
  equal to the interval skips slots rather than duplicating them.
- **Reproduction:** `POST /v1/services/{id}/endpoints`
  `{"path":"/iv","intervalS":30,"timeoutMs":30000}` → `201`. The schema also
  accepts `failureThreshold`/`successThreshold` up to 100 and `OPTIONS`.
- **Decision needed before a fix:** whether the PRD or the code is right. M6
  owns the thresholds; the timeout rule is a one-line check.

## Follow-ups for the tracker

| Item                                                                                                                                                  | Kind   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Defects 1 and 2: resolver and routing error classification — one fix PR                                                                               | fix    |
| Defect 3: the OAuth callback's malformed cookie — one fix PR                                                                                          | fix    |
| Defect 4: `openapi.yaml` status codes — one fix PR                                                                                                    | fix    |
| Defect 5: PRD §6.5 bounds against the schema — decide, then fix one side                                                                              | decide |
| The stored row cannot say which assertion failed (M3-14); C-3 and D-4 need it — M6 or M8                                                              | decide |
| FR-10: the endpoint list carries no current status or latest response time — M8                                                                       | decide |
| M8's window API must align a trailing window; a young installation refuses hour-aligned 30-day windows as "retired" (A17)                             | decide |
| `ADDRESS_NOT_ALLOWED`'s `details.address` resolves internal names for any signed-in user (C-7)                                                        | decide |
| An authenticated route answers `500` during a database outage while `/readyz` answers `503` (D3)                                                      | decide |
| Worker error logging during a database outage has no backoff (D3)                                                                                     | decide |
| A restarted container reuses its `WORKER_ID`; two incarnations are indistinguishable in `claim_log` (D3)                                              | decide |
| Registration draws on the same per-address budget as login (by design, "counting every attempt"); twenty registrations lock that address out of login | decide |
| No `Retry-After` on `429`                                                                                                                             | decide |
| Tracker #61 (above-lease regime live): **done** by M4-3                                                                                               | close  |
