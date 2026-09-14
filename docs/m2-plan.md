# M2 — Registration: implementation plan

Delivers FR-6…FR-16 and PRD epic B (B-1…B-8). The milestone that lets a user
register an API — a service — and the endpoints on it. Nothing here probes
anything: `probing/`, `scheduler/`, `endpoint_runtime` and `probe_results` are
M3/M4/M5.

## 1. Scope

| In                                                               | Out, and why                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Service CRUD: name, base URL, headers, tags                      | Probing, scheduling, `endpoint_runtime` — M3/M4                           |
| Endpoint CRUD under a service: method, path, per-endpoint config | Probe results, incidents, statistics — M5/M6/M8                           |
| SSRF validation **at save** (create and update)                  | Connect-time IP pinning against DNS rebinding — M3 (§6 explains why)      |
| Secret header values, write-only                                 | Notification-channel secrets (SMTP, webhook signing) — M7                 |
| Per-user endpoint quota                                          | Per-service or per-org quotas — not in the PRD                            |
| `key:value` tags, filterable                                     | A dedicated `/tags` endpoint — filtering via query param is enough for v1 |
| B-3: one-URL implicit service creation                           | —                                                                         |
| Pause/resume, edit, delete                                       | Deleting probe history — there is none yet; see §7.2                      |

Also in, as a **separate small PR, independent of this plan** (§9):

1. `POST /v1/auth/password` documents its `413` in `openapi.yaml`.
2. `openapi:check` treats only `ENOENT` as "missing", surfaces every other
   read error with its cause.
3. Tracker F1: `docker-compose.yml` reads `GOOGLE_CLIENT_ID/SECRET` and
   `GITHUB_CLIENT_ID/SECRET` from the gitignored `.env`, not hardcoded
   placeholders; `.env.example` documents it.

## 2. Investigation

### 2.1 Requirements read against each other — contradictions and gaps

- **B-6 "delete removes probe history after confirmation" vs. no history yet
  (M5).** `probe_results` does not exist until M5. Resolution: in M2, delete
  is an unconditional hard delete of the service/endpoint row (cascading to
  its headers and tags) — there is nothing else to remove yet. The
  "confirmation" is a client-side UX concern, not a server-side two-step
  protocol; nothing in B-6 or FR-9 asks for a soft-delete or an undo window.
  Recorded as a limitation in §7.2 rather than built around: once M5 lands
  `probe_results.endpoint_id → endpoints.id`, a `DELETE` on the endpoint
  already cascades correctly by the FK alone, and this plan does not need to
  anticipate that schema.

- **B-3 implicit service creation vs. an existing service at that origin.**
  B-3 says pasting a URL creates a service "implicitly from the origin." It
  does not say what happens when the user already has a service at that
  origin. Two readings: always create a new service (risks silent
  duplicates — "Payments API" and "Payments API (2)" both pointing at
  `api.example.com`), or attach the endpoint to the existing one. Decision
  (D5, §4): **attach to the existing service** when one already exists for
  this user with the same normalized origin. This matches the PRD's own
  framing in §6.2 — "a service with exactly one endpoint is the degenerate
  case" — the implicit flow is sugar over the explicit one, not a separate
  code path with different identity rules.

- **FR-16/B-8 quota is on endpoints, not services.** "The number of monitors
  per user is capped" (FR-16) and "endpoint count per user is capped" (B-8)
  both predate/postdate the service/endpoint split consistently — the quota
  is an **endpoint** count. A service with zero endpoints costs nothing
  against the quota, which is deliberate: it lets B-3's implicit flow create
  a service without a second quota check, and keeps "add a URL" a single
  atomic decision.

- **B-4 "headers inherited... overridden by name" vs. B-7 SSRF on headers.**
  B-7 is about the URL, not headers, but chapter 7's `NFR-15` ("user headers
  cannot override headers the system controls... cannot smuggle a second
  request") is a real requirement that B-4 does not mention. It belongs here
  because header validation happens at save, same as the URL. See §5.5.

- **Chapter 7's module layout (`services/`, `endpoints/`) vs. CLAUDE.md's
  "one feature, one folder."** §7.9 of the architecture chapter lists
  `services/` and `endpoints/` as separate top-level modules. CLAUDE.md's
  rule is feature-based grouping with "deleting a feature is deleting one
  folder." Services and endpoints are one feature by that test — a service
  cannot exist meaningfully without the endpoint CRUD that is its entire
  purpose, they share the same SSRF guard, the same quota context, and the
  same tag model. Decision (D8, §4): **one module, `src/api/registration/`**,
  with `services/` and `endpoints/` as sub-folders holding each their own
  controller/service/repository — not two top-level modules. This resolves
  the architecture chapter's proposed layout against CLAUDE.md's binding
  rule in CLAUDE.md's favor, matching M1's own precedent (`auth/` holds both
  session and OAuth logic in one module, not two).

- **Chapter 8's milestone table says "M3 ... SSRF guard with IP pinning"
  under Probe executor, and separately chapter 7.4 describes the full
  four-step guard (scheme/credentials/ports → resolve → classify → pin) as
  one indivisible unit ("Not URL validation. Four steps, all required").**
  M2's brief explicitly asks for save-time SSRF only. Read literally, chapter
  7.4 is M3's guard, not M2's. This plan treats M2's check as a **related but
  separate** guard: same range classification (step 3), same DNS resolution
  (step 2), same scheme/credential/port checks (step 1), but **no pinning**
  (step 4 is meaningless without a connection to pin) and re-run on every
  future connection, never trusted from save time. §6 states this boundary
  explicitly, because the requirement itself does not.

### 2.2 Code on `main` this work touches

Full findings from reading the code (not summarized from memory) are below;
citations are file:line against `main` at commit `9803d21`.

**Ownership pattern.** `SessionGuard` (`src/api/auth/guards/session.guard.ts:29-70`)
validates the session cookie and attaches `req.user = {id, email, sessionId}`.
`@CurrentUser()` (`src/api/auth/decorators/current-user.decorator.ts:11-19`)
reads it and throws a programmer-error `Error` if used without the guard —
not a 401, a bug signal. There is **no separate ownership check step**
anywhere: every repository method that reads or writes a row takes the
caller's `userId` and puts it in the `WHERE` clause, so a foreign row simply
doesn't match. `NotFoundError` (`src/core/errors/app-error.ts:21-27`) is the
uniform result, with the reasoning in its own comment: _"404 rather than 403
for a resource owned by someone else: telling an attacker that an id exists
but is not theirs is itself a disclosure."_ M2's services/endpoints
repositories follow this exactly — every `WHERE id = ? AND user_id = ?` (or,
for endpoints, `AND service.user_id = ?` via a join), never a fetch-then-compare.

There is **no shared base repository** — each of `UserRepository`,
`SessionRepository`, `OAuthIdentityRepository` hand-writes its own Kysely
queries, methods take an optional `executor: Kysely<Database> = this.db.kysely`
so a caller can compose them into its own transaction
(`session.repository.ts:22-33`). M2's repositories do the same; no new
abstraction is introduced for two new tables.

**Config.** `src/core/config/schema.ts` groups keys by concern (`runtime`,
`api`, `auth`, `database`, `oauth`, `probing`, `scheduler`), each merged into
`baseSchema`, with cross-field rules as a trailing `.refine()` chain (a
`path` and a prose `message` per rule, lines 263-312). Numbers are
`z.coerce.number().int().min().max().default()`; booleans are
`z.enum(['true','false']).default(...).transform(v => v === 'true')`, never
`z.boolean()`. `SSRF_GUARD_ENABLED` already exists (`schema.ts:229-232`),
under `probing`, with the comment _"Users supply the URLs this server then
fetches, which is a textbook SSRF primitive."_ It is currently unused by any
code. Decision (D2, §4): M2's save-time guard and M3's connect-time guard
share this one flag — one security policy, two enforcement points, not two
flags that can drift apart. `PROBE_MAX_BODY_BYTES`, `PROBE_MAX_TIMEOUT_MS`
also exist but are M3 concerns (response handling), not read by M2.

**Errors.** `AppError` base (`app-error.ts:9-19`) carries `code`, `message`,
`status`, optional `details`. `QuotaExceededError` (`app-error.ts:41-45`) is
**already defined**, 409, code `QUOTA_EXCEEDED`, and unused anywhere except
its own class and a mapping test — this is exactly B-8's "message states the
limit and the current count" error, via `details`. M2 reuses it rather than
defining a new class. The global filter
(`src/api/common/filters/error.filter.ts:33-41`) logs `{status, code,
method, path, cause}` and responds with only `{code, message, details}` —
internal detail never reaches the response, which is where the secret-header
redaction guarantee (§5.4) has to be proven twice: in the response body
_and_ in whatever the filter logs.

**OpenAPI.** `document.ts` is **hand-maintained**, not decorator-derived —
every new route needs a manual `paths` entry (path, method, tags,
operationId, `requestBody` via `jsonBody(schemaOf(...))`, `responses` via
`errorResponse(...)`). `npm run openapi` regenerates `openapi.yaml`;
`openapi:check` compares. The `openapi:check` bug (item 2 of the small PR):
`src/api/openapi/cli.ts:33`, `readFile(OUTPUT, 'utf8').catch(() => undefined)`
swallows every read error into "missing", not only `ENOENT`.

**Migrations.** `src/core/db/migrations/`: `0001_init` (enum types only),
`0002_accounts` (`users`, `sessions`, `auth_attempts`), `0003_oauth_identities`.
**Next free number: `0004`.** Ordering is by filename
(`src/core/db/migrator/files.ts:19-22`), so the zero-padded prefix matters.
`src/core/db/types.ts` mirrors migrations by hand — a schema change without
a matching `types.ts` change is a standing review rule (AGENTS.md). Existing
table style to match: every FK to `users(id)` is `ON DELETE CASCADE`; every
non-obvious column and constraint carries a one-line "why" comment;
composite unique indexes are declared explicitly rather than inline.

**Secrets — no reversible-encryption precedent exists.** The only
`node:crypto` use in the repo is `session-token.ts` (`createHash('sha256')`,
`randomBytes`, `timingSafeEqual` for the session token hash — one-way,
appropriate for a value only ever _compared_, never re-sent). OAuth stores no
provider tokens at all. **M2's secret headers are different in kind**: a
probe (M3) has to send the header's actual value on the wire, so it must be
**recoverable**, not hashed. There is nothing to reuse; §4 D3 designs this
from scratch.

**Quota/count precedent.** `MAX_SESSIONS_PER_USER` is enforced by
`revokeBeyondNewest` — insert first, then evict the oldest beyond N in one
`UPDATE ... OFFSET`, atomic (`session.repository.ts:121-144`, chosen because
"two concurrent logins cannot each decide a different set is surplus"). That
shape fits _evict-oldest_, not _refuse-new_ — a hard cap needs the opposite:
reject before inserting. The closer precedent is `UserRepository.lockForUpdate`
(`user.repository.ts:143-151`), a `SELECT ... FOR UPDATE` on the user row,
already used by `OAuthService.link` (`oauth.service.ts:218-219`) to
serialize a create-and-count against races, and already documented with the
lock order this plan must preserve: _"a consistent users-first order is what
keeps two transactions that both need both locks from deadlocking"_
(`user.repository.ts` comment above `lockForUpdate`). M2's quota check reuses
this exact pattern (§5.3).

**Module layout precedent.** `src/api/auth/` is the template: module root
(`*.module.ts`, `*.controller.ts`, `*.service.ts`), then `dto/`, `guards/`,
`repositories/`, `services/` (for anything beyond the module's own service),
`utils/` (pure helpers), `e2e/`. M2's module matches this (§4 D8).

### 2.3 Reference implementations

**uptime-kuma.** Headers and every other "sensitive" field
(`basic_auth_pass`, `bearer_token`, `oauth_client_secret`) round-trip in
**cleartext** on every edit-fetch (`Monitor.toJSON(..., includeSensitiveData=true)`,
default `true`, `server/model/monitor.js:115-264`), gated only by ownership,
never masked. This is the opposite of B-4 and the concrete shape of the bug
B-4 exists to prevent. No save-time SSRF check exists at all
(`grep`-confirmed, and the maintainers treat SSRF as explicitly out of scope
for reports). One CVE is directly relevant: **CVE-2024-56331 / GHSA-2qgm-m29m-cj2h**
— the "Real-Browser" monitor type accepts `file:///etc/passwd` as a monitor
URL with no scheme check, an LFI via a missing scheme allowlist at save
time — exactly the class §5.1 rule 1 (scheme allowlist) closes. Tags are
relational and genuinely key:value: `tag(id, name, color)` +
`monitor_tag(monitor_id, tag_id, value)` — `tag.name` is the key,
`monitor_tag.value` the value. Pause is a plain boolean (`active`), history
untouched.

**gatus.** Config-file-driven (admin-authored YAML, not user-submitted CRUD),
so its lack of any SSRF check or header-masking is a different threat model
than probeboard's — not a counter-example, just not applicable. No CVEs
found specific to `TwiN/gatus`.

**openstatus** is the closest analog: multi-tenant SaaS, user-submitted
monitor URLs. Its `packages/utils/src/ssrf.ts` is the direct template for
§5.1 — scheme allowlist, loopback/link-local/RFC1918/CGNAT-adjacent literal
checks, `metadata.google.internal` by name — with one documented limitation
in its own comment: _"a public name that resolves to a private address still
passes"_ (line 86-87) — i.e. **openstatus's guard does not resolve DNS at
all**, only pattern-matches the hostname string. probeboard's guard is
stricter: it resolves and checks every returned address (§5.1 rule 2),
closing exactly the gap openstatus's own comment names. openstatus also
shipped a cautionary tale worth designing around directly: a second, public
API route wrote to the monitors table bypassing the services layer, and the
SSRF call had to be re-added by hand at that second call site
(`apps/server/src/routes/v1/monitors/utils.ts:15-18`). Decision (D6, §4):
**the SSRF check lives in the repository's create/update path, not the
controller** — there must be exactly one way to write a service/endpoint
row, and it cannot be reached without going through the guard. Quota
enforcement (`packages/services/src/limits.ts`) is count-then-compare inside
the same transaction as the insert — same shape chosen for M2's quota, run
under the user-row lock rather than openstatus's workspace-row lock (M2 has
no workspace concept). Its own SSRF-adjacent CVE, **CVE-2026-90486**, was in
an _unrelated_ code path (a custom-domain status-page proxy) that never
called the shared guard at all — reinforcing the single-choke-point decision
rather than contradicting it.

**blackbox_exporter.** Deliberately trusts its caller (Prometheus, on a
trusted network) — `target` comes raw from the scrape query string with no
validation at all, by design (CVE-2020-16248 was disputed by maintainers as
"arguably intended functionality"). Its one useful lesson is the inverse of
uptime-kuma's: its `HTTPProbe.Headers` are plain strings while
`HTTPClientConfig`'s basic-auth password and bearer token use a
`config.Secret` type that redacts to `<secret>` on YAML marshal — and the
`/config` endpoint dumps the whole config verbatim
(`main.go:281-292`). A hand-set `Authorization` header via the generic
`headers:` map is **not** covered by that redaction and leaks in full. The
lesson for M2: "it's a header" is not itself a reason it's covered by
redaction — secrecy has to be an explicit, typed property of the value
(§5.4 D3), never inferred from the header's name or position.

**Cross-repo conclusion:** none of the four reference implementations
actually implements write-only secret headers. B-4 is stricter than any of
them; there is no implementation to copy, only these three cautionary
examples of what happens without it.

### 2.4 SSRF: OWASP guidance, the bypass corpus, and CVE survey

**OWASP SSRF Prevention Cheat Sheet**
(https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html):
don't hand-parse URLs (cites Orange Tsai's parser-differential research);
prefer an allowlist, but for probeboard's case — arbitrary user-registered
endpoints — a denylist of address ranges is the only option, and the cheat
sheet's warning that denylists are inherently bypass-prone is exactly why
§5.1 resolves DNS and checks the platform's own IP-range types rather than
string-matching; validate **after** DNS resolution, every returned address,
not the hostname string; disable redirect-following or re-validate every hop
(not applicable to M2 — no connection is made at save time, but binding on
M3).

**Ground truth on Node's own parsing** (verified directly, Node v24.20.0 —
this is the single most save-time-relevant finding of the whole
investigation): the WHATWG `URL` parser **already canonicalizes** every
numeric IPv4 obfuscation form before user code ever sees `.hostname`:

```
new URL('http://2130706433/').hostname     → '127.0.0.1'   (decimal)
new URL('http://0177.0.0.1/').hostname     → '127.0.0.1'   (octal)
new URL('http://0x7f.1/').hostname         → '127.0.0.1'   (hex, mixed)
new URL('http://127.1/').hostname          → '127.0.0.1'   (short form)
new URL('http://127.0.0.1./').hostname     → '127.0.0.1'   (trailing dot stripped)
new URL('http://EXAMPLE.com/').hostname    → 'example.com' (lowercased)
new URL('http://attacker.com@127.0.0.1/').hostname → '127.0.0.1' (userinfo dropped from hostname)
```

The corollary is a concrete rule for §5.1: **`net.isIP()` is NOT the same
normalization** — `net.isIP('2130706433')`, `net.isIP('0x7f.1')`,
`net.isIP('127.1')`, `net.isIP('127.0.0.1.')` all return `0` (not
recognized). If validation code ever calls `net.isIP` on a raw
attacker-supplied string instead of on `new URL(input).hostname`, every
numeric-obfuscation bypass above evades detection by falling through to "not
an IP literal, go resolve it as a hostname" — which then resolves to
`127.0.0.1` and must still be caught at the post-DNS-resolution check. Two
independent layers therefore both matter: parse through `URL` first (closes
the string-obfuscation class outright, for free, using the platform), then
resolve and range-check every address (closes everything else, including
hostnames that are not IP literals at all).

**IPv4-mapped/compatible IPv6 does not become a clean literal.**
`new URL('http://[::ffff:127.0.0.1]/').hostname` is `'[::ffff:7f00:1]'` — the
last 32 bits re-serialize as IPv6 hex groups, not dotted-decimal. A
substring check for `'127.0.0.1'` misses it. `net.BlockList` (Node ≥15)
handles this correctly and is chosen for the range check itself for exactly
this reason — verified: `bl.addAddress('127.0.0.1','ipv4');
bl.check('::ffff:127.0.0.1','ipv6')` → `true`.

**Full bypass corpus**, each row a test case in §5.6:

| #   | Technique                                   | Payload                                                             | Catch point                                                                                                                              |
| --- | ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Decimal IPv4                                | `http://2130706433/`                                                | `URL.hostname` normalization (free)                                                                                                      |
| 2   | Octal IPv4                                  | `http://0177.0.0.1/`, `http://017700000001/`                        | same                                                                                                                                     |
| 3   | Hex / mixed hex IPv4                        | `http://0x7f.1/`, `http://0x7f000001/`                              | same                                                                                                                                     |
| 4   | Short-form IPv4                             | `http://127.1/`, `http://127.0.1/`                                  | same                                                                                                                                     |
| 5   | IPv4-mapped IPv6                            | `http://[::ffff:127.0.0.1]/`                                        | `net.BlockList` cross-family match                                                                                                       |
| 6   | IPv4-compatible IPv6 (deprecated)           | `http://[::127.0.0.1]/`                                             | same                                                                                                                                     |
| 7   | IPv6 loopback                               | `http://[::1]/`                                                     | `BlockList` `::1/128`                                                                                                                    |
| 8   | IPv6 ULA                                    | `http://[fd12:3456:789a::1]/`                                       | `BlockList` `fc00::/7`                                                                                                                   |
| 9   | IPv6 link-local                             | `http://[fe80::1]/`                                                 | `BlockList` `fe80::/10`                                                                                                                  |
| 10  | Unspecified addresses                       | `http://0.0.0.0/`, `http://[::]/`                                   | explicit literal check — easy to omit from a "private ranges" list since neither is RFC1918 or loopback                                  |
| 11  | AWS/Azure metadata                          | `http://169.254.169.254/`                                           | `BlockList` `169.254.0.0/16` (covers link-local generally)                                                                               |
| 12  | AWS IMDS, IPv6                              | `http://[fd00:ec2::254]/`                                           | explicit `/128`, separate from the IPv4 rule — dual-stack instances are missed by IPv4-only lists                                        |
| 13  | GCP metadata hostname                       | `http://metadata.google.internal/`                                  | resolves to a link-local address — caught **only if DNS is actually resolved**, not by a domain-string denylist                          |
| 14  | Alibaba Cloud metadata                      | `http://100.100.100.200/`                                           | separate explicit literal — not covered by the AWS/GCP rule                                                                              |
| 15  | CGNAT                                       | `http://100.64.1.1/`                                                | `BlockList` `100.64.0.0/10` — commonly missing from RFC1918-only lists                                                                   |
| 16  | Benchmark range                             | `http://198.18.0.1/`                                                | `BlockList` `198.18.0.0/15`                                                                                                              |
| 17  | Multicast / reserved                        | `http://224.0.0.1/`, `http://240.0.0.1/`                            | `BlockList` `224.0.0.0/4`, `240.0.0.0/4`                                                                                                 |
| 18  | Trailing dot                                | `http://127.0.0.1./`                                                | `URL.hostname` strips it; `net.isIP` on the raw string alone would miss it (`net.isIP('127.0.0.1.')` → `0`)                              |
| 19  | Uppercase hostname                          | `http://EXAMPLE.COM/`                                               | `URL.hostname` lowercases; irrelevant to range checks but relevant if any string allowlist is layered on                                 |
| 20  | Userinfo confusion                          | `http://attacker.com@127.0.0.1/`, `http://127.0.0.1#@attacker.com/` | `URL.hostname` correctly isolates the host in both; risk is only in code that regexes the raw string instead                             |
| 21  | Credentials in the URL                      | `http://user:pass@example.com/`                                     | rejected outright — `url.username`/`url.password` non-empty (chapter 7.4 step 1; not an IP-range bypass, a distinct rule)                |
| 22  | Multiple A/AAAA records, one private        | attacker's DNS answers `[8.8.8.8, 127.0.0.1]`                       | `dns.resolve4`/`resolve6` (not `dns.lookup`, which returns one address by default) return **every** record; reject if **any** is blocked |
| 23  | DNS resolution failure                      | unresolvable hostname                                               | reject at save with `URL_UNRESOLVABLE` — nothing to validate against                                                                     |
| 24  | Non-http(s) schemes                         | `file:///etc/passwd`, `gopher://127.0.0.1:6379/...`                 | scheme allowlist, `url.protocol` — this is the exact uptime-kuma CVE-2024-56331 class                                                    |
| 25  | Dangerous ports on an otherwise-public host | `http://public-host.example:6379/`, `:11211`, `:9200`               | port denylist (§5.1 rule 5) — a fully public IP can still front Redis/memcached/Elasticsearch                                            |

**Published SSRF advisories, monitoring/webhook tools specifically** (each
with a URL, from live web research):

- Wekan **GHSA-hc3x-hq3m-663q → GHSA-66m2-4wfr-c45p** (incomplete-fix
  follow-up): the first fix regex-matched `URL.hostname` against private
  ranges but never resolved DNS; the follow-up was needed because an
  attacker registered a public hostname (`169-254-169-254.nip.io`) resolving
  to `169.254.169.254`. This is precisely the gap rule 2 (resolve, don't
  string-match) closes, and precisely the gap openstatus's own guard still
  has (§2.3).
  https://github.com/wekan/wekan/security/advisories/GHSA-66m2-4wfr-c45p
- link-preview-js **CVE-2026-61704**: validated the hostname at
  fetch-initiation, then the underlying HTTP client re-resolved DNS at
  actual connect — the save-time/connect-time TOCTOU class §6 discusses.
  https://securelayer7.net/lab/cve-2026-61704-link-preview-js-dns-rebinding-ssrf-bypass
- Postiz **GHSA-f7jj-p389-4w45**: "TOCTOU DNS rebinding bypasses all SSRF URL
  validation paths" — the advisory's own wording, "all paths," because
  rebinding is architectural, not a missed edge case any one path could have
  caught by being more careful.
  https://github.com/gitroomhq/postiz-app/security/advisories/GHSA-f7jj-p389-4w45
- Craft CMS **GHSA-gp2f-7wcm-5fhx** ("Cloud Metadata SSRF Protection Bypass
  via DNS Rebinding") and mindsdb **GHSA-4jcv-vp96-94xr** — same class again,
  cited to show it recurs across unrelated tools, not a one-off.
- npm library CVEs relevant to _not_ trusting a third-party "is this a
  private IP" library's own string parsing: **CVE-2023-42282** (`ip`
  package, `isPublic()` misses `0x7f.1`) and **CVE-2026-69192** (`ip-address`
  package, octal-vs-decimal parser differential against the system
  resolver). §4 D1 decides against any such library for exactly this reason
  — resolve with Node's own `dns` module, range-check with Node's own
  `net.BlockList`, trust neither a third-party parser's opinion of the raw
  string.

## 3. Data model

Migration `0004_registration`, matching `.down.sql`, matching
`src/core/db/types.ts` update, in the same PR (§8 PR1).

```sql
CREATE TABLE services (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        text        NOT NULL,
    -- Origin only: scheme + host [+ port]. No path -- that is what makes
    -- "one endpoint, one service" (B-3) well-defined: two URLs share a
    -- service iff they share this string.
    base_url    text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_user_id_idx ON services (user_id);
-- B-3: "already exists for this user" is this exact index.
CREATE UNIQUE INDEX services_user_base_url_key ON services (user_id, base_url);

CREATE TABLE endpoints (
    id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id            uuid           NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    -- Denormalized from services.user_id. Every quota and ownership query
    -- would otherwise need a join through services; the quota lock (§5.3)
    -- takes it directly. Kept in sync only at insert -- an endpoint never
    -- moves to a different service.
    user_id               uuid           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    method                text           NOT NULL DEFAULT 'GET',
    path                  text           NOT NULL DEFAULT '/',
    interval_s            integer        NOT NULL DEFAULT 60,
    timeout_ms            integer        NOT NULL DEFAULT 10000,
    -- [{min,max}, ...], default [{200,299}]. Validated at the DTO, stored
    -- as-is -- M3 is the only consumer that interprets it.
    expected_status       jsonb          NOT NULL DEFAULT '[{"min":200,"max":299}]',
    latency_warn_ms       integer,
    failure_threshold     smallint       NOT NULL DEFAULT 3,
    success_threshold     smallint       NOT NULL DEFAULT 2,
    follow_redirects      boolean        NOT NULL DEFAULT true,
    max_redirects         smallint       NOT NULL DEFAULT 5,
    -- Structured, versioned (architecture §7.11 ADR-5) -- not a string DSL.
    assertions            jsonb          NOT NULL DEFAULT '[]',
    enabled               boolean        NOT NULL DEFAULT true,   -- pause/resume, FR-9
    created_at            timestamptz    NOT NULL DEFAULT now(),
    updated_at            timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX endpoints_service_id_idx ON endpoints (service_id);
-- The quota lock and count both filter on this directly (§5.3).
CREATE INDEX endpoints_user_id_idx ON endpoints (user_id);
-- FR-2/B-2: one method+path pair per service, not a hard requirement in the
-- PRD, but two endpoints resolving to the identical effective URL is a
-- product bug (duplicate monitoring of the same thing) worth preventing at
-- the schema rather than relying on client discipline.
CREATE UNIQUE INDEX endpoints_service_method_path_key ON endpoints (service_id, method, path);

-- One row per header, on either a service or an endpoint, never both --
-- enforced by exactly one of the two FKs being non-null (CHECK below).
CREATE TABLE headers (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id         uuid        REFERENCES services (id) ON DELETE CASCADE,
    endpoint_id        uuid        REFERENCES endpoints (id) ON DELETE CASCADE,
    -- Case-insensitive override by name (B-4) is enforced in the app layer
    -- at merge time (§5.5), not by a citext column here -- the raw casing
    -- the user typed is worth keeping for display.
    name               text        NOT NULL,
    is_secret          boolean     NOT NULL DEFAULT false,
    -- Exactly one of (value, secret_ciphertext) is non-null, matching
    -- is_secret -- enforced by CHECK, not only by application code.
    value              text,
    secret_ciphertext  bytea,
    secret_iv          bytea,
    secret_auth_tag    bytea,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK ((service_id IS NULL) <> (endpoint_id IS NULL)),
    CHECK (
        (is_secret AND value IS NULL AND secret_ciphertext IS NOT NULL
                    AND secret_iv IS NOT NULL AND secret_auth_tag IS NOT NULL)
        OR
        (NOT is_secret AND value IS NOT NULL AND secret_ciphertext IS NULL
                        AND secret_iv IS NULL AND secret_auth_tag IS NULL)
    )
);
CREATE INDEX headers_service_id_idx ON headers (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX headers_endpoint_id_idx ON headers (endpoint_id) WHERE endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX headers_service_name_key ON headers (service_id, lower(name)) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX headers_endpoint_name_key ON headers (endpoint_id, lower(name)) WHERE endpoint_id IS NOT NULL;

-- key:value tags (B-5), on either a service or an endpoint. Relational, per
-- the uptime-kuma/openstatus precedent, not a jsonb column -- filtering
-- ("everywhere", per B-5) needs an index, and jsonb containment indexes on
-- a hot list-query path are worse than a plain btree here.
CREATE TABLE tags (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  uuid        REFERENCES services (id) ON DELETE CASCADE,
    endpoint_id uuid        REFERENCES endpoints (id) ON DELETE CASCADE,
    key         text        NOT NULL,
    value       text        NOT NULL,
    CHECK ((service_id IS NULL) <> (endpoint_id IS NULL))
);
CREATE INDEX tags_service_id_idx ON tags (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX tags_endpoint_id_idx ON tags (endpoint_id) WHERE endpoint_id IS NOT NULL;
-- The filter query: "services with tag key=value". One index serves it
-- for both owners via the two partial variants above plus this composite.
CREATE INDEX tags_key_value_idx ON tags (key, value);
CREATE UNIQUE INDEX tags_service_key_key ON tags (service_id, key) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX tags_endpoint_key_key ON tags (endpoint_id, key) WHERE endpoint_id IS NOT NULL;
```

Notes that are decisions, not detail:

- `endpoints.user_id` is denormalized from `services.user_id`. Rejected
  alternative: join through `services` on every quota/ownership query. The
  duplication is written once at insert (an endpoint's service never
  changes, so nothing keeps it in sync later) and buys the quota lock (§5.3)
  a single-table `WHERE user_id = $1` instead of a join inside a locked
  transaction.
- One `headers` table, not two (`service_headers`/`endpoint_headers`).
  Rejected because it doubles the encryption/redaction code path for no
  benefit — the row shape and every invariant (secret XOR plaintext, one
  parent XOR the other) are identical; only the FK target differs, which a
  `CHECK` enforces as cleanly as two tables would.
- `expected_status`, `assertions` are `jsonb` with a versioned schema
  validated at the DTO layer (Zod), stored opaquely. M2 does not interpret
  them; M3's assertion evaluator (chapter 7.9) is their first real reader.
  This mirrors architecture ADR-5 ("structured versioned assertions").

## 4. Decisions

| #   | Decision                                                                                                                                    | Rejected                                                             | Because                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Resolve DNS with `node:dns/promises` `resolve4`/`resolve6`; range-check with `node:net`'s `BlockList`                                       | A third-party "is this a private IP" npm package                     | Every such library has shipped its own parser-differential CVE (`ip` CVE-2023-42282, `ip-address` CVE-2026-69192); `BlockList` is platform-native, handles IPv4-mapped IPv6 cross-family matching correctly (verified), needs no dependency                                         |
| D2  | Reuse `SSRF_GUARD_ENABLED` for both M2's save-time guard and M3's connect-time guard                                                        | A second, M2-only flag                                               | One security policy; two flags invite them drifting apart, and the existing comment ("users supply the URLs this server then fetches") already describes both                                                                                                                       |
| D3  | Secret header values: AES-256-GCM, key from a new `HEADER_ENCRYPTION_KEY` config value, validated (length, decodability) at boot            | Store secrets hashed, like session tokens                            | A probe (M3) must send the actual value on the wire — hashing is one-way and useless here; there is no existing reversible-encryption utility to reuse (§2.2), so this is new                                                                                                       |
| D4  | Quota enforced inside a transaction that locks the **user** row first (`users.lockForUpdate`), then counts, then inserts                    | A separate `COUNT` query before `INSERT`, no lock                    | The two-step form is exactly the race the auth module's own comment on rate limiting warns about — "checking and then recording as separate steps let a parallel burst through: measured, twenty concurrent attempts were admitted against a cap of five" (`rate-limit.service.ts`) |
| D5  | B-3: if a service already exists for this user at the same normalized origin, attach the new endpoint to it instead of creating a duplicate | Always create a new service                                          | PRD §6.2: "a service with exactly one endpoint is the degenerate case" — the implicit flow is sugar over the explicit one, and silent duplicate services are a worse UX than the alternative                                                                                        |
| D6  | The SSRF check and the quota check both live in the **repository's** create/update method, not the controller or a pipe                     | A validation pipe/interceptor at the HTTP layer                      | openstatus shipped a second write path (a public API route) that bypassed its own guard because the guard lived at the wrong layer (§2.3); one write path through the repository closes that class structurally                                                                     |
| D7  | Case-insensitive header override by name (B-4) resolved in the application layer at read/merge time, not by a `citext` column               | `citext` extension                                                   | Same reasoning M1 already recorded for `users.email` — one fewer extension, and the raw casing is worth keeping for display                                                                                                                                                         |
| D8  | One module, `src/api/registration/`, with `services/` and `endpoints/` sub-folders                                                          | Two top-level modules, per architecture chapter 7.9's literal layout | CLAUDE.md's binding rule ("deleting a feature is deleting one folder") outranks the architecture chapter's proposed layout; services and endpoints share one SSRF guard, one quota, one tag model and cannot be deleted independently                                               |
| D9  | Delete is an unconditional hard `DELETE`, cascading via FK                                                                                  | A soft-delete / confirmation token protocol                          | There is no probe history to protect yet (§2.1); building confirmation machinery for a case that doesn't exist until M5 is speculative                                                                                                                                              |
| D10 | Header/URL validation happens on every **save** — create and update alike, never only at create                                             | Trust an unmodified field on `PATCH`                                 | An update that changes only the name but replays an old, now-private `baseUrl` must still be caught; re-validating everything unconditionally is one code path instead of a diff-aware one                                                                                          |

## 5. HTTP surface, and the rules behind it

### 5.1 SSRF guard — `src/core/ssrf/`

Lives in `core` (shared by `api`'s save-time check now and `worker`'s
connect-time check from M3 on), as a pure module with no DB, no framework
dependency — matching the "probe executor is a pure function" rule
(AGENTS.md structure section) one level early.

```ts
async function assertSaveableUrl(rawUrl: string, cfg: SsrfConfig): Promise<ValidatedUrl>;
```

Five checks, all required, run in this order (each one a distinct reason to
reject, each with its own error code so the message is actionable — B-7:
"rejected... with a plain explanation, not a stack trace"):

1. **Parse with `new URL()`.** Not `http:`/`https:` → `SCHEME_NOT_ALLOWED`.
   `url.username`/`url.password` non-empty → `CREDENTIALS_IN_URL`. Port, if
   present, in the denylist (`SSRF_BLOCKED_PORTS`, default includes 25, 111,
   135, 139, 445, 1433, 1521, 2375, 2376, 3306, 3389, 5432, 5984, 6379, 7000,
   9200, 9300, 11211, 27017) → `PORT_NOT_ALLOWED`.
2. **Resolve.** `dns.promises.resolve4(hostname)` and `resolve6(hostname)` in
   parallel (not `dns.lookup`, which returns one address). Both empty/error
   with no addresses at all → `URL_UNRESOLVABLE`.
3. **Classify every returned address** against a `net.BlockList` pre-loaded
   with: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
   `169.254.0.0/16`, `100.64.0.0/10`, `198.18.0.0/15`, `224.0.0.0/4`,
   `240.0.0.0/4`, `0.0.0.0/32`, `::1/128`, `::/128`, `fc00::/7`, `fe80::/10`,
   `fd00:ec2::254/128` (AWS IPv6 metadata), plus IPv4-mapped/compatible
   forms (handled automatically by `BlockList`'s cross-family check, §2.4).
   Any hit → `ADDRESS_NOT_ALLOWED`, with the offending address in `details`
   (not the response message — the message stays generic per B-7's "plain
   explanation", the address goes in `details` for the UI to render as
   "this resolves to a private address").
4. **Named-host special cases** not caught by IP classification because the
   name itself is the signal: `metadata.google.internal` (and its
   `.internal`/`metadata.internal` variants) rejected outright even before
   resolving, since the whole point is a hostname whose _only_ job is
   resolving to link-local.
5. Return the normalized `{ hostname, addresses, port }` for the caller to
   store `base_url`/`path` from — never store the raw attacker string as the
   canonical form; store what was actually validated.

`SSRF_GUARD_ENABLED=false` short-circuits to "always valid" — existing flag,
existing comment: _"False is for tests against a local server only."_ Used
by this plan's own integration tests that need to hit `127.0.0.1` (the test
harness's own Postgres/HTTP fixtures), and nowhere else.

### 5.2 Header validation — `src/api/registration/services/header-validation.service.ts`

Independent of SSRF (headers are not URLs), but same "at save" timing:

- **Forbidden names** (case-insensitive): `Host`, `Content-Length`,
  `Transfer-Encoding`, `Connection`, `Upgrade`, `Expect`, `TE`, `Trailer` —
  the NFR-15 smuggling/override surface. Rejected with `HEADER_NOT_ALLOWED`.
- **CR/LF injection**: any header name or non-secret value containing `\r`
  or `\n` rejected with `HEADER_INVALID` — a classic header-splitting
  vector, and cheap to catch before it ever reaches the DB (secret values
  are checked the same way before encryption, §5.4, so the check applies
  identically to something that will never be displayed).
- **Size and count caps**: `MAX_HEADERS_PER_OWNER` (default 20, service and
  endpoint counted separately), `MAX_HEADER_NAME_BYTES` (256),
  `MAX_HEADER_VALUE_BYTES` (4096) — all new config, bounded and tested.
- **Override by name** (B-4): resolved at _read_ time, not stored
  pre-merged — an endpoint's effective headers are computed as
  `{...serviceHeaders, ...endpointHeaders}` keyed by `lower(name)`, endpoint
  wins. Storing pre-merged headers would mean every service header edit has
  to fan out and rewrite every endpoint's copy; computing it on read is one
  join and stays correct automatically when either side changes.

### 5.3 Quota — `EndpointsRepository.create`

```ts
return this.db.kysely.transaction().execute(async (trx) => {
  await this.users.lockForUpdate(userId, trx);        // users-first lock order, matching auth's own rule
  const { count } = await trx
    .selectFrom('endpoints')
    .select(({ fn }) => [fn.count<number>('id').as('count')])
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  if (count >= cfg.ENDPOINT_QUOTA_PER_USER) {
    throw new QuotaExceededError(
      `endpoint quota reached: ${count} of ${cfg.ENDPOINT_QUOTA_PER_USER} used`,
      { limit: cfg.ENDPOINT_QUOTA_PER_USER, count },
    );
  }
  return this.insertEndpointRow(trx, ...);
});
```

New config: `ENDPOINT_QUOTA_PER_USER`, `z.coerce.number().int().min(1).max(100000).default(100)`.
`QuotaExceededError` already exists (409, `QUOTA_EXCEEDED`) and its
`details` already carries exactly what B-8 asks for — no new error class.

### 5.4 Secret headers — write-only

**Storage.** AES-256-GCM. `HEADER_ENCRYPTION_KEY`: a new config value, 32
raw bytes base64-encoded, validated at boot (`z.string().refine(v =>
Buffer.from(v, 'base64').length === 32)`) — a process that starts with a
wrong-length key fails at boot, not at the first secret header write, same
rule as every other config value. Each value gets a fresh random 12-byte IV
(`randomBytes(12)`); `secret_iv` and `secret_auth_tag` (GCM's tag, 16 bytes)
are stored alongside `secret_ciphertext`, all `bytea`. No key rotation
mechanism in M2 — a single active key, out of scope, worth an ADR note that
rotation means re-encrypting every row, not a config bump.

**Never returned by any read.** Every DTO that serializes a header
out — service GET, endpoint GET, the effective-headers computation in §5.2 —
returns `{name, isSecret: true}` for a secret header, no `value` key at all,
not even a masked placeholder string (a placeholder like `"••••"` is still a
value the client could mistake for real and forward somewhere). The
serializer is a single shared function (`toHeaderDto`), not reimplemented
per endpoint, so there is exactly one place this guarantee can break.

**PATCH semantics (keep / replace / clear).** The request body's `headers`
array is a **full replacement list** for that owner (service or endpoint),
same shape as create. Each entry:

- `{name, value, isSecret: false}` — plain header, stored/updated as given.
- `{name, value, isSecret: true}` — **replace**: encrypt `value`, discard
  whatever ciphertext existed for that name.
- `{name, isSecret: true}` — **keep**: no `value` key present at all means
  "leave the existing secret's ciphertext untouched." This is the only way
  a client can submit a PATCH that includes a secret header without ever
  having seen its plaintext — exactly what "write-only" requires structurally,
  not just as a response-shaping rule.
- Omitting a previously-existing name from the array — **clear**: deleted,
  same as an explicit removal.

**Never logged.** `describeError` (existing, `src/core/errors/describe.ts`)
is reused for any error this module raises — it never receives the raw
header value, only the header _name_, in every log statement and every
thrown error's `details`. Proven by test (§5.6): trigger a decryption
failure (corrupt ciphertext) and a validation failure (CRLF in a value)
with the log captured, assert the plaintext value string appears in no
emitted line, request log included — the same class of gap the OAuth plan's
D12 found and fixed for authorization codes (`req.url` carrying a secret
that a field-redaction list alone doesn't reach). Secret header values never
appear in a URL, so this is a narrower proof than D12's, but the discipline
of proving it by running a real request with the log captured, not asserting
on the redaction list's contents, is the same.

### 5.5 Endpoints

| Method   | Path                         | Notes                                                                                                                                            |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/v1/services`               | `{name, baseUrl, headers?, tags?}` **or** `{url, name?, headers?, tags?}` — B-3's implicit form, discriminated by presence of `url` vs `baseUrl` |
| `GET`    | `/v1/services`               | Paginated (cursor, per API surface contract), `?tag=key:value` filter                                                                            |
| `GET`    | `/v1/services/:id`           | 404 for another user's id                                                                                                                        |
| `PATCH`  | `/v1/services/:id`           | Re-validates `baseUrl` and every header if present (D10)                                                                                         |
| `DELETE` | `/v1/services/:id`           | Cascades to its endpoints, headers, tags (D9)                                                                                                    |
| `POST`   | `/v1/services/:id/endpoints` | `{method, path, headers?, tags?, interval?, timeout?, ...}`, quota-checked (§5.3)                                                                |
| `GET`    | `/v1/endpoints/:id`          |                                                                                                                                                  |
| `PATCH`  | `/v1/endpoints/:id`          | Re-validates effective URL (base + path) and headers (D10)                                                                                       |
| `DELETE` | `/v1/endpoints/:id`          |                                                                                                                                                  |
| `POST`   | `/v1/endpoints/:id/pause`    | `enabled = false`                                                                                                                                |
| `POST`   | `/v1/endpoints/:id/resume`   | `enabled = true`                                                                                                                                 |

Not added in M2, despite appearing in chapter 7's full API surface list:
`GET /services/:id/health`, `/endpoints/:id/check-now`, `/results`,
`/stats`, `/uptime`, `/incidents` — all read data that does not exist until
M3–M6.

Every list endpoint paginated with a cursor and bounded `limit`, per the
architecture chapter's contract rule — same shape M1 has no precedent for
yet (M1 has no list endpoints), so this introduces the pattern; kept
minimal (opaque cursor = last id, `limit` capped at e.g. 100).

**Status codes and codes**, beyond the ones M1 already established
(`NOT_FOUND` 404, `VALIDATION_FAILED` 400):

| Code                  | Status | When                                                            |
| --------------------- | ------ | --------------------------------------------------------------- |
| `SCHEME_NOT_ALLOWED`  | 400    | non-http(s) scheme                                              |
| `CREDENTIALS_IN_URL`  | 400    | `user:pass@host` present                                        |
| `PORT_NOT_ALLOWED`    | 400    | port in the denylist                                            |
| `URL_UNRESOLVABLE`    | 400    | DNS resolution returned no addresses                            |
| `ADDRESS_NOT_ALLOWED` | 400    | a resolved address is private/loopback/link-local/metadata/etc. |
| `HEADER_NOT_ALLOWED`  | 400    | forbidden header name (Host, Content-Length, ...)               |
| `HEADER_INVALID`      | 400    | CR/LF or other invalid bytes in a name/value                    |
| `QUOTA_EXCEEDED`      | 409    | endpoint quota reached (existing error class)                   |
| `CONFLICT` (service)  | 409    | duplicate `(service_id, method, path)`                          |

## 6. SSRF: where save-time stops being a security boundary

**Save-time validation alone is not a complete security boundary, and this
plan does not claim otherwise.** The mechanism is DNS TOCTOU: M2 resolves a
hostname once, at the moment a service or endpoint is saved, and validates
that resolution. Nothing enforces that a _later_ connection — the actual
probe, in M3 — resolves to the same address. A hostname under attacker
control (which every registered endpoint's hostname inherently is, since
users register arbitrary third-party APIs) can answer with a public,
benign IP at the moment probeboard validates it, then flip its DNS answer
to `169.254.169.254` or `127.0.0.1` before the low-TTL record expires and
the real probe connects. The check and the use are two independent DNS
resolutions separated in time, and DNS itself is the attacker's lever to
make them diverge.

This is not hypothetical: **NCC Group's "Singularity of Origin"** tooling
(introduced DEF CON 27, 2019) automates exactly this attack —
authoritative DNS plus a payload host that flips the answer at the right
moment
(https://www.nccgroup.com/research-blog/state-of-dns-rebinding-in-2023/,
which also lists concrete CVEs the technique produced: Node.js itself
CVE-2022-32212, WordPress CVE-2022-3590, Appsmith CVE-2022-4096, Tailscale
CVE-2022-41924). Closer to probeboard's own domain: **Postiz's
GHSA-f7jj-p389-4w45** is titled, in the advisory's own words, "TOCTOU DNS
rebinding bypasses **all** SSRF URL validation paths" — because the flaw is
architectural, not a gap any one validation function could close by being
more thorough. **link-preview-js CVE-2026-61704** is the same shape in a
tool closer to probeboard's own (URL-fetching, not monitoring, but the same
validate-then-fetch pattern).

**The line is exactly this: M2 validates at save; M3 pins.** Chapter 7.4's
four-step guard — "1. reject scheme/credentials/port. 2. resolve DNS,
collect every address. 3. classify every address. 4. **pin the connection**
to a validated IP with a custom undici dispatcher" — describes the complete
guard, and step 4 is the step that actually closes rebinding, because it
makes the address that was checked the address the socket is forced to
connect to, regardless of what DNS answers next. M2 implements steps 1–3
only, reused verbatim by M3 (§4 D1 — same `core/ssrf` module, same
`BlockList`), because a save-time check with no connection to pin is by
definition unable to do step 4; it is not a smaller version of the same
guard, it is genuinely a different guard for a different moment, and this
plan's own test matrix (§5.6) never claims save-time validation closes
rebinding — every rebinding-shaped test case is explicitly listed as **out
of scope for M2, scheduled for M3's `probe.executor.ts` integration tests**
against a DNS fixture that can be made to answer differently on a second
query.

## 7. Test matrix

Every row is a test that must fail when its guard is removed (`prove by
removal`, CLAUDE.md), not just pass when it's present.

| Property                                                                                          | Proof                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every corpus item in §2.4's table is rejected                                                     | One parameterized integration test per row (25 rows), asserting `ADDRESS_NOT_ALLOWED`/`SCHEME_NOT_ALLOWED`/etc. and that no `services`/`endpoints` row was inserted                                                                                             |
| A hostname with mixed public/private A records is rejected                                        | DNS test double returns `[8.8.8.8, 127.0.0.1]`; assert rejection, and that removing "check every address" (checking only the first) makes it pass — a deliberate removal test                                                                                   |
| DNS failure at save is rejected, not silently allowed                                             | Test double returns `NXDOMAIN`; assert `URL_UNRESOLVABLE`                                                                                                                                                                                                       |
| `SSRF_GUARD_ENABLED=false` disables the guard                                                     | Config toggled in a test app instance; a private-IP URL is accepted — proves the flag actually gates the code path, not just exists                                                                                                                             |
| Update re-validates, not only create                                                              | Create a service with a public URL, `PATCH` its `baseUrl` to a private one, expect rejection — proves D10                                                                                                                                                       |
| Forbidden headers rejected                                                                        | `Host`, `Content-Length`, `Transfer-Encoding` each attempted, each rejected, case-insensitively (`host`, `HOST`)                                                                                                                                                |
| CRLF in a header name or value rejected                                                           | `X-Foo\r\nX-Injected: evil` as a value; rejected before reaching encryption or storage                                                                                                                                                                          |
| Header count/size caps enforced                                                                   | One over `MAX_HEADERS_PER_OWNER`, one over `MAX_HEADER_VALUE_BYTES`, each rejected                                                                                                                                                                              |
| Endpoint header overrides service header by name, case-insensitively                              | Service sets `X-Api-Key`, endpoint sets `x-api-key`; effective headers show only the endpoint's value                                                                                                                                                           |
| Secret header value never returned by any read                                                    | Create with a secret header; `GET` the service, `GET` the endpoint, and the create response itself — assert `value` key absent everywhere, only `{name, isSecret:true}`                                                                                         |
| Secret header value never logged                                                                  | Force a decryption failure (corrupt ciphertext) and a validation failure on a secret value, log captured both times; assert the plaintext appears in no line                                                                                                    |
| Secret header value never in an error response                                                    | Same corrupted-ciphertext case; assert the HTTP response body contains no plaintext, only the stable error code                                                                                                                                                 |
| Secret header value never in an OpenAPI example                                                   | `document.ts` review: no literal secret example strings; generated `openapi.yaml` diffed for this                                                                                                                                                               |
| PATCH "keep" leaves a secret's ciphertext untouched                                               | Create with a secret; `PATCH` omitting `value` for that header name; re-fetch (as ciphertext existence, not plaintext) unchanged                                                                                                                                |
| PATCH "replace" changes a secret's ciphertext                                                     | `PATCH` with a new `value` for an existing secret name; the stored ciphertext differs from before (via a repository-level test with DB access, not the HTTP API, since the API never reveals plaintext)                                                         |
| PATCH "clear" removes a header entirely                                                           | Omit a previously-present header name from the PATCH array; it is gone from the effective set                                                                                                                                                                   |
| Endpoint quota rejects the Nth+1 endpoint                                                         | Create up to `ENDPOINT_QUOTA_PER_USER`, the next `POST` returns `QUOTA_EXCEEDED` with `{limit, count}` matching                                                                                                                                                 |
| Quota holds under concurrency                                                                     | Two creates fired at limit-1 with an explicit barrier (a second connection holds the lock open until both requests are in flight, per CLAUDE.md's "force races with an explicit barrier... rather than hoping `Promise.all` interleaves"); exactly one succeeds |
| Pausing an endpoint sets `enabled=false` and it is excluded from... (nothing yet — M3+)           | `enabled` flag round-trips through pause/resume; documented as inert until M3/M4 read it                                                                                                                                                                        |
| Ownership: every route, 404 not 403 for another user's id                                         | Read, update, delete, pause/resume, and the nested `/services/:id/endpoints` create — each tested against a second user's id                                                                                                                                    |
| B-3: pasting a URL with an existing-origin service attaches, does not duplicate                   | Create explicit service at origin X; `POST /services` with a full URL at origin X; assert one service, two endpoints                                                                                                                                            |
| B-3: pasting a URL with a new origin creates both                                                 | `POST /services {url: "https://new.example.com/orders"}`; assert a new service + one endpoint in one transaction                                                                                                                                                |
| Delete cascades to headers and tags                                                               | Delete a service with secret headers and tags; all child rows gone (repository-level check)                                                                                                                                                                     |
| Duplicate `(service_id, method, path)` rejected                                                   | Two `POST .../endpoints` with the same method+path; second gets `409 CONFLICT`                                                                                                                                                                                  |
| Config bounds: `ENDPOINT_QUOTA_PER_USER`, `HEADER_ENCRYPTION_KEY` length, `MAX_HEADERS_PER_OWNER` | Boot with an out-of-range/invalid value; process refuses to start, per the existing config-validation convention                                                                                                                                                |

## 8. Delivery

Five PRs, ordered so nothing merges untestable on its own — same rationale
M1 and social login both used.

**PR 1 — schema and types.** Migration `0004`, `types.ts`, the
`services`/`endpoints`/`headers`/`tags` repositories (no SSRF, no
encryption, no HTTP — plain CRUD against the schema, unit + integration
tested). Establishes the ownership/quota query shapes §5.3 depends on.

**PR 2 — the SSRF guard.** `src/core/ssrf/`, config additions
(`SSRF_BLOCKED_PORTS`), the full §2.4/§5.1 bypass-corpus test suite. No
HTTP, no encryption, no controller — reviewable on its own, like social
login's linking-policy PR.

**PR 3 — secret header encryption.** `src/core/crypto/header-cipher.ts`
(AES-256-GCM encrypt/decrypt), `HEADER_ENCRYPTION_KEY` config +
boot-time validation, the redaction-proof tests of §5.6 (log, error,
response). No controller yet — testable directly against the cipher and a
stub repository row.

**PR 4 — services and endpoints CRUD.** `src/api/registration/` module:
controllers, services (header merge/override, B-3 implicit creation, quota
call, SSRF call), DTOs, `SessionGuard` reuse, `http/services.http` and
`http/endpoints.http`, `npm run openapi` regenerated. Wires PR1–3 together
behind HTTP; end-to-end tests against a running server.

**PR 5 — tags and filtering.** `?tag=key:value` query support on both list
endpoints, tag CRUD folded into the create/update DTOs of PR4 (a service or
endpoint's `tags` array is part of its own create/update payload, not a
separate endpoint) — kept as its own PR because it is the one piece with no
security surface and is cheap to review in isolation after PR4 lands the
harder parts.

## 9. The small PR — independent of this plan

Does not depend on plan approval; can proceed once this plan PR is up.

1. `src/api/openapi/document.ts`: add `413` to `POST /v1/auth/password`'s
   response block (it currently has `400/401/409/429` but not `413`, while
   `register`/`login` do list it), matching the existing body-limit
   behaviour already present for those two routes. `npm run openapi`
   regenerated.
2. `src/api/openapi/cli.ts:33`: replace `.catch(() => undefined)` with a
   check for `(err as NodeJS.ErrnoException).code === 'ENOENT'` — rethrow
   anything else, so a permission error or I/O failure surfaces with its
   cause instead of being reported as "openapi.yaml is missing."
3. `docker-compose.yml`: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` read via
   `${GOOGLE_CLIENT_ID:-placeholder}` etc. from the gitignored `.env`, not
   hardcoded. `.env.example` documents each. Verified two ways: (a) with no
   `.env`, `docker compose up -d --build` boots on placeholders and OAuth
   endpoints respond as configured-but-unusable (`OAUTH_ENABLED=false`
   effectively, or the existing "id set without secret fails at boot"
   cross-field check stays satisfied by placeholders matching on both sides);
   (b) with a `.env` holding dummy GitHub values,
   `/v1/auth/oauth/github/start` redirects to `github.com` carrying that
   `client_id`.

## 10. Tensions to resolve before coding

**Quota counts endpoints, not services — is an unbounded number of empty
services a problem?** A user could create hundreds of zero-endpoint
services without ever touching the quota. Nothing in FR-16/B-8 caps
services directly, and B-3's implicit-creation flow relies on services
being cheap. Proposal: leave uncapped in M2, worth a one-line note in the
evaluation chapter if it ever needs revisiting — an abuse vector here is
storage noise, not the SSRF-class harm the rest of this plan defends
against.

**`ENDPOINT_QUOTA_PER_USER` default (100) is a guess.** Nothing in the PRD
sizes it. Configurable per B-8, so the number itself is low-stakes to get
wrong; 100 is chosen as comfortably above what a solo developer or small
team (the PRD's stated primary user, §6.1) would register, comfortably
below anything that stresses NFR-6's 500-monitor target for a single
deployment shared across users.

**Header encryption key management is minimal by design, and should be said
out loud.** One key, one config value, no rotation, no KMS integration.
Correct for a thesis project's threat model (a single deployment, not a
multi-tenant SaaS with a real key-management requirement) but worth an ADR
note precisely because "add rotation" is the obvious first thing a real
deployment would need next.

**Is `POST /v1/services` with a discriminated body (`baseUrl` vs `url`)
the right shape, or should B-3 be a separate endpoint** (e.g. `POST
/v1/services/from-url`)? Proposal: one endpoint, discriminated body — B-3's
own acceptance criterion is "never more than one form," and a second
endpoint for the same underlying operation risks becoming a second form in
disguise (two client code paths that must be kept behaviorally identical
forever). Revisit if the two cases turn out to need genuinely different
response shapes once M9 builds the actual form.

## Sources

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Node.js `net.BlockList`](https://nodejs.org/api/net.html#class-netblocklist), [`net.isIP`](https://nodejs.org/api/net.html#netisipinput), [WHATWG URL IPv4 parser](https://url.spec.whatwg.org/#concept-ipv4-parser) — all behaviour above independently verified against Node v24.20.0, not taken from documentation alone
- [NCC Group — State of DNS rebinding in 2023](https://www.nccgroup.com/research-blog/state-of-dns-rebinding-in-2023/) (Singularity of Origin, CVE-2022-32212/3590/4096/41924)
- [Wekan GHSA-66m2-4wfr-c45p](https://github.com/wekan/wekan/security/advisories/GHSA-66m2-4wfr-c45p) — incomplete-fix follow-up, hostname-string vs. DNS-resolved check
- [Postiz GHSA-f7jj-p389-4w45](https://github.com/gitroomhq/postiz-app/security/advisories/GHSA-f7jj-p389-4w45) — TOCTOU DNS rebinding, "all SSRF URL validation paths"
- [link-preview-js CVE-2026-61704](https://securelayer7.net/lab/cve-2026-61704-link-preview-js-dns-rebinding-ssrf-bypass)
- [Craft CMS GHSA-gp2f-7wcm-5fhx](https://github.com/craftcms/cms/security/advisories/GHSA-gp2f-7wcm-5fhx), [mindsdb GHSA-4jcv-vp96-94xr](https://github.com/mindsdb/mindsdb/security/advisories/GHSA-4jcv-vp96-94xr)
- [Uptime Kuma GHSA-2qgm-m29m-cj2h / CVE-2024-56331](https://github.com/louislam/uptime-kuma/security/advisories/GHSA-2qgm-m29m-cj2h) — missing scheme allowlist, `file://` LFI via monitor URL
- [openstatus](https://github.com/openstatushq/openstatus) `packages/utils/src/ssrf.ts`, `packages/services/src/limits.ts`, `packages/services/src/monitor/{create,update}.ts` — local clone, read directly
- [openstatus CVE-2026-90486](https://www.strix.ai/cve/CVE-2026-90486) — unrelated code path bypassing the shared guard
- [blackbox_exporter](https://github.com/prometheus/blackbox_exporter) `config/config.go`, `main.go` — local clone; [CVE-2020-16248](https://nvd.nist.gov/vuln/detail/CVE-2020-16248) (disputed, trusted-network design)
- [npm `ip` CVE-2023-42282](https://cosmosofcyberspace.github.io/npm_ip_cve/npm_ip_cve.html), [npm `ip-address` CVE-2026-69192](https://cvereports.com/reports/CVE-2026-69192)
- `docs/m1-plan.md`, `docs/social-login-plan.md` — this repository's own prior plans, for precedent on lock ordering, atomic quota enforcement, and delivery structure
