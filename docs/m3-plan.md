# M3 — Probe executor: implementation plan

Delivers FR-18…FR-22, NFR-5, NFR-11, NFR-13 (`docs/tracker.md`, `probeboard-docs/en/08-plan.md`
row M3). A pure `probe()` function: phase boundaries, the failure taxonomy,
assertions, the connect-time SSRF guard with IP pinning, a bounded body. Exit
criterion: probe one URL from a test, every failure class reproduced locally.
Nothing here schedules, persists, or evaluates incidents — M4/M5/M6.

## 1. Scope

| In                                                                          | Out, and why                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `probe(config, deps): Promise<ProbeOutcome>` — pure, no DB, no scheduler    | Scheduling, leases, `endpoint_runtime`, claim loop — M4 (FR-17, NFR-1…4/7)       |
| Absolute phase-boundary timestamps, derived `total_ms`/`dns_ms`/etc.        | Persisting `probe_results`, aggregates, retention — M5 (NFR-8/9)                 |
| Failure taxonomy: 14 classes (`03-api-health.md` §3.4), Node-signal mapping | Incident state machine, `UNKNOWN` sweep, maintenance windows — M6                |
| Assertions: `body_contains`, `body_not_contains`, `json_path` (ADR-0005)    | Notifications — M7                                                               |
| Connect-time SSRF guard: resolve → classify → **pin** → connect             | "Check now" on-demand HTTP endpoint (FR-23, priority C) — not in FR-18…22        |
| Redirect-following, re-validated (guard steps 2–4) on every hop             | Per-monitor "skip TLS verification" — not in FR-18…22; TLS is always verified    |
| Bounded body read, streamed, never fully buffered (NFR-13)                  | Multi-address ("happy eyeballs") fallback — single validated address, documented |
| TLS certificate expiry capture (FR-22)                                      | Domain/WHOIS expiry — not requested                                              |
| Secret-header decryption for the outbound request, never re-exposed         | New config — M3 needs none; §4 explains why                                      |

## 2. Investigation

### 2.1 Requirements and architecture read together — contradictions and gaps

Full text in `probeboard-docs/en/02-requirements.md`, `03-api-health.md`,
`07-architecture.md` §7.2–7.5/7.9, `08-plan.md`, ADR-0004, ADR-0005.

- **FR-18…22, NFR-5/11/13, verbatim:**
  - FR-18: "Each probe records: monitor, timestamp, success flag, HTTP status
    code, response time in milliseconds, and on failure a failure
    classification."
  - FR-19: "Each probe is bounded by the monitor's timeout. Exceeding it is
    recorded as a timeout failure."
  - FR-20: "Failures are classified into distinguishable kinds: DNS
    resolution failure, connection refused, connection timeout, read
    timeout, TLS error, unexpected status code, failed body assertion."
  - FR-21: "Redirect-following is configurable per monitor, with a bounded
    redirect count."
  - FR-22: "For HTTPS monitors the system records the TLS certificate's
    expiry date."
  - NFR-5: "The response time recorded is the endpoint's, not the system's:
    queueing delay inside probeboard must not be counted in the
    measurement."
  - NFR-11: "The probe executor refuses URLs that resolve to loopback,
    link-local, or private address ranges, and to cloud metadata addresses.
    Validation occurs after DNS resolution, immediately before connecting,
    so that DNS rebinding cannot bypass it."
  - NFR-13: "The response body is read only up to a bounded size; it is used
    for assertions and is never persisted in full."
  - Acceptance criterion 4: "A security test demonstrates NFR-11 against
    each blocked address class, including a DNS-rebinding attempt."

- **"Records" (FR-18) vs. M3's pure-function scope.** Read literally, FR-18
  sounds like a persistence requirement. `08-plan.md`'s own milestone table
  assigns "partitioned `probe_results`, atomic rollups" to M5, and
  architecture §7.4 is explicit — "No database, no scheduler, no global
  state." Resolution: `probe()` **returns** everything FR-18 lists
  (`ProbeOutcome` — monitor id passed in by the caller, `startedAt`,
  `success`, `status`, `totalMs`, `failureClass` on failure); _writing_ the
  row is M4/M5's job (worker's scheduler loop calls `probe()`, then inserts).
  This plan's exit criterion ("probe one URL from a test") is satisfied by
  the return value, not a database row.

- **NFR-5's queueing-delay guarantee spans two milestones, not stated
  explicitly.** ADR-0004 ties NFR-5 to phase-boundary design (executor-side,
  M3) — gaps between phases stay visible instead of folding into a
  neighbour. But architecture §7.3 "Concurrency" describes a bounded
  worker-side pool where "a hung endpoint occupies one slot... never the
  loop" — pool-wait time is a scheduler-level (M4) queueing delay the
  architecture doc never says how to keep out of `total_ms`. Resolution,
  stated here since the plan does not: `probe()`'s own `probe_start` (§3.4
  D24) is recorded the instant `probe()` begins running, which by construction
  excludes any time the config spent waiting for a free concurrency-pool
  slot (that wait happens entirely _before_ `probe()` is invoked, in M4's
  code, not inside it). NFR-5 is therefore closed by M3 for everything
  inside the function, and M4 must not call `probe()` until a slot is free
  — recorded as a constraint on M4, not something M3 can enforce itself.

- **`BLOCKED_BY_POLICY` → `UNKNOWN` mapping is never spelled out as a
  literal combination.** Architecture line 162 says "a blocked probe
  records `BLOCKED_BY_POLICY`, which is `UNKNOWN`, not `DOWN`"; the
  `probe_results.outcome` enum (§7.5) is `up | down | degraded | unknown`;
  `failure_class` is a separate column, "null on success." Combining these:
  a policy-blocked probe's `ProbeOutcome` has `success: false`,
  `failureClass: 'BLOCKED_BY_POLICY'`, and it is the **caller's**
  responsibility (M6's incident evaluator, reading `failure_class`) to map
  that specific class to the `unknown` outcome rather than `down` — `probe()`
  itself has no `outcome` enum to set, only `success`/`failureClass`. Stated
  explicitly here so M6 does not have to re-derive it.

- **Module layout: architecture §7.9 vs. the actual repo.** §7.9 shows a
  flat `src/{common,auth,services,endpoints,probing,scheduler,...}` tree.
  The real repo (and `probeboard-api/CLAUDE.md`, ADR-0006) uses
  `src/{core,api,worker,testing}`, enforced by `src/architecture.test.ts`.
  §7.9 predates that split and is stale, the same gap M2's plan hit for
  `services/`/`endpoints/` (its D8) and resolved in `CLAUDE.md`'s favor.
  §4's D1 does the same here: `src/worker/probing/`, not a new top-level
  `src/probing/`.

- **No explicit "M3 does not do X" sentence in `08-plan.md`.** The boundary
  is inferred entirely from the Delivers column of M3 vs. M4 (scheduling)
  vs. M5 (storage) rows, plus the "Order rationale" line: "M3 before M4
  because the executor is a pure function and needs no scheduler to test."
  Recorded here as the scope table in §1, so it isn't re-derived per PR.

- **`endpoints.enabled` is explicitly inert to M3.** `src/core/db/types.ts`
  comments it "Inert until M4's scheduler reads it" — `probe()` takes an
  already-selected endpoint config and has no opinion on whether it should
  have been probed at all. Confirms the scheduler, not the executor, gates
  on pause/resume.

### 2.2 Code on `main` this touches

- **`src/core/ssrf/host-validator.ts`** (M2; gains one small,
  backward-compatible addition — an injectable `resolver` parameter, §3.3
  D13). `assertSaveableUrl`
  already does exactly steps 1–3 of chapter 7.4's four-step guard: scheme/
  credentials/port, `dns.resolve4`/`resolve6` (every A/AAAA record, not
  `dns.lookup`'s one), and `net.BlockList` classification against the full
  IANA special-purpose registries (86 tests, `docs/m2-verification.md`'s
  comparison table). Its own doc comment already names this plan: "M3
  reuses this module's classification and resolution but adds its own
  connect-time pin." `SsrfGuardConfig.enabled`/`blockedPorts` map straight
  onto `SSRF_GUARD_ENABLED`/`SSRF_BLOCKED_PORTS`, both already in
  `src/core/config/schema.ts:289-301`, no new config needed.

- **`src/core/crypto/header-cipher.ts`** (M2 PR3). `decryptSecret(secret,
key)` is exactly what M3 needs to put a secret header's real value on the
  wire. Its own doc comment already anticipates this: "M3's probe executor
  has to send the actual header value on the wire." `parseHeaderEncryptionKey`
  decodes `HEADER_ENCRYPTION_KEY` (already validated at boot).

- **`src/core/config/schema.ts:259-302`**, the `probing` block, already
  has everything this plan needs: `PROBE_MAX_BODY_BYTES` (default 65536),
  `PROBE_MAX_TIMEOUT_MS` (30000, the system ceiling), `PROBE_DEFAULT_TIMEOUT_MS`
  (10000), `PROBE_MAX_REDIRECTS_CAP` (10), `PROBE_DEFAULT_MAX_REDIRECTS` (5),
  `SSRF_GUARD_ENABLED`, `SSRF_BLOCKED_PORTS`. `PROBE_CONCURRENCY` (M4) and
  `PROBE_ALLOWED_INTERVALS_S`/`PROBE_DEFAULT_INTERVAL_S` (also M4) are not
  M3's concern. **No new config value is added by this plan** — see §4 D4/D5
  for why the existing single `timeout_ms` bound is sufficient.

- **`src/core/db/types.ts:121-160`**, the `EndpointsTable`/`EndpointAssertion`
  types M3 consumes but never writes: `method`, `path`, `timeout_ms`,
  `expected_status: StatusRange[]` (an array of `{min,max}` — probe() must
  check membership across all ranges, not just the first), `follow_redirects`,
  `max_redirects`, `assertions: EndpointAssertion[]` — exactly the 3-variant
  discriminated union (`body_contains`, `body_not_contains`, `json_path`)
  ADR-0005 decided on. `latency_warn_ms`, `failure_threshold`,
  `success_threshold` are M6 concerns (incident/degraded evaluation), not
  read by `probe()`.

- **`src/worker/worker.module.ts`, `main.ts`**: currently DB + config +
  logging only, comment "Loops are added in M4... M5... M6... M7." M3 adds
  no loop — `probe()` is exported for M4 to call, and this plan's own tests
  invoke it directly. No change to `worker.module.ts` is needed.

- **Test-fixture precedent, `src/testing/oauth-provider-stub.ts`.** A local
  `node:http` server, `listen(0, '127.0.0.1', ...)` (never `listen(0)` alone,
  per `CLAUDE.md`'s macOS ephemeral-port collision rule), with deliberate
  per-test faults as named boolean/field toggles (`hangTokenEndpoint`,
  `oversizedTokenResponseBytes`, `tokenErrorWith200`) rather than one
  monolithic fixture. §7's local test servers follow this exact shape: one
  small server-with-faults module per failure family, not a single
  do-everything fixture.

### 2.3 How the four reference implementations solve this (read directly, not from memory)

All four cloned locally under `~/Dev/university/probeboard/references/`.

|                                | uptime-kuma                                                                        | gatus                                                                            | openstatus                                                              | blackbox_exporter                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Core check fn                  | `Monitor.prototype.beat()`, `server/model/monitor.js:431`                          | `Endpoint.call()`, `config/endpoint/endpoint.go:450-568`                         | `checker.Http()`, `apps/checker/checker/http.go:56`                     | `ProbeHTTP()`, `prober/http.go:287`                                                                                             |
| HTTP client                    | axios                                                                              | Go `net/http`                                                                    | Go `net/http`                                                           | Go `net/http`                                                                                                                   |
| Timeout structure              | **one** overall (`axios.timeout` + a backstop `AbortSignal`, `monitor.js:566,579`) | **one** overall `http.Client.Timeout` (`client/config.go:219-243`), no per-phase | **one** overall `http.Client.Timeout` (`handlers/checker.go:77-79`)     | **one** overall `context.WithTimeout` (`prober/handler.go:69-77`), phases _measured_ via `httptrace` but not separately bounded |
| Redirect re-validation per hop | **none** — `maxRedirects` only                                                     | **none** — `CheckRedirect` only follows/refuses                                  | **none** — `CheckRedirect` only counts hops                             | **none** — `CheckRedirect` only counts/logs                                                                                     |
| TLS verify by default          | yes, skippable (`getIgnoreTls()` → `rejectUnauthorized`)                           | yes, skippable (`Insecure` config)                                               | yes, **not** skippable (no custom `tls.Config` in the HTTP path at all) | yes, skippable in test code only                                                                                                |
| Cert expiry reported           | yes, `daysRemaining` via `dayjs` diff (`util-server.js:446`)                       | yes, `time.Until(cert.NotAfter)` (`endpoint.go:554-556`)                         | **no** — no cert-expiry code anywhere in `apps/checker`                 | yes, as a Unix-time gauge (`prober/tls.go:25-33`)                                                                               |
| Failure classification         | single generic catch, one special case (`CanceledError` → timeout)                 | single generic `Result.Errors []string`, no type switch                          | single generic `err.Error()`, one special case (`urlErr.Timeout()`)     | single generic log line; only body/CEL/status/HTTP-version assertions get distinct messages                                     |
| SSRF at probe time             | **none** (confirmed: none at save time either)                                     | **none** (config-file-driven, different threat model)                            | **none** (save-time-only, M2's own finding)                             | **none** (deliberately trusts caller)                                                                                           |
| Body handling                  | fully buffered (`res.data`)                                                        | fully buffered (`io.ReadAll`, only if a condition needs it)                      | fully buffered (`io.ReadAll`, `checker/http.go:146-148`)                | **capped**, `http.MaxBytesReader` (`prober/http.go:631-637`), still `io.ReadAll`s inside regex/CEL checks up to that cap        |

Conclusions that shape §4:

1. **Every one of the four uses exactly one overall timeout**, never
   separate DNS/connect/TLS/body budgets — direct support for §4 D4's
   choice not to add new phase-specific config.
2. **None of the four re-validates a redirect target.** This is not an
   oversight this plan can quietly repeat: chapter 7.4 explicitly requires
   it ("Re-run steps 2–4 on every redirect hop"), and §2.5 below has three
   2026 CVEs of exactly this shape. §4 D7.
3. **Only blackbox_exporter caps the body**; the other three fully buffer.
   probeboard already decided NFR-13 the other way; blackbox_exporter's
   `MaxBytesReader` pattern (wrap, don't post-hoc truncate) is the one worth
   following, not the three that don't cap at all.
4. **None has any SSRF guard at probe time.** probeboard is the outlier by
   design (NFR-11) — there is no reference implementation to adapt here,
   only chapter 7.4's own four-step spec and the CVE corpus in §2.5.
5. Gatus's `Result.CertificateExpiration` (a `time.Duration`, computed once
   from `response.TLS.PeerCertificates[0]`) and blackbox_exporter's
   `getEarliestCertExpiry` (`prober/tls.go:25-33`, minimum `NotAfter` across
   the whole chain) are the two viable models for FR-22; §4 D6 explains why
   probeboard needs a third approach (`rejectUnauthorized: false` +
   `authorizationError`) neither of them needs, because neither classifies
   TLS failures at all.

### 2.4 Node/undici mechanics — verified directly against this project's own Node version

Verified live (Node v24.20.0, project's own version; undici 7.29.0 bundled,
cross-checked against standalone `undici@7.29.1`), not taken from
documentation alone — the same standard M2's SSRF investigation set for
`new URL()` behaviour.

- **Pinning a connection to a validated IP while keeping correct SNI/cert
  hostname verification for the _original_ hostname**: a custom `connect`
  function passed as `Agent`/`Client`/`Pool`'s `connect` option (source read
  directly, `undici/lib/core/connect.js:62-118`). The function receives
  `options.hostname` (the **original** request hostname — confirmed live,
  both for `fetch()` with a custom `dispatcher` and for plain
  `undici.request()`) and must build the socket itself:
  `tls.connect({ host: PINNED_IP, servername: options.hostname, port })`
  for `https:`, `net.connect({ host: PINNED_IP, port })` for `http:`. The
  default connector's automatic SNI-from-hostname fallback (`servername =
servername || options.servername || util.getServerName(host) || null`)
  only runs _inside_ the default connector — a replacement `connect`
  function must set `servername` itself, confirmed live
  (`options.servername` arrives `null` unless explicitly set upstream).
  `http.Agent`'s `options.lookup` is a narrower, unsuitable alternative: it
  overrides only the DNS step inside the normal connect flow and re-runs at
  connect time — it cannot hand the transport an address that was already
  resolved and validated earlier the way a custom `connect` can.
- **Timeout phases, confirmed live:** `connectTimeout` (default 10s) bounds
  TCP connect _and_ the DNS lookup that precedes it inside the default
  connector (verified: a connect to an unroutable `192.0.2.1:81` fires
  `ConnectTimeoutError` at exactly the configured bound). `headersTimeout`
  bounds time-to-first-response-headers _after_ connect (verified: a server
  that accepts the connection and sends nothing fires `HeadersTimeoutError`
  at its own configured bound, independent of `connectTimeout`).
  `bodyTimeout` is an **inter-chunk** timeout, not a total-body timeout — it
  resets on every chunk received (`nodejs/undici` docs, `docs/api/Client.md`).
  None of the three is a total-request budget; `AbortSignal`/`AbortController`
  passed to `fetch()` is, and does cover the whole lifecycle including body
  drain (confirmed against `nodejs/undici#1926`, which is exactly this
  distinction being reported as surprising).
- **Bounding the body without buffering it, with a real early close**:
  verified end-to-end (`response.body.getReader()`, a manual read loop
  counting bytes, `controller.abort()` once the cap is hit). The server side
  genuinely observed a `close` event immediately, not after streaming the
  rest — `abort()` on the `fetch()` call propagates through undici and tears
  down the socket, it does not merely stop the client from reading further
  bytes the server keeps sending.
- **`dns.promises.resolve4`/`resolve6` vs. `dns.lookup`**: reconfirmed —
  `resolve4`/`resolve6` return **every** record (6 for a real multi-A
  hostname tested), `dns.lookup` returns one unless `{ all: true }`. Handing
  a resolved literal straight to `tls.connect`/`net.connect`'s `host` needs
  no reformatting for IPv4 or bare IPv6 — but a bracketed IPv6 literal
  pulled from `new URL(...).hostname` (`"[::1]"`) is **not** a valid `net`/
  `tls` host (`net.isIP('[::1]')` → `0`); brackets must be stripped first.
  `core/ssrf/host-validator.ts` already does this stripping (`unbracketed`,
  lines 267-269) — its `ValidatedUrl.hostname` is already the bare form,
  safe to reuse directly.

### 2.5 SSRF/DNS-rebinding: redirect-specific bypass corpus

M2's plan (`docs/m2-plan.md` §2.4/§6) already covers plain DNS-rebinding
(resolve-then-connect TOCTOU) in depth, with sources (NCC Group, Postiz,
link-preview-js). This milestone's own new surface is the **redirect hop**,
and it has its own, more recent corpus:

- **MLflow, CVE-2026-64849**: `_validate_webhook_url` validates the
  original webhook URL only; an attacker's endpoint answers with `302` to
  `http://169.254.169.254/...`, followed unrevalidated.
  ([GitHub advisory](https://github.com/mlflow/mlflow/security/advisories/GHSA-7gwp-5pfp-969j))
- **Papra, CVE-2026-48051**: an SSRF guard checks the original URL against a
  loopback/link-local/RFC1918 blocklist; the HTTP client auto-follows `3xx`
  and the redirect target is never re-checked.
  ([GitHub advisory](https://github.com/papra-hq/papra/security/advisories/GHSA-5g86-85rp-f9hx))
- **Budibase**, "SSRF Bypass via HTTP Redirect in REST Datasource
  Integration" — same shape.
  ([GHSA-fgqv-jh4g-pvg2](https://github.com/Budibase/budibase/security/advisories/GHSA-fgqv-jh4g-pvg2))
- **Squidex**, SSRF in webhook configuration, same shape.
  ([GHSA-wxg2-953m-fg2w](https://github.com/Squidex/squidex/security/advisories/GHSA-wxg2-953m-fg2w))
- Cross-protocol redirect research: a guard that checks scheme/host but not
  what a redirect can _change_ (http→https across origins, or vice versa).
  ([Doyensec — SSRF remediation bypass](https://blog.doyensec.com/2023/03/16/ssrf-remediation-bypass.html))

Common pattern: the guard runs once, on the request-time URL; the `Location`
header is never re-validated. Chapter 7.4's "re-run steps 2–4 on every
redirect hop" is the correct closure and is not optional design flourish —
it is the exact fix every one of these advisories names. §4 D7, §6 test
matrix.

### 2.6 The failure taxonomy (already fully specified — `03-api-health.md` §3.4)

This is not new design; it is the full, already-decided taxonomy, quoted
verbatim because it _is_ the spec `probe()`'s failure-classification code
implements directly:

| Class                   | Dimension | Node signal                                                      | Operational meaning                                     |
| ----------------------- | --------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `DNS_NXDOMAIN`          | H1        | `ENOTFOUND`                                                      | name does not exist — usually config, not outage        |
| `DNS_FAILURE`           | H1        | `EAI_AGAIN`                                                      | resolver itself is failing                              |
| `CONNECTION_REFUSED`    | H1        | `ECONNREFUSED`                                                   | host up, nothing listening — process is down            |
| `CONNECTION_TIMEOUT`    | H1        | `UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT`                           | packets dropped — firewall or dead host                 |
| `CONNECTION_RESET`      | H1        | `ECONNRESET`, `EPIPE`                                            | peer killed the connection mid-flight                   |
| `TLS_EXPIRED`           | H1/H6     | `CERT_HAS_EXPIRED`                                               | certificate lapsed — foreseeable, therefore preventable |
| `TLS_UNTRUSTED`         | H1        | `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `DEPTH_ZERO_SELF_SIGNED_CERT` | chain incomplete or self-signed                         |
| `TLS_HOSTNAME_MISMATCH` | H1        | `ERR_TLS_CERT_ALTNAME_INVALID`                                   | certificate is for a different name                     |
| `TLS_HANDSHAKE_FAILED`  | H1        | `EPROTO`                                                         | protocol/cipher mismatch                                |
| `RESPONSE_TIMEOUT`      | H2        | `UND_ERR_HEADERS_TIMEOUT`                                        | connected, server never answered                        |
| `BODY_TIMEOUT`          | H2        | `UND_ERR_BODY_TIMEOUT`                                           | headers arrived, body stalled                           |
| `STATUS_MISMATCH`       | H2        | status ∉ accepted set                                            | the endpoint answered, with the wrong answer            |
| `ASSERTION_FAILED`      | H3        | assertion evaluation                                             | the payload is wrong                                    |
| `TOO_MANY_REDIRECTS`    | H2        | redirect budget exhausted                                        | redirect loop                                           |
| `BLOCKED_BY_POLICY`     | —         | SSRF guard (NFR-11)                                              | _probeboard refused_, not an endpoint failure           |

Plus, per architecture §7.4: "Unmapped codes become `UNKNOWN_ERROR` with the
raw code retained — never silently coerced to a generic failure." That is
the 15th, catch-all class this plan's `failure-classes.ts` must implement.

`BLOCKED_BY_POLICY` is excluded from uptime arithmetic by the caller (§2.1);
"the class determines the alert, not just the label" (`03-api-health.md`
line 145) — out of scope for M3 itself (M7), noted so the taxonomy's design
intent isn't lost by the time M7 is built.

## 3. `probe()` design

### 3.1 Signature and dependencies

```ts
// src/worker/probing/utils/probe.ts
export interface ProbeDeps {
  resolver: {
    resolve4(host: string): Promise<string[]>;
    resolve6(host: string): Promise<string[]>;
  };
  clock: { now(): number };
  dispatcherFactory: (opts: PinnedConnectOptions) => Dispatcher;
}

export async function probe(config: EndpointProbeConfig, deps: ProbeDeps): Promise<ProbeOutcome>;
```

Matches architecture §7.4's signature exactly. The three dependencies are
what make every non-network-condition test deterministic and fast (§7):
`resolver` replaces real DNS, `clock` replaces `Date.now()`/timers,
`dispatcherFactory` replaces the real undici transport for orchestration
tests that don't need a real socket at all (redirect-hop re-validation,
DNS-rebinding-pin proof). Production wiring (M4) supplies real
`dns.promises`, `Date`, and the real pinned-dispatcher builder.

`EndpointProbeConfig` is a plain object built by the caller from an
`Endpoint` row (plus its decrypted effective headers) — `probe()` never
touches Kysely, `Endpoint`, or any repository type directly, keeping the
"core depends on nothing... probing depends on nothing else in the tree"
property literal, not just directional.

### 3.2 Module layout — resolving the §7.9 staleness, and role folders (D1, D20)

```
src/worker/probing/
  index.ts                 re-exports probe() for M4 to import (§8 PR4)
  utils/
    probe.ts                the pure function (§3.1)
    probe.test.ts           unit: failure-class/timing wiring — no I/O
    probe.int.test.ts       integration: real local servers, every failure class (§7)
    ssrf-pin.ts             resolve → classify → pin (reuses core/ssrf) + redirect re-validation
    ssrf-pin.test.ts
    timing.ts               phase-boundary capture, absolute timestamps
    timing.test.ts
    body-cap.ts             streaming body read with a byte cap
    body-cap.test.ts
    tls-inspect.ts          rejectUnauthorized:false + authorizationError classification (§3.5)
    tls-inspect.test.ts
    failure-classes.ts      Node error/code -> §2.6 taxonomy, UNKNOWN_ERROR fallback
    failure-classes.test.ts
  assertions/
    evaluate.ts              the 3 EndpointAssertion variants
    evaluate.test.ts
    json-path.ts             minimal dot/bracket-index path subset
    json-path.test.ts
```

**Everything here is a `utils/`-role pure helper, not a NestJS construct
(D20 — Codex finding, PR #40).** The first draft put `ssrf-pin.ts`,
`timing.ts`, `body-cap.ts`, `tls-inspect.ts`, and `failure-classes.ts`
directly at the module root, and named the executor `probe.executor.ts` —
both violate `CLAUDE.md`'s structure rules directly: a supporting file left
at a module's root instead of its role folder, and a `.<role>.ts` suffix
that isn't one of the NestJS constructs the naming convention names
(`module`, `controller`, `service`, `repository`, `guard`, `decorator`,
`pipe`, `filter`, `interceptor`, `middleware`, `strategy`, `dto`).
`probe()` and every module it depends on are deliberately plain functions
with **no** framework role — that is the entire point of "no database, no
scheduler, no global state" (architecture §7.4) — so the correct home is
`utils/`, plain kebab-case names, per the same rule M1's `session-token.ts`/
`client-ip.ts` already follow. Renamed `probe.executor.ts` → `utils/probe.ts`
accordingly. `assertions/` is kept as its own folder rather than flattened
into `utils/`: it is not claiming a NestJS role, it is a cohesive
sub-concern grouping in the same spirit as `dto/`'s `fields.ts` pattern
(CLAUDE.md's own example of a legitimate non-role subfolder), and keeping
the three `EndpointAssertion` variants together is more readable than
interleaving them with the connection-layer helpers in `utils/`.

`src/worker/probing/` depends only on `src/core/ssrf`, `src/core/crypto`,
and `src/core/db/types.ts` (for `EndpointAssertion`'s shape) — never on
`src/api/`, matching ADR-0006 and `src/architecture.test.ts`.

### 3.3 SSRF guard: resolve → classify → pin → connect, re-run per redirect hop (D2, D3, D7, D13, D14)

`ssrf-pin.ts` calls `core/ssrf`'s existing `assertSaveableUrl` for steps
1–3: scheme/credentials/port, resolve every A/AAAA record, classify every
address against the shared `BlockList`. `assertSaveableUrl` gains one small,
backward-compatible addition (D13): an optional third `resolver` parameter
defaulting to the real `node:dns` `promises.resolve4`/`resolve6` it already
calls — every M2 call site and test is unaffected, and M3 is the first
caller to pass a fake one, threading `probe()`'s own injected
`deps.resolver` (§3.1) all the way through instead of stopping at the
boundary of a module that could not previously be handed one.

**Rejection codes do not collapse into one class (D14 — Codex finding,
PR #40).** The first draft of this plan mapped every `SsrfValidationError`
from `assertSaveableUrl` straight to `BLOCKED_BY_POLICY`, including
`URL_UNRESOLVABLE` — which is thrown for a genuine DNS failure, not a
policy decision, and would have made `DNS_NXDOMAIN`/`DNS_FAILURE`
unreachable through the real resolve path and told M6 to treat real outages
as `UNKNOWN`. Corrected mapping:

| `SsrfValidationError.code`                                                                                                                             | Failure class                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEME_NOT_ALLOWED`, `CREDENTIALS_IN_URL`, `PORT_NOT_ALLOWED`, `ADDRESS_NOT_ALLOWED`                                                                  | `BLOCKED_BY_POLICY` — probeboard refused, per NFR-11                                                                                                                                                                                                                                  |
| `URL_UNRESOLVABLE`, no `cause` set (both address families cleanly empty — `resolveAll`'s `addresses.length === 0` branch, `host-validator.ts:294-296`) | `DNS_NXDOMAIN` — closest match: the name has no usable record, whether the underlying per-family code was `ENOTFOUND` or `ENODATA`; `resolveAll` does not currently preserve which, a small information loss inside `core/ssrf` worth noting rather than silently working around (§9) |
| `URL_UNRESOLVABLE`, `cause` set (`host-validator.ts:344-349`'s "some other resolver error" branch)                                                     | `DNS_FAILURE` if `cause.code === 'EAI_AGAIN'`; otherwise `UNKNOWN_ERROR` with the raw `cause.code` retained, per architecture §7.4's "never silently coerced to a generic failure"                                                                                                    |

On a `BLOCKED_BY_POLICY`/`DNS_*` rejection, `probe()` returns immediately —
no connection is ever attempted, so those outcomes need no real socket and
no reachable target to test (§7).

**`SSRF_GUARD_ENABLED=false` must still leave something to connect to
(D19 — Codex finding, PR #40).** `assertSaveableUrl` short-circuits when
disabled and returns `{ hostname, addresses: [], port }` _without_
resolving (`host-validator.ts:283-285`) — the existing, correct behaviour
for M2's save-time check, where "valid" is all that's needed. The first
draft of this plan reused that return value as step 4's pin target
unconditionally, which means every real-local-server test running under
`SSRF_GUARD_ENABLED=false` (the entire non-guard slice of D12's test
strategy) would have had no address to dial at all. Fixed: `ssrf-pin.ts`
branches on `addresses.length === 0` after a _disabled_ guard specifically
(never after an _enabled_ one — an enabled guard with zero addresses is
the `URL_UNRESOLVABLE`/`DNS_*` path above, a real rejection) and falls
back to an **unpinned** connector for that one hop: a plain undici
`connect` using the hostname directly, letting the normal system resolver
run at connect time, exactly what any ordinary HTTP client does. This is
the correct reading of "disabled," not a workaround — the flag's own
config comment already says "False is for tests against a local server
only," i.e. skip probeboard's own SSRF machinery entirely, not pin to
nothing. Tested (§7): a real local server probed with the guard disabled
succeeds normally; the same target with the guard enabled and no
resolver override still goes through the pinned path.

Step 4, new in this plan: build a per-hop undici `Agent` whose `connect`
function ignores the system resolver entirely and connects straight to the
one validated address `assertSaveableUrl` returned (first in resolution
order — §4 D9), setting `servername`/TLS `host` verification to the
_original_ hostname (§2.4). This is the exact mechanism that closes the
rebinding window: the address that was checked is structurally the address
the socket dials, because nothing between validation and connect can
re-resolve.

`probe()` runs its own redirect loop rather than delegating to undici's
built-in follow-redirect behaviour (§2.3/§2.5 — no reference implementation
does this safely, and it is exactly the bypass class in §2.5's CVEs):
`fetch(url, { redirect: 'manual', dispatcher })`; on a `3xx` with a
`Location` header, resolve it against the current URL, run the **entire**
guard (steps 1–4 again, fresh `resolver` call) on the new target before
following, increment a hop counter capped at
`min(endpoint.max_redirects, PROBE_MAX_REDIRECTS_CAP)`. Exceeding it is
`TOO_MANY_REDIRECTS`; a hop that fails the guard is classified through
**D14's mapping table above, exactly as the initial target is — never
hardcoded to `BLOCKED_BY_POLICY`** (D29 below). `endpoint.follow_redirects
=== false` skips the loop entirely — the first `3xx` response is evaluated
as-is (status/assertions
run against it), matching FR-21's "configurable per monitor."

**Only real redirect statuses are followed, and the method is rewritten
per the standard rules, not always replayed (D27 — Codex finding, PR #40,
P1).** The first draft followed any `3xx` carrying a `Location` header,
and always re-issued the hop with the endpoint's configured method
unchanged. Both are wrong: `300`, `304`, `305`, `306` are not
follow-and-retry redirects (`304 Not Modified` in particular is a
legitimate final answer — status/assertion evaluation must see it, not
silently chase a `Location` it may or may not even carry), and replaying a
mutating method unconditionally across every hop can issue an unintended
second `POST`/`PUT`/etc. against the monitored API, diverging from what
every real client (browsers, curl, standard HTTP libraries) actually does
and making probe results incomparable to a user's own experience of their
API. Fixed to match the Fetch spec's HTTP-redirect-fetch algorithm
exactly: only `301`, `302`, `303`, `307`, `308` are followed; anything
else is the final response. Method rewrite: `303` switches to `GET`
whenever the current method is not `GET`/`HEAD`; `301`/`302` switch to
`GET` only when the current method is `POST`; `307`/`308` always preserve
the original method. Tested (§7): a `304` response is evaluated as-is, not
followed even with a `Location` present; a `POST` endpoint redirected by
`302` is re-issued as `GET`; a `POST` endpoint redirected by `307` is
re-issued as `POST`.

**Rewriting the method to `GET` also drops the request-body headers, not
only the method (D31 — Codex finding, PR #40, P2).** D15 already strips
the whole header map on a _cross-origin_ redirect, but D27's rewrite can
fire on a _same-origin_ hop too, where D15 does not apply and the
configured header map is otherwise carried forward unchanged. The Fetch
spec's HTTP-redirect-fetch algorithm does not stop at changing the method:
when it rewrites to `GET` it also deletes `Content-Encoding`,
`Content-Language`, `Content-Location`, and `Content-Type` from the
request's headers, since there is no longer a body those headers describe.
`HeaderValidationService` (M2) permits `Content-Type` as an ordinary
configured header, so a same-origin `301`/`302` from a `POST` endpoint
could otherwise send a bodyless `GET` still carrying a `Content-Type`
meant for the body that no longer exists — a different request shape than
any standard client would send, undermining the exact "match what a real
client does" goal D27 exists for. Fixed: whenever the method is rewritten
to `GET` (the `303` and `301`/`302` cases above), those four headers are
removed from the effective header map for that hop and every hop after,
independently of and in addition to D15's origin check. Tested (§7): a
same-origin `301` from a `POST` endpoint configured with `Content-Type`
asserts the rewritten `GET` request carries no `Content-Type`.

**The monitor's effective headers are not replayed across an origin change
(D15 — Codex finding, PR #40).** `probe()` receives a flat, already-decrypted
header map (§3.8) that can contain the monitor's own secret API key for the
_intended_ origin. The first draft's redirect loop reused that map
unconditionally on every hop; a redirect to an unrelated public host named
in `Location` would have sent that key there. Fixed: on each hop, the
effective header map carried forward is the original one only when the new
target's scheme, hostname, and port are all identical to the _original_
request's (not merely the previous hop's, so a two-hop chain back to the
original origin does not re-admit headers that were already stripped on
hop one); any difference — including an `https:` → `http:` downgrade —
drops every configured header (except what `fetch` itself sets) for that
hop and all hops after it, once dropped they stay dropped. Standard
practice for `Authorization` specifically in mainstream HTTP clients on a
cross-origin redirect; probeboard applies it to the whole header map, since
every one of them can carry a secret (M2 §5.4), not only a header named
`Authorization`.

**Every intermediate hop's response body and dispatcher are disposed of
before following the next redirect (D26 — Codex finding, PR #40).** The
first draft's redirect loop called `fetch()` for the next hop as soon as
the current one resolved with a `3xx`, without doing anything to the
current hop's response body or its per-hop `Agent` (§3.3's step 4). A
`3xx` response can still carry a body (streaming or stalled), and `fetch()`
resolves once headers arrive regardless — moving on immediately leaves
that body's underlying socket open and the per-hop dispatcher never
closed. Repeated redirected probes would retain one socket and one
dispatcher per hop until the OS or GC eventually reclaimed them, scaling
worker connection usage with the redirect cap on every redirected probe.
Fixed: each hop's `finally` block cancels the response body
(`response.body?.cancel()`) and destroys that hop's `Agent`
(`agent.close()`/`destroy()`) before the loop proceeds to validate and
fetch the next hop — success, failure, or another redirect alike. Tested
(§7): a redirect whose `3xx` response body never ends — asserts the
intermediate socket is observed closed (the local test server's own
`close` event) before the next hop's request goes out, not merely
eventually.

**A redirect hop's guard failure is not automatically `BLOCKED_BY_POLICY`
(D29 — Codex finding, PR #40, P1).** D14 (§3.3 above) already maps
`SsrfValidationError` codes to distinct failure classes for the _initial_
target — `URL_UNRESOLVABLE` becomes `DNS_NXDOMAIN`/`DNS_FAILURE`, not a
policy refusal. The first draft's redirect-loop text described every hop
failure as `BLOCKED_BY_POLICY` regardless of _why_ the guard rejected that
hop, silently re-introducing the exact bug D14 fixed, just one level
deeper: a valid first hop redirecting to a hostname that genuinely fails
to resolve (`ENOTFOUND`/`EAI_AGAIN`) would have reported `UNKNOWN`
(excluded from uptime) instead of the real `DNS_NXDOMAIN`/`DNS_FAILURE`.
Fixed: every hop's guard result runs through the same D14 table as the
initial target, with no special case for "this is a redirect, not the
first URL" — the guard does not distinguish the two, and neither should
the classification built on top of it. Tested (§7): a redirect to a
hostname that fails DNS resolution asserts `DNS_FAILURE`, not
`BLOCKED_BY_POLICY`.

### 3.4 Timing (D16, D17 — both Codex findings, PR #40)

`timing.ts` records absolute timestamps at each boundary in
`03-api-health.md` §3.3.1's table, using the sources already available once
step 4's custom `connect` function is in place — we own the socket
construction, so we own the instrumentation points directly rather than
needing undici's `diagnostics_channel`:

- `probe_start`: **the first line of `probe()`**, before scheme/credential/
  port checks, before DNS, before anything else (D24 below) — the
  unconditional anchor `total_ms` is measured from.
- `dns_start`/`dns_done`: around the `resolver.resolve4/6` calls inside the
  guard step above — for an IP-literal target (`isIP(hostname)` true in
  `assertSaveableUrl`, no resolver call made at all) both equal the moment
  the guard reaches that check, so `dns_ms` reads `0`, honestly, rather
  than being undefined.
- `connect_start`: immediately before `net.connect`/`tls.connect` inside the
  custom `connect` function.
- `connect_done`: the underlying socket's `'connect'` event (for `https:`,
  the raw TCP socket connect, before TLS begins).
- `tls_start`/`tls_done`: `'connect_done'`/the `TLSSocket`'s `'secureConnect'`
  event (or, per §3.5, the point where `authorizationError` is read, since
  the handshake itself always completes under `rejectUnauthorized: false`).
- `first_byte`: **the moment `fetch()`'s promise resolves with the
  `Response`** — i.e. when the status line and headers have arrived, not
  when the body reader first yields a chunk (corrected — see D21 below).
- `transfer_done`: the reader's `done: true`, or the moment the body cap
  (§3.6) is hit — whichever first; a capped read still produces a real
  `transfer_done`, with the outcome separately marked truncated.
- `end_at`: recorded in **every** terminal path, success or failure —
  `transfer_done` on success, `blocked_at` on a guard rejection (§3.3), or
  a generic `failed_at` set the instant any other error is caught (DNS
  failure, connection refused, TLS failure, a phase timeout, a mid-transfer
  reset). `end_at` is simply whichever of these actually fired; every path
  through `probe()` sets one before returning (corrected — see D22 below).

`total_ms` is `end_at - probe_start`, measured directly per ADR-0004 —
never summed from the derived phases, which `03-api-health.md` §3.3.2
explicitly says will not add up to it (~10% discrepancy is expected and
not a bug).

**`total_ms` needs a boundary that exists on every path, including ones
DNS never touches (D24 — Codex finding, PR #40, P1).** The first draft
anchored `total_ms` on `dns_start`, which is only set once the guard
actually reaches its resolve step — an IP-literal target skips resolution
entirely (`isIP(hostname)` short-circuits in `assertSaveableUrl`), and a
scheme/credential/port/blocked-hostname rejection fails _before_
resolution is attempted at all. Both left `dns_start` unset, so `total_ms`
was uncomputable for ordinary successful IP-literal probes and for the
earliest, cheapest policy rejections — exactly the paths D22 was supposed
to make whole. Fixed: `probe_start` is the true unconditional anchor,
recorded before any validation runs; `dns_start`/`dns_done` stay as the
DNS-phase-specific pair (now explicitly defined for the IP-literal case
too, above) used only for `dns_ms`, never for `total_ms`. Tested (§7): an
IP-literal target and a scheme-rejected URL (`ftp://...`) each assert a
present, correct `total_ms`.

**Classifying the overall deadline firing mid-phase (D16).** §4 D4 sets
undici's `connectTimeout`/`headersTimeout`/`bodyTimeout` each to the full
`timeout_ms` _and_ wraps the whole call in an outer `AbortSignal` at the
same deadline, specifically so a slow earlier phase cannot let a later
phase's independently-configured timer consume a second full budget. The
first draft of this plan left the outer abort's own failure unclassified:
when it fires first, undici raises a plain `AbortError`, which does not
carry `UND_ERR_CONNECT_TIMEOUT`/`UND_ERR_HEADERS_TIMEOUT`/
`UND_ERR_BODY_TIMEOUT` and would have fallen through to `UNKNOWN_ERROR`
instead of the correct `CONNECTION_TIMEOUT`/`RESPONSE_TIMEOUT`/
`BODY_TIMEOUT`. Fixed: `failure-classes.ts` classifies an `AbortError` from
the outer signal by **the last boundary `timing.ts` had recorded**, checked
in temporal order so an unfinished earlier phase is never misread as a
later one — no `dns_done` yet → `DNS_FAILURE` (D5, **not**
`CONNECTION_TIMEOUT`: the first version of this rule checked
`connect_done` first and would have misclassified a deadline firing mid-DNS
-resolve, Codex finding, PR #40); `dns_done` set but no `connect_done` →
`CONNECTION_TIMEOUT`; for an `https:` target, `connect_done` set but no
`tls_done` → also `CONNECTION_TIMEOUT` (D25 below — a stalled handshake,
not yet a response); `tls_done` (or `connect_done` for a plain `http:`
target) set but no `first_byte` → `RESPONSE_TIMEOUT`; `first_byte` set but
no `transfer_done` → `BODY_TIMEOUT`. Tested directly (§7): a scenario where
DNS and connect together consume
most of the budget, headers then stall past what's left — asserts
`RESPONSE_TIMEOUT`, not `UNKNOWN_ERROR`, and that elapsed time never
exceeds `timeout_ms` by
more than a small, stated margin.

**Phase boundaries across redirect hops (D17).** The first draft implied a
single boundary set for the whole probe, which is only correct when there
is no redirect — with one or more hops, each performs its own DNS
resolution and connect, and neither "keep the first hop's boundaries" nor
"overwrite with the last hop's" is right on its own: the former excludes
every later hop's real connect/TLS/TTFB cost from the derived phases the
architecture doc's own table says should blame _something_ specific (a
spike in `connect_ms` blaming "network path," not "redirect processing"
silently folded in); the latter would, if `total_ms` were computed from a
per-hop boundary, understate the probe by excluding every earlier hop's
DNS/connect/TLS time entirely — worse than the ~10% discrepancy ADR-0004
already accepts as normal, since it is not noise, it is missing, real time
the probe spent. Resolution: **`dns_ms`/`connect_ms`/`tls_ms`/`ttfb_ms`/
`transfer_ms` describe only the final hop** — the one whose response was
actually evaluated for status/assertions, matching what an operator
investigating a slow probe actually wants to know about; **`total_ms`**
needs no per-hop reasoning at all once D24 anchors it on `probe_start`,
set once before the first hop even begins — it **already** spans the
whole probe including every redirect, so the user-facing number stays
honest by construction, not by a redirect-specific rule, and the
existing "phases don't sum to total" caveat (ADR-0004, §3.3.2) now also
covers redirect-hop time as one more disclosed reason they don't — a
natural extension of a decision already made, not a new inconsistency.
Tested (§7): a two-hop redirect with an artificially slow first hop and a
fast second hop asserts `connect_ms` reflects only the fast second hop
while `total_ms` is large enough to include the slow first.

**`first_byte` means headers arrived, not body arrived (D21 — Codex
finding, PR #40).** The first draft recorded `first_byte` at the body
reader's first chunk, which left it **unset** whenever a server sent
headers and then stalled before any body data — exactly the
`RESPONSE_TIMEOUT`-vs-`BODY_TIMEOUT` boundary D16 exists to distinguish.
With the wrong definition, D16's check ("no `first_byte`" → `RESPONSE_TIMEOUT`)
misclassified a headers-then-stall as `RESPONSE_TIMEOUT` even though the
server _had_ answered, and `ttfb_ms` (`first_byte − connect_done`/`tls_done`)
silently absorbed however long the body then took to start — the opposite
of what `03-api-health.md` §3.3.2 says `ttfb_ms` should isolate ("the API's
own processing," not payload transfer). Fixed: `first_byte` is the moment
`fetch()`'s own promise resolves — status line and headers received, the
conventional definition of time-to-first-byte, and also what
blackbox_exporter's `GotFirstResponseByte` httptrace hook actually measures
(§2.3) — after which every further wait is unambiguously body transfer.
Tested (§7): headers arrive immediately, body then stalls past the
deadline — asserts `BODY_TIMEOUT`, not `RESPONSE_TIMEOUT`, and that
`ttfb_ms` reflects only the pre-headers wait.

**Every failure path records a terminal boundary, not only success and
guard-rejection (D22 — Codex finding, PR #40, P1).** `total_ms`'s formula
depended on `transfer_done` (success) or `blocked_at` (guard rejection),
but named no boundary at all for `CONNECTION_REFUSED`, a TLS failure, a
phase timeout, or a mid-transfer reset — every other row in the failure
taxonomy (§2.6) had no way to produce `total_ms`, silently breaking FR-18's
"response time in milliseconds" for the majority of failure classes.
Fixed: every code path that terminates `probe()` — including every `catch`
around the connect/handshake/request/read sequence — sets a generic
`failed_at` timestamp at the instant the error is caught, before doing
anything else with it (mapping to a failure class, building the return
value). `end_at` (used by `total_ms`, above) is whichever terminal boundary
actually fired for that outcome. Tested (§7): one row per §6 failure class
asserts a valid, non-null `total_ms` — pre-connect (`CONNECTION_REFUSED`)
and mid-body (`BODY_TIMEOUT` after a partial chunk) explicitly named, since
those are the two shapes the first draft's formula could not reach at all.

**A stalled TLS handshake is not a response timeout (D25 — Codex finding,
PR #40).** D16's boundary check, before this fix, went straight from
`connect_done` to `first_byte`, treating `connect_done`/`tls_done` as
interchangeable. For an `https:` peer that accepts the TCP connection but
never completes its TLS handshake, `connect_done` is set while `tls_done`
stays unset — the rule as first written would still report
`RESPONSE_TIMEOUT`, implying an HTTP request was sent and the server
simply never answered, when in fact no HTTP request could have been sent
at all. Fixed: the boundary check now consults `tls_done` explicitly for
an `https:` target (above); a deadline firing in this window classifies
`CONNECTION_TIMEOUT`. The taxonomy (§2.6) has no class named specifically
"handshake stalled" — `TLS_HANDSHAKE_FAILED`'s Node signal is `EPROTO`, a
protocol/cipher mismatch, not a timeout — so this is the same kind of
disclosed gap D5 already names for DNS timeouts, folded into the closest
existing class rather than inventing an undocumented one (§9). Tested
(§7): a local `https:` server that completes the TCP accept and then never
sends a ServerHello — asserts `CONNECTION_TIMEOUT`, not `RESPONSE_TIMEOUT`.

### 3.5 TLS classification and certificate expiry (FR-22) — D6

Every `https:` connect sets `rejectUnauthorized: false` at the `tls.connect`
level, then inspects `socket.authorized`/`socket.authorizationError`
immediately after the handshake completes, before any HTTP request bytes
are written. This is a deliberate departure from "just let Node reject it":

- It gives **precise** classification matching `03-api-health.md`'s exact
  Node-signal column — `authorizationError` is literally the string
  `'CERT_HAS_EXPIRED'` / `'UNABLE_TO_VERIFY_LEAF_SIGNATURE'` /
  `'DEPTH_ZERO_SELF_SIGNED_CERT'` / `'ERR_TLS_CERT_ALTNAME_INVALID'` — no
  reference implementation classifies TLS failures at all (§2.3), so there
  was no existing pattern to copy; letting Node reject automatically only
  yields a generic thrown error, collapsing four distinguishable taxonomy
  rows into one.
- It gives **always-available** certificate info for FR-22: the peer
  certificate is read from the socket regardless of whether the chain
  validated, so `cert_expires_at` (from the earliest `notAfter` across the
  chain, blackbox_exporter's `getEarliestCertExpiry` pattern,
  `prober/tls.go:25-33`) is captured even on a `TLS_EXPIRED` outcome — where
  it is most useful, since that is precisely the probe recording _why_ the
  cert is a problem.
- **The moment `authorized` is false, `probe()` aborts before sending the
  HTTP request** — the socket is destroyed, nothing is written. The trust
  boundary is identical to Node's automatic rejection; only the diagnostics
  improve. This is stated as its own guard in the test matrix (§7): "an
  untrusted/expired-cert target never receives the monitored request,"
  proved by asserting the local test server's request handler is never
  invoked when `authorizationError` is set.

A raw protocol-level failure (garbled handshake bytes, cipher mismatch)
throws before `authorized` is ever assigned and is caught separately —
`error.code === 'EPROTO'` → `TLS_HANDSHAKE_FAILED`.

### 3.6 Body cap (NFR-13) — D8, D18, D30

`body-cap.ts` implements the verified streaming-reader pattern (§2.4): a
manual `response.body.getReader()` loop, counting bytes. The buffer
accumulated is what assertions run against (§3.7) and what a truncated
failure excerpt is drawn from — "only assertion outcomes and a truncated
excerpt on failure are stored" (architecture §7.4) is a statement about
what M5 persists, but the excerpt itself is produced here, bounded from
the start, never by truncating an already-fully-read buffer the way three
of the four reference implementations do (§2.3).

**Reaching the cap is not the same as being truncated (D30 — Codex
finding, PR #40).** The first draft called `controller.abort()` the
instant the accumulated count reached `PROBE_MAX_BODY_BYTES` and marked
the result truncated unconditionally at that point. For a response whose
true, complete length is _exactly_ `PROBE_MAX_BODY_BYTES`, this aborts one
read too early: the cap is reached at the same moment the real body ends,
but the loop has no way yet to know that — it has not seen the reader's
`done: true` — so a genuinely complete body gets marked truncated, and
D23/D28's conservative truncation checks then fail `body_not_contains`/
`json_path` assertions that a correctly-identified complete body would
have passed, reporting a healthy endpoint as down. Fixed: the reader loop
requests one byte **past** the cap before deciding — it keeps reading
until either `done: true` arrives at or before `PROBE_MAX_BODY_BYTES` bytes
(genuinely complete, not truncated, even if the count lands exactly on the
cap) or a chunk pushes the count _past_ the cap (genuinely truncated, only
the first `PROBE_MAX_BODY_BYTES` bytes are kept, `controller.abort()`
called now). Tested (§7): a response whose exact byte length equals
`PROBE_MAX_BODY_BYTES` — asserts not truncated, and that a `body_not_contains`
assertion the complete body satisfies is not wrongly failed by D23's
conservative check.

**Bodyless responses (D18 — Codex finding, PR #40).** The first draft's
unconditional `response.body.getReader()` assumed a body always exists.
Per the Fetch spec (and Node's implementation of it), `response.body` is
`null` for a `HEAD` request's response and for any status the spec defines
as having no body (`204`, `205`, `304`; probeboard's own taxonomy has no
row for these being an error — they are a normal, successful shape).
`body-cap.ts` checks `response.body === null` before ever calling
`getReader()`: when null, the body buffer is empty, `transfer_done` is
recorded immediately (equal to `first_byte`, since there is nothing to
wait for after headers), and status/assertion evaluation proceeds
normally — a `body_contains`/`json_path` assertion against an empty buffer
fails as `ASSERTION_FAILED` (§3.7), not a crash. Tested (§7) with both a
`HEAD` probe and a `204` response.

### 3.7 Assertions (ADR-0005) — D10, D23

`assertions/evaluate.ts` implements exactly the three `EndpointAssertion`
variants already typed in `src/core/db/types.ts:128-131`:

- `body_contains`: substring check against the (possibly-truncated, §3.6)
  body buffer, decoded as UTF-8. A truncated body failing to contain the
  target is the correct, conservative answer — the target might have been
  in the unread tail, but "found nothing so far" is a sound reason to fail
  a _positive_ claim.
- `body_not_contains` (**D23 — Codex finding, PR #40, P1**): the same
  substring check is unsound in the _negative_ direction. The first draft
  ran it identically to `body_contains`, which means a truncated body that
  happens not to contain the target **in its read prefix** reports success
  — "the forbidden string is absent" — from data that provably did not
  cover the whole response; the string could be sitting in the unread
  tail. Fixed: `body_not_contains` checks the truncation flag (§3.6) first.
  If the body was truncated, the assertion fails as `ASSERTION_FAILED`
  regardless of what the partial buffer contains — absence cannot be
  proven from an incomplete read, so it is never asserted. Only an
  untruncated body's substring check can produce a `body_not_contains`
  success. Tested (§7): a response larger than the cap with the forbidden
  string placed _after_ the cap boundary — asserts failure, not the false
  "healthy" the first draft would have reported.
- `json_path`: checks the truncation flag (§3.6) **first**, same as
  `body_not_contains` — a truncated body fails as `ASSERTION_FAILED`
  without attempting to parse it (**D28 — Codex finding, PR #40, P1**; the
  first draft parsed the possibly-truncated buffer directly, and a cut
  that happens to land exactly after a complete, well-formed value —
  `{"a":1}` truncated right before trailing bytes that would have made the
  _full_ body invalid JSON — lets `JSON.parse` succeed on the prefix and
  report a path value from data that does not represent the real
  response, the same unsoundness D23 already fixed for `body_not_contains`,
  extended here since a coincidental parse success is exactly the failure
  mode a truncation check exists to prevent). Only an untruncated body is
  parsed: `JSON.parse` (a genuine syntax failure on the full body is itself
  `ASSERTION_FAILED`, not a crash), then `path` evaluated against it with a
  minimal subset — dot notation and integer array indices
  (`data.items[0].id`), no wildcards, filters, or recursive descent. ADR-0005
  commits only to a `version: "v1"` structured format and an explicit
  `type` field, not a JSONPath grammar; FR-15 (JSON-path assertions) is
  priority **C** (could-have). A minimal, fully-specified subset is
  sufficient and avoids adopting gatus's own characterization of its
  hand-rolled JSONPath as "half-baked" (`jsonpath.go:10`) for a feature this
  system does not need to over-build. Tested (§7): a body whose truncated
  prefix is valid JSON but whose full response is not — asserts
  `ASSERTION_FAILED`, not a value read from the coincidentally-parseable
  prefix.
- Status-code check (not itself an `EndpointAssertion` variant, but the same
  evaluation moment): `expected_status: StatusRange[]` — the response
  status must fall inside **any** range in the array, `STATUS_MISMATCH`
  otherwise. `StatusRange[]` being an array (not one `{min,max}`) means this
  must iterate, not just check the first entry — a one-line but real
  correctness detail worth stating since it is easy to get wrong silently.

**Documented limitation**: an assertion that needs content past
`PROBE_MAX_BODY_BYTES` cannot be satisfied and fails as `ASSERTION_FAILED`
— NFR-13 bounds the read; a truncated body silently failing a content check
is the deliberate trade-off NFR-13 makes, not a bug to work around.

### 3.8 Secret headers on the wire (D11)

The caller (M4, or this plan's own integration tests) passes `probe()` an
already-**decrypted** effective header map — decryption itself
(`decryptSecret`, `src/core/crypto/header-cipher.ts`, existing) happens
immediately before building the outbound request, in the thin wiring layer,
not inside `probe()`'s pure core. `probe()` never receives ciphertext, an
encryption key, or a "this header is secret" flag — only plain
`Record<string, string>` headers to send, which is what keeps a decrypted
value from ever being assignable to a field `ProbeOutcome`, an error, or a
log statement could pick up: there is no code path inside `probe()` that
holds a reference to which values were secret in the first place. Proven
the same way M2 proved this for save-time (`docs/m2-plan.md` §5.4/§5.6):
force a request failure (e.g. `CONNECTION_REFUSED`) with a secret header in
the request and the log captured, assert the plaintext value appears in no
line, no field of the returned `ProbeOutcome`, and no thrown error's
`message`/`details`.

## 4. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                      | Rejected                                                                                                                       | Because                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `src/worker/probing/`, not a new top-level `src/probing/`                                                                                                                                                                                                                                                                                                                                                                     | Architecture §7.9's literal flat tree                                                                                          | §7.9 predates ADR-0006's `core/api/worker` split (§2.1); only `worker` ever calls `probe()`, matching CLAUDE.md's feature-module rule the same way M2's D8 resolved `services/`/`endpoints/`                                                                                                                                                                                                                            |
| D2  | Reuse `core/ssrf`'s `assertSaveableUrl` verbatim for guard steps 1–3; add step 4 (pin) and per-hop re-invocation in `worker/probing/ssrf-pin.ts`                                                                                                                                                                                                                                                                              | Duplicating resolution/classification in `worker/`                                                                             | One `BlockList`, one resolution path, one place the 86-test IANA comparison table (`docs/m2-verification.md`) has to stay correct — `core/ssrf`'s own doc comment already names this as M3's job                                                                                                                                                                                                                        |
| D3  | Pin via a custom undici `connect` function per hop                                                                                                                                                                                                                                                                                                                                                                            | `http.Agent`'s `lookup` option                                                                                                 | `lookup` re-resolves at connect time inside the normal flow and cannot hand the transport a pre-validated literal the way a full custom `connect` can (§2.4, verified live)                                                                                                                                                                                                                                             |
| D4  | One overall timeout (`endpoint.timeout_ms`, ≤ `PROBE_MAX_TIMEOUT_MS`), applied to undici's `connectTimeout`/`headersTimeout`/`bodyTimeout` **and** an overall `AbortSignal` from probe start                                                                                                                                                                                                                                  | Separate configured DNS/connect/TLS/body sub-budgets                                                                           | FR-8/FR-19 specify exactly one bound; all four reference implementations use exactly one (§2.3); undici's three phase timeouts, left independent, could each consume the full budget and sum past it — the outer `AbortSignal` closes that (§2.4, `AbortSignal` verified to cover the whole lifecycle)                                                                                                                  |
| D5  | DNS resolution races against the same overall deadline; a timeout there classifies `DNS_FAILURE`                                                                                                                                                                                                                                                                                                                              | Inventing a `DNS_TIMEOUT` class                                                                                                | `03-api-health.md`'s taxonomy has no distinct DNS-timeout row (only `DNS_NXDOMAIN`/`DNS_FAILURE`) — a genuine, disclosed gap rather than adding an undocumented class silently (§9)                                                                                                                                                                                                                                     |
| D6  | TLS handshake completes with `rejectUnauthorized: false`; classify via `socket.authorized`/`authorizationError`; abort before sending the request iff `!authorized`                                                                                                                                                                                                                                                           | Letting Node reject the handshake automatically                                                                                | The automatic path collapses four distinguishable taxonomy rows (`TLS_EXPIRED`/`TLS_UNTRUSTED`/`TLS_HOSTNAME_MISMATCH`) into one generic thrown error and loses `cert_expires_at` exactly when it matters most (FR-22); no reference implementation classifies TLS failures at all, so there was nothing to copy (§2.3/§3.5)                                                                                            |
| D7  | `probe()` runs its own redirect loop (`redirect: 'manual'`), re-running the full guard on every hop before following                                                                                                                                                                                                                                                                                                          | Undici's built-in redirect-following                                                                                           | Zero of the four reference implementations re-validate a redirect target (§2.3); at least four 2026 CVEs are exactly this bypass class (§2.5); architecture §7.4 states it explicitly                                                                                                                                                                                                                                   |
| D8  | Streamed body read with a byte-counting reader loop, `controller.abort()` at the cap                                                                                                                                                                                                                                                                                                                                          | Full buffer then truncate (3 of 4 reference implementations)                                                                   | NFR-13 requires the body is "read only up to a bounded size" — buffering the whole thing first and truncating after violates that even if the truncated value looks identical; verified the abort pattern actually closes the socket early (§2.4), not just stops reading                                                                                                                                               |
| D9  | Single validated address, first in resolution order — no multi-address fallback                                                                                                                                                                                                                                                                                                                                               | "Happy eyeballs" retry across every resolved address                                                                           | Simpler, fully deterministic, and easy to test; documented limitation (§1) rather than silently building retry logic no requirement asks for                                                                                                                                                                                                                                                                            |
| D10 | `json_path` assertions: minimal dot/bracket-index subset only                                                                                                                                                                                                                                                                                                                                                                 | A full JSONPath implementation/library                                                                                         | ADR-0005 commits only to a versioned structured format, not a grammar; FR-15 is priority C; gatus's own hand-rolled JSONPath is explicitly "half-baked" in its own source comment — not a pattern worth matching in full                                                                                                                                                                                                |
| D11 | `probe()` receives only decrypted, plain headers — decryption happens in the thin caller wiring, not inside the pure core                                                                                                                                                                                                                                                                                                     | Passing ciphertext/key into `probe()`                                                                                          | Keeps "which headers were secret" entirely outside `probe()`'s reachable state, so no code path inside it can leak a value it never distinguishes as secret in the first place                                                                                                                                                                                                                                          |
| D12 | Real local servers (§7) for timeout/reset/TLS/status/assertion/redirect-mechanics tests, run with `SSRF_GUARD_ENABLED=false`; guard-rejection tests (§7) use `probe()`'s injected `resolver`/`dispatcherFactory`, no real reachable target needed; the pin-holds-under-rebinding proof tests the pin-application step directly, given an already-validated address, bypassing `assertSaveableUrl`/the `enabled` flag entirely | One test mode for everything, including the original "SSRF_GUARD_ENABLED=false + fake resolver" design for the rebinding proof | A loopback-bound local test server is itself inside the SSRF blocklist; the original rebinding-proof design additionally assumed `SSRF_GUARD_ENABLED=false` would still let an injected `resolver` run, but the guard short-circuits _before_ calling it when disabled (Codex finding, PR #40) — the fake resolver would never have been invoked, so the guard-removal assertion could not fail for the intended reason |
| D13 | `assertSaveableUrl` gains an optional, backward-compatible third `resolver` parameter (default: the real `dns.promises` calls it already makes)                                                                                                                                                                                                                                                                               | A second, M3-only copy of the resolve step                                                                                     | Lets `probe()`'s injected `deps.resolver` (§3.1) actually reach the guard it calls, instead of silently doing nothing past that boundary — the gap Codex's PR #40 review found at the rebinding-proof test; every M2 call site keeps its current, unchanged behaviour by relying on the default                                                                                                                         |
| D14 | `SsrfValidationError` codes map to distinct failure classes, not all to `BLOCKED_BY_POLICY` — table in §3.3                                                                                                                                                                                                                                                                                                                   | Collapsing every rejection into `BLOCKED_BY_POLICY`                                                                            | The first draft did exactly that (Codex finding, PR #40): it made `URL_UNRESOLVABLE` — a genuine DNS failure — indistinguishable from a real policy refusal, silently turning real outages into `UNKNOWN` at M6                                                                                                                                                                                                         |
| D15 | The effective header map is dropped (not replayed) on any redirect hop that changes scheme, host, or port from the _original_ request                                                                                                                                                                                                                                                                                         | Reusing the same header map on every hop, unconditionally                                                                      | A redirect to an unrelated host would otherwise carry the monitor's own secret headers to it (Codex finding, PR #40) — the same class of leak `Authorization`-stripping already prevents in mainstream HTTP clients, generalized to every header since any of them can be a secret (M2 §5.4)                                                                                                                            |
| D16 | The outer per-probe `AbortSignal`'s failure is classified by the last boundary `timing.ts` had recorded, checked in temporal order (DNS → connect → headers → body), not left as `UNKNOWN_ERROR` or misread by checking a later phase first                                                                                                                                                                                   | Trusting undici's own phase-timeout error types alone; an earlier draft that checked `connect_done` before `dns_done`          | The outer signal (D4) can fire first when an earlier phase ate most of the budget; its `AbortError` carries none of `UND_ERR_CONNECT_TIMEOUT`/`_HEADERS_TIMEOUT`/`_BODY_TIMEOUT`, and checking boundaries out of order misclassified a deadline firing mid-DNS-resolve as `CONNECTION_TIMEOUT` instead of `DNS_FAILURE` (two separate Codex findings, PR #40)                                                           |
| D17 | Derived phases (`dns_ms`…`transfer_ms`) describe only the final redirect hop; `total_ms` is unaffected by hop count once anchored on `probe_start` (D24)                                                                                                                                                                                                                                                                      | One boundary set for the whole probe, or overwriting each hop                                                                  | The first draft left multi-hop timing undefined (Codex finding, PR #40): keeping only the first hop's boundaries hides every later hop's real cost; deriving `total_ms` per hop would understate it by dropping earlier hops — worse than the disclosed ~10% phase/total gap ADR-0004 already accepts                                                                                                                   |
| D24 | `probe_start`, recorded before any validation runs, is the sole anchor for `total_ms`; `dns_start`/`dns_done` stay DNS-phase-only                                                                                                                                                                                                                                                                                             | Anchoring `total_ms` on `dns_start`                                                                                            | An IP-literal target skips DNS resolution entirely, and a scheme/credential/port/hostname rejection fails before resolution is attempted — both left `dns_start` unset, making `total_ms` uncomputable for ordinary successful probes and the cheapest policy rejections (Codex finding, PR #40, P1)                                                                                                                    |
| D25 | A stalled TLS handshake (`connect_done` set, `tls_done` not) classifies `CONNECTION_TIMEOUT`, checked explicitly and separately from a post-handshake stall                                                                                                                                                                                                                                                                   | Treating `connect_done`/`tls_done` as interchangeable in the boundary check                                                    | The taxonomy has no distinct "handshake stalled" class (`TLS_HANDSHAKE_FAILED` is `EPROTO`, a protocol mismatch, not a timeout — the same kind of gap D5 already discloses for DNS); the first draft reported `RESPONSE_TIMEOUT`, implying an HTTP request was sent when none could have been (Codex finding, PR #40)                                                                                                   |
| D26 | Each redirect hop's response body is cancelled and its per-hop dispatcher closed in a `finally`, before the loop proceeds                                                                                                                                                                                                                                                                                                     | Moving to the next hop as soon as a `3xx` resolves                                                                             | A `3xx` can carry a body, and `fetch()` resolves once headers arrive regardless of what happens to it — without this, repeated redirected probes would retain one socket and dispatcher per hop until GC, scaling connection usage with the redirect cap (Codex finding, PR #40)                                                                                                                                        |
| D27 | Only `301`/`302`/`303`/`307`/`308` are followed; method rewrite follows the Fetch spec exactly (`303` → `GET` unless already `GET`/`HEAD`; `301`/`302` → `GET` only from `POST`; `307`/`308` unchanged)                                                                                                                                                                                                                       | Following any `3xx` with a `Location`, always replaying the configured method                                                  | `304` in particular is a legitimate final answer, not a redirect to chase; unconditionally replaying a mutating method across a `301`/`302` hop can issue an unintended second mutating request and diverges from every real client (Codex finding, PR #40, P1)                                                                                                                                                         |
| D28 | `json_path` checks the truncation flag before parsing, same as `body_not_contains` (D23) — a truncated body fails `ASSERTION_FAILED` without attempting `JSON.parse`                                                                                                                                                                                                                                                          | Parsing whatever prefix survived the cap                                                                                       | A truncated prefix can coincidentally be complete, valid JSON even when the full response would fail to parse, letting the assertion report a value from data that doesn't represent the real response — the same unsoundness D23 fixed for the negative substring case (Codex finding, PR #40, P1)                                                                                                                     |
| D29 | Every redirect hop's guard failure runs through D14's mapping table, exactly like the initial target — no special-cased `BLOCKED_BY_POLICY` for hop rejections                                                                                                                                                                                                                                                                | Classifying every hop failure as `BLOCKED_BY_POLICY`                                                                           | Silently re-introduced D14's own bug one level deeper: a hop that genuinely fails DNS resolution would report `UNKNOWN` instead of `DNS_NXDOMAIN`/`DNS_FAILURE` (Codex finding, PR #40, P1)                                                                                                                                                                                                                             |
| D30 | The reader loop distinguishes "done at or before the cap" (not truncated) from "a chunk pushed past the cap" (truncated) — reaching the cap alone is not truncation                                                                                                                                                                                                                                                           | Aborting the instant the accumulated count reaches the cap                                                                     | A response whose true length is exactly `PROBE_MAX_BODY_BYTES` would be marked truncated one read too early, and D23/D28's conservative checks would then fail assertions a genuinely complete body satisfies, reporting a healthy endpoint as down (Codex finding, PR #40)                                                                                                                                             |
| D31 | Rewriting the method to `GET` (D27) also removes `Content-Encoding`/`Content-Language`/`Content-Location`/`Content-Type` from the effective headers, independently of D15's origin check                                                                                                                                                                                                                                      | Only rewriting the method, leaving body-describing headers in place                                                            | The Fetch spec removes those headers too when it rewrites to `GET`; a same-origin `301`/`302` (where D15's cross-origin strip does not apply) could otherwise send a bodyless `GET` still carrying `Content-Type`, a shape no standard client produces (Codex finding, PR #40)                                                                                                                                          |
| D18 | `body-cap.ts` checks `response.body === null` before calling `getReader()`; a null body records `transfer_done` immediately with an empty buffer                                                                                                                                                                                                                                                                              | An unconditional reader loop                                                                                                   | `HEAD` responses and null-body statuses (`204`/`205`/`304`) have `response.body === null` per the Fetch spec — the first draft's loop would have thrown instead of producing a successful outcome (Codex finding, PR #40, P1)                                                                                                                                                                                           |
| D19 | An SSRF guard disabled at a given hop falls back to an unpinned, hostname-based connector for that hop, instead of reusing the (empty) address list `assertSaveableUrl` returns when disabled                                                                                                                                                                                                                                 | Treating a disabled guard's `addresses: []` as the pin target                                                                  | The whole real-local-server slice of D12's test strategy runs with the guard disabled and would otherwise have nothing to dial at all (Codex finding, PR #40) — "disabled" means skip probeboard's own SSRF machinery, not pin to nothing, matching the flag's own existing config comment                                                                                                                              |
| D20 | Every non-NestJS helper (`ssrf-pin.ts`, `timing.ts`, `body-cap.ts`, `tls-inspect.ts`, `failure-classes.ts`, the renamed `utils/probe.ts`) lives in `probing/utils/`, plain kebab-case names                                                                                                                                                                                                                                   | Files at the module root with a `.executor.ts`-style suffix                                                                    | Violated `CLAUDE.md`'s structure rules directly (Codex finding, PR #40, citing AGENTS.md's Structure section): a supporting file at a module root instead of its role folder, and a role suffix that names no real NestJS construct — `probe()` and everything it depends on are deliberately framework-free                                                                                                            |
| D21 | `first_byte` is recorded when `fetch()` resolves with the `Response` (headers received), not at the body reader's first chunk                                                                                                                                                                                                                                                                                                 | Defining `first_byte` at first body data                                                                                       | Left `first_byte` unset whenever a server sent headers and stalled before any body, misclassifying that as `RESPONSE_TIMEOUT` instead of `BODY_TIMEOUT` and letting `ttfb_ms` silently absorb body-wait time (Codex finding, PR #40)                                                                                                                                                                                    |
| D22 | Every terminal path — success, guard rejection, or any caught error — records a boundary (`transfer_done`/`blocked_at`/`failed_at`); `total_ms` uses whichever fired                                                                                                                                                                                                                                                          | Only `transfer_done`/`blocked_at`, no boundary for any other failure                                                           | `total_ms` had no way to be computed for the majority of the failure taxonomy — `CONNECTION_REFUSED`, TLS failures, phase timeouts, mid-transfer resets — silently breaking FR-18 for those classes (Codex finding, PR #40, P1)                                                                                                                                                                                         |
| D23 | `body_not_contains` fails as `ASSERTION_FAILED` whenever the body was truncated, regardless of what the partial buffer contains                                                                                                                                                                                                                                                                                               | Running the same substring check as `body_contains`                                                                            | Absence cannot be proven from an incomplete read — a truncated buffer that happens not to contain the forbidden string in its read prefix does not mean the string is absent from the unread tail (Codex finding, PR #40, P1)                                                                                                                                                                                           |

## 5. Config

**No new config value.** `PROBE_MAX_BODY_BYTES`, `PROBE_MAX_TIMEOUT_MS`,
`PROBE_DEFAULT_TIMEOUT_MS`, `PROBE_MAX_REDIRECTS_CAP`,
`PROBE_DEFAULT_MAX_REDIRECTS`, `SSRF_GUARD_ENABLED`, `SSRF_BLOCKED_PORTS`
already exist (§2.2) and are exactly what §3/§4 need. D4/D5 are decisions
about how to _use_ the existing single timeout bound, not requests for new
ones.

## 6. Failure taxonomy: reproduction mechanism per class

Per the task's own requirement: every class the executor can report, and
how it is reproduced **locally, deterministically, with no public
internet**. A class that cannot be reproduced is named as a gap, not
skipped.

| Class                              | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DNS_NXDOMAIN`                     | Injected `resolver` (§3.1) rejects with `{ code: 'ENOTFOUND' }` for an unregistered test hostname — no real DNS touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DNS_FAILURE`                      | Injected `resolver` rejects with `{ code: 'EAI_AGAIN' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CONNECTION_REFUSED`               | Real `net.createServer` bound to `127.0.0.1`, closed _before_ the probe connects (or a fixed unused local port) — genuine `ECONNREFUSED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CONNECTION_TIMEOUT`               | **Not reproducible as a genuine dropped-SYN condition locally** — loopback either refuses instantly or accepts; the usual technique (a real blackhole/TEST-NET address) is itself in the SSRF blocklist (`192.0.2.0/24`, M2). Mechanism used instead: a fake `dispatcherFactory` whose custom `connect` withholds its callback past the configured deadline (fake timers, no real socket) — this proves `probe()`'s own timeout enforcement and `UND_ERR_CONNECT_TIMEOUT`→`CONNECTION_TIMEOUT` mapping, not undici's or the OS's connect-timeout mechanics (already exercised live in §2.4's own research). **Recorded as a scoped gap**, not skipped quietly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CONNECTION_RESET`                 | Real local TCP server that accepts, then calls `socket.resetAndDestroy()` (Node ≥18) mid-response — genuine `ECONNRESET`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TLS_EXPIRED`                      | Real local HTTPS server, `openssl`-generated cert with an explicit past `notAfter` (`-not_after`, OpenSSL 3.x) generated at test setup — implementation phase confirms the installed `openssl` version supports it, alternative noted in §9 if not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TLS_UNTRUSTED`                    | Real local HTTPS server, self-signed cert with no trusted CA in the test's trust store — Node's default (never disabled — §3.5) validation rejects it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TLS_HOSTNAME_MISMATCH`            | Real local HTTPS server, cert issued for a different name/SAN than the one dialed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TLS_HANDSHAKE_FAILED`             | Real local raw `net` server that responds to the TLS ClientHello with garbage bytes instead of a ServerHello — genuine `EPROTO`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RESPONSE_TIMEOUT`                 | Real local HTTP server that accepts the connection and never writes a response — `UND_ERR_HEADERS_TIMEOUT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BODY_TIMEOUT`                     | Real local HTTP server that writes headers plus a partial chunk, then stalls forever — `UND_ERR_BODY_TIMEOUT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `STATUS_MISMATCH`                  | Real local HTTP server returning a status outside `expected_status`'s ranges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ASSERTION_FAILED`                 | Real local HTTP server returning a body that fails a configured assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TOO_MANY_REDIRECTS`               | Real local HTTP server issuing a `3xx` redirect chain (or a self-loop) longer than `max_redirects`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BLOCKED_BY_POLICY` (direct)       | Injected `resolver` returns a blocked address (e.g. `169.254.169.254`) for an otherwise-valid-looking hostname, guard enabled — no server needed, rejection is pre-connect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BLOCKED_BY_POLICY` (redirect hop) | Fake `dispatcherFactory` returns a canned `3xx` with `Location` pointing at a hostname the injected `resolver` maps to a blocked address, on the _first_ call, no real socket at all — proves the orchestration (re-validate every hop) in isolation, sidestepping the loopback/guard tension in D12 entirely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rebinding / pin-holds proof        | **Corrected from the first draft** (Codex finding, PR #40: the original design ran this under `SSRF_GUARD_ENABLED=false`, which short-circuits `assertSaveableUrl` _before_ it ever calls `resolver` — the fake resolver the test relied on would never have been invoked, so the guard-removal assertion could not fail for the intended reason). Tests the **pin-application step in isolation** instead of routing through `assertSaveableUrl`/the `enabled` flag: given an already-`ValidatedUrl` (constructed directly by the test, standing in for what steps 1–3 would have produced) pointing at a real local server on `127.0.0.1` under a fake hostname that is not real DNS, build the pinned connector and probe; assert by removal — an implementation that (bug) connects by hostname instead of the pinned literal fails outright and deterministically in this environment, since resolving the fake hostname for real is impossible here. Steps 1–3 (resolve/classify) are proved separately, by re-running the M2 corpus through the connect-time path (the row above) — this row is scoped to step 4 alone, the only genuinely new code |
| `UNKNOWN_ERROR`                    | Injected `resolver`/`dispatcherFactory` throws a Node error with an unmapped `code` — asserts the raw code is retained, not coerced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 7. Test matrix

Every row proved by removal (CLAUDE.md), not just passing when present.

| Property                                                                                  | Proof                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every taxonomy row is reachable and correctly classified                                  | One test per §6 row, asserting `failureClass` and that the raw Node signal/code is what §2.6's table says                                                                                                                                                                                     |
| `total_ms` measured directly, not summed from phases                                      | Fake clock advances non-uniformly between phase boundaries with an explicit unaccounted gap; assert `total_ms` reflects the direct start/end capture, not `dns_ms+connect_ms+...`                                                                                                             |
| Phase boundaries are absolute timestamps, derivable both ways                             | Given fixed fake-clock boundary values, assert every derived `*_ms` in §3.4's table matches the documented derivation formula                                                                                                                                                                 |
| SSRF: every §2.4 (M2) corpus item still rejects through the connect-time path             | Re-run the M2 bypass-corpus table's address/hostname cases through `ssrf-pin.ts`, not just `assertSaveableUrl` directly — proves the connect-time wrapper doesn't accidentally loosen anything M2 already closed                                                                              |
| Pin holds under DNS rebinding                                                             | §6's rebinding row (corrected design, D12/PR #40); removal: bypass the custom `connect` (use plain hostname-based connect) and watch the test fail deterministically                                                                                                                          |
| Every redirect hop is re-validated                                                        | §6's redirect-hop `BLOCKED_BY_POLICY` row; removal: skip the guard on hop ≥2 and watch it pass through to a blocked target undetected                                                                                                                                                         |
| Effective headers are dropped on a cross-origin or scheme-downgrade redirect              | D15: second local server records every header it receives; a redirect from server A (with a secret header configured) to server B on a different port asserts B never received it; removal: skip the origin check and watch B receive it                                                      |
| Effective headers survive a same-origin redirect                                          | A redirect back to the _same_ scheme/host/port (e.g. a path-only redirect) still carries the configured headers — proves D15 doesn't over-strip                                                                                                                                               |
| `URL_UNRESOLVABLE` is never reported as `BLOCKED_BY_POLICY`                               | D14's mapping table, one test per row (clean-empty → `DNS_NXDOMAIN`, `cause.code==='EAI_AGAIN'` → `DNS_FAILURE`, unmapped cause → `UNKNOWN_ERROR` with the raw code retained); removal: collapse the mapping back to one class (the first draft's bug) and watch these fail                   |
| `follow_redirects=false` does not follow                                                  | A `3xx` is evaluated as-is; `Location` is never fetched (spy on the dispatcher, assert exactly one request)                                                                                                                                                                                   |
| Redirect count capped at `min(endpoint.max_redirects, PROBE_MAX_REDIRECTS_CAP)`           | A redirect chain one hop longer than the cap; `TOO_MANY_REDIRECTS`; removal: raise the cap check off-by-one and watch it under/over-count                                                                                                                                                     |
| Body never exceeds `PROBE_MAX_BODY_BYTES` in memory                                       | Local server streams far more than the cap (e.g. 10×); assert the reader loop's accumulated buffer never exceeds the cap and the server observes an early socket close (§2.4's verified pattern)                                                                                              |
| Assertion against truncated body fails predictably, not silently passes                   | A `body_contains` target that only appears past the cap; asserts `ASSERTION_FAILED`, documents D10's limitation with a real test rather than only prose                                                                                                                                       |
| `body_not_contains` fails conservatively on a truncated body (D23), never a false pass    | A response larger than the cap with the forbidden string placed after the cap boundary; asserts `ASSERTION_FAILED`, not success; removal: run the same check as `body_contains` and watch it wrongly report the endpoint healthy                                                              |
| `json_path` fails conservatively on a truncated body (D28), never a coincidental pass     | A body whose truncated prefix is valid JSON but whose full response is not; asserts `ASSERTION_FAILED`, not a value read from the prefix; removal: parse the truncated buffer directly (the first draft's bug) and watch it wrongly succeed                                                   |
| A redirect hop's DNS failure classifies `DNS_FAILURE`, not `BLOCKED_BY_POLICY` (D29)      | A redirect to a hostname that fails DNS resolution; asserts `DNS_FAILURE`; removal: hardcode every hop guard failure to `BLOCKED_BY_POLICY` (the first draft's bug) and watch it wrongly report policy refusal                                                                                |
| An exact-cap-length body is not marked truncated (D30)                                    | A response whose true byte length equals `PROBE_MAX_BODY_BYTES` exactly; asserts not truncated, and that a `body_not_contains` assertion the complete body satisfies passes; removal: abort the instant the count reaches the cap (the first draft's bug) and watch it wrongly mark truncated |
| `expected_status` checks every range, not just the first                                  | Two-range `expected_status` (`[{200,299},{404,404}]`); a `404` response passes; removal: check only `ranges[0]` and watch it wrongly fail                                                                                                                                                     |
| `json_path` evaluates the documented minimal subset correctly                             | Dot path, bracket array index, missing path (fails, not throws), malformed JSON body (fails as `ASSERTION_FAILED`, not a crash)                                                                                                                                                               |
| TLS classification matches the exact taxonomy Node signal                                 | One test per `TLS_*` row in §6, asserting `authorizationError`/`error.code` maps to the documented class                                                                                                                                                                                      |
| No HTTP request is sent to an untrusted/expired-cert target                               | Local test server's request handler asserted never invoked when the presented cert is untrusted/expired/hostname-mismatched (D6's own guard, proved by removal: skip the abort-before-send check and watch the handler get hit)                                                               |
| `cert_expires_at` captured even on `TLS_EXPIRED`                                          | The expired-cert reproduction (§6) also asserts a non-null `cert_expires_at` matching the cert's actual `notAfter`                                                                                                                                                                            |
| Secret header value never in `ProbeOutcome`, an error, or a log line                      | Force `CONNECTION_REFUSED` with a secret header configured, log captured; assert the plaintext appears in no field, no message, no log line (D11, mirrors M2 §5.4/§5.6)                                                                                                                       |
| Overall timeout bounds DNS + connect + headers + body combined, not each independently    | A scenario where DNS resolution alone consumes most of the budget, then connect is also slow; assert the **total** time-to-failure never exceeds `timeout_ms` by more than a small, stated margin — removal: remove the outer `AbortSignal` and watch phase timeouts sum past the budget      |
| Overall abort mid-phase classifies by the last recorded boundary, not `UNKNOWN_ERROR`     | D16: DNS+connect consume most of the budget, headers then stall past what's left; asserts `RESPONSE_TIMEOUT`; removal: classify every outer-abort by Node's raw `AbortError` alone and watch it report `UNKNOWN_ERROR` instead                                                                |
| Overall abort during DNS resolution classifies `DNS_FAILURE`, not `CONNECTION_TIMEOUT`    | D16: the deadline fires while `resolver.resolve4/6` is still pending (only `dns_start` recorded); asserts `DNS_FAILURE`; removal: check `connect_done` before `dns_done` (the first draft's order) and watch it wrongly report `CONNECTION_TIMEOUT`                                           |
| Multi-hop timing: final-hop phases, first-hop-to-last total (D17)                         | A two-hop redirect, first hop artificially slow, second fast; `connect_ms`/`tls_ms`/`ttfb_ms` reflect only the fast second hop, `total_ms` is large enough to include the slow first; removal: report the first hop's boundaries instead and watch `connect_ms` wrongly show the slow value   |
| `total_ms` present for an IP-literal target and a pre-DNS policy rejection (D24)          | An IP-literal URL (no DNS call at all) and a scheme-rejected URL (`ftp://...`, fails before resolution); both assert a present, correct `total_ms`; removal: anchor on `dns_start` instead of `probe_start` and watch both report a missing value                                             |
| A stalled TLS handshake classifies `CONNECTION_TIMEOUT`, not `RESPONSE_TIMEOUT` (D25)     | Local `https:` server accepts the TCP connect, never sends a ServerHello; asserts `CONNECTION_TIMEOUT`; removal: treat `connect_done`/`tls_done` as interchangeable (the first draft's bug) and watch it wrongly report `RESPONSE_TIMEOUT`                                                    |
| Redirect hops close their body and dispatcher before the next hop (D26)                   | A redirect whose `3xx` body never ends; asserts the intermediate socket is observed closed before the next hop's request is sent; removal: skip the `finally` cleanup and watch the intermediate socket stay open past the next hop's request                                                 |
| Only real redirect statuses are followed; `304` is evaluated as-is (D27)                  | A `304` response with a `Location` header present; asserts it is evaluated (status/assertions), never followed; removal: follow any `3xx` carrying `Location` and watch a `304` get chased instead of evaluated                                                                               |
| Redirect method rewrite matches the Fetch spec, not a flat replay (D27)                   | A `POST` endpoint redirected by `302` re-issues as `GET`; the same endpoint redirected by `307` re-issues as `POST`; removal: always replay the configured method and watch the `302` case wrongly re-`POST`                                                                                  |
| Method rewrite drops body-describing headers too (D31)                                    | A same-origin `301` from a `POST` endpoint configured with `Content-Type`; asserts the rewritten `GET` request carries no `Content-Type`; removal: rewrite only the method and watch `Content-Type` survive onto the bodyless `GET`                                                           |
| Bodyless responses (`HEAD`, `204`) succeed without a reader crash (D18)                   | A `HEAD` probe and a `204` response, each asserting success with an empty body buffer and a recorded `transfer_done`; removal: call `getReader()` unconditionally and watch both throw instead of completing                                                                                  |
| A real local server is reachable with `SSRF_GUARD_ENABLED=false` (D19)                    | Every D12 real-server test in §7 depends on this; a dedicated test asserts a probe against a plain loopback server succeeds under the disabled flag; removal: reuse the disabled guard's empty address list as the pin target and watch every real-server test fail with no address to dial   |
| Headers-arrived-then-stall classifies `BODY_TIMEOUT`, not `RESPONSE_TIMEOUT` (D21)        | Local server writes headers immediately, then stalls past the deadline; asserts `BODY_TIMEOUT` and that `ttfb_ms` reflects only the pre-headers wait; removal: define `first_byte` at the body reader's first chunk (the first draft's bug) and watch it misreport `RESPONSE_TIMEOUT`         |
| `total_ms` is present for every failure class, not only success/`BLOCKED_BY_POLICY` (D22) | One row per §6 failure class asserts a non-null `total_ms`, with `CONNECTION_REFUSED` (pre-connect) and a mid-body reset/timeout (post-first-byte) named explicitly; removal: use only `transfer_done`/`blocked_at` for the formula and watch every other class report a missing `total_ms`   |
| `RESPONSE_TIMEOUT` vs `BODY_TIMEOUT` vs `CONNECTION_TIMEOUT` are distinguishable          | Three local-server variants (§6), each asserting the _other two_ classes are not produced — proves the phases are actually distinguished, not that one label happens to appear                                                                                                                |
| `UNKNOWN_ERROR` never silently coerces                                                    | §6's row; asserts the raw code survives in `details`/error cause, not discarded                                                                                                                                                                                                               |
| Config bounds already covered by M2's own tests are not re-tested here                    | No new config in this plan (§5) — nothing to add to the config-bounds test suite                                                                                                                                                                                                              |

## 8. Delivery

Four PRs — a naturally different shape than M2's five, since M3 has one
security-critical layer (the guard) and one integration layer (the executor
itself), not a CRUD surface to build up.

**PR 1 — pure logic, no networking.** `src/worker/probing/utils/timing.ts`,
`utils/failure-classes.ts`, `assertions/` (including `json-path.ts`). Unit-tested
against synthetic Node error objects and canned response/body values — no
sockets, no DB. Establishes the taxonomy mapping and assertion semantics
§3.4/§3.7/§6 depend on, reviewable in isolation.

**PR 2 — the connect-time SSRF guard and pinning.** A small, additive
change to `core/ssrf/host-validator.ts` (D13's injectable `resolver`
parameter, default-preserving), then `worker/probing/ssrf-pin.ts`: the
rejection-code-to-failure-class mapping (D14), the pinned custom-`connect`
dispatcher builder proved in isolation (D12's corrected design), and the
redirect-hop re-validation loop including the cross-origin header-stripping
rule (D15). No real HTTP request is sent yet — tested via the injected
`resolver`/`dispatcherFactory` fakes and the isolated pin-application test
(§6/§7's guard rows), plus the M2-corpus re-run. Security-critical, reviewed
alone, matching M2's own PR2 precedent (the guard before anything is built
on top of it).

**PR 3 — `utils/probe.ts` itself.** Wires PR1+PR2 together with
`body-cap.ts` and `tls-inspect.ts` into the real `probe(config, deps)`
against real local test servers (§6's hang/reset/bad-TLS/redirect/timeout
fixtures, one small server-with-faults module per family, following the
`oauth-provider-stub.ts` shape). This is where every remaining §7 test
matrix row lands, including the full failure-taxonomy integration suite and
the overall-timeout-budget proof.

**PR 4 — secret headers on the wire.** The thin decrypt-before-call wiring
(D11), the redaction proof tests (log/error/`ProbeOutcome` never carrying
plaintext), and exporting `probe()` from `src/worker/probing/index.ts` for
M4 to import. No scheduler wiring — `worker.module.ts`/`main.ts` are
untouched, per §2.2; M4 is the first caller.

## 9. Open questions / tensions to flag, not resolve quietly

- **`assertSaveableUrl`'s naming and error type are still save-time-flavored**
  (`SsrfValidationError`, codes like `SCHEME_NOT_ALLOWED` meant for an HTTP
  400 body) even after D13/D14 — M3 catches and remaps every rejection code
  per §3.3's table in a small adapter in `ssrf-pin.ts`, not a change to
  `core/ssrf`'s error type itself unless PR2's implementation finds the
  reuse awkward enough to warrant exporting a lower-level
  `resolveAndClassify` alongside the existing save-time wrapper. Left as an
  implementation-time call, not a blocking decision.
- **`resolveAll` (`core/ssrf/host-validator.ts:326-354`) discards which
  per-family DNS code produced a clean "no addresses" result** (D14's
  `URL_UNRESOLVABLE`-with-no-`cause` branch) — `ENOTFOUND` and `ENODATA`
  are folded together before `assertSaveableUrl` ever throws, so M3 cannot
  distinguish "name does not exist" from "name exists, wrong record type"
  and maps both to `DNS_NXDOMAIN` (§3.3). Defensible (the taxonomy doesn't
  name a class for the latter either) but a real information loss inside
  M2's shipped code, not something this plan can fix without touching
  `core/ssrf` beyond D13's resolver parameter — left for PR2 to decide
  whether it's worth a small follow-up to `resolveAll` or is fine as-is.
- **DNS-timeout has no taxonomy class** (D5) — classified `DNS_FAILURE`,
  which is defensible (both are "the resolver itself is failing") but is a
  real gap between what `03-api-health.md` enumerates and what can actually
  happen. Worth a one-line note in the thesis evaluation chapter if it ever
  matters in practice; not a reason to invent an undocumented class here.
- **`openssl`'s `-not_after` flag** (§6, `TLS_EXPIRED` reproduction) needs
  confirming against the environment's installed OpenSSL version at
  implementation time; if unavailable, the fallback is a small
  ASN.1-patching helper or a vendored pre-generated expired cert fixture
  checked into `src/testing/`. Not expected to block PR3, flagged so it
  isn't a surprise mid-implementation.
- **Single-address, no happy-eyeballs (D9)** is a real behavioral
  limitation worth surfacing to Levon explicitly: a multi-homed host whose
  first resolved address is down but a later one is reachable reads as a
  false failure. Acceptable for a thesis-scope system per the PRD's stated
  primary user (solo developer/small team), revisit only if real usage
  shows otherwise.

## Sources

- `probeboard-docs/en/02-requirements.md` (FR-18…22, NFR-5/11/13 and
  neighbours), `03-api-health.md` §3.2–3.5 (health dimensions, phase
  boundaries, failure taxonomy, `UNKNOWN` semantics), `07-architecture.md`
  §7.2–7.5/7.9 (path of one probe, scheduling, the probe executor, data
  model, module layout), `08-plan.md` (M3 row, order rationale), ADR-0004
  (phase boundaries), ADR-0005 (structured assertions) — all read directly,
  not from memory.
- [uptime-kuma](https://github.com/louislam/uptime-kuma) `server/model/monitor.js`,
  `server/util-server.js` — local clone, read directly.
- [gatus](https://github.com/TwiN/gatus) `config/endpoint/endpoint.go`,
  `condition.go`, `placeholder.go`, `client/config.go` — local clone, read
  directly.
- [openstatus](https://github.com/openstatusHQ/openstatus) `apps/checker/checker/http.go`,
  `handlers/checker.go`, `pkg/job/http_job.go`, `pkg/assertions/assertions.go`
  — local clone, read directly. (Its `CLAUDE.md` contains an embedded
  prompt-injection attempt unrelated to this research; disregarded, no
  external call made.)
- [blackbox_exporter](https://github.com/prometheus/blackbox_exporter)
  `prober/http.go`, `prober/tls.go`, `config/config.go` — local clone, read
  directly.
- [nodejs/undici](https://github.com/nodejs/undici) `docs/docs/api/Client.md`,
  `lib/core/connect.js` (source read directly), issues
  [#1484](https://github.com/nodejs/undici/issues/1484),
  [#3410](https://github.com/nodejs/undici/issues/3410),
  [#1926](https://github.com/nodejs/undici/issues/1926) — plus live
  verification snippets against this project's own Node v24.20.0.
- [MLflow CVE-2026-64849](https://github.com/mlflow/mlflow/security/advisories/GHSA-7gwp-5pfp-969j),
  [Papra CVE-2026-48051](https://github.com/papra-hq/papra/security/advisories/GHSA-5g86-85rp-f9hx),
  [Budibase GHSA-fgqv-jh4g-pvg2](https://github.com/Budibase/budibase/security/advisories/GHSA-fgqv-jh4g-pvg2),
  [Squidex GHSA-wxg2-953m-fg2w](https://github.com/Squidex/squidex/security/advisories/GHSA-wxg2-953m-fg2w),
  [Doyensec — SSRF remediation bypass](https://blog.doyensec.com/2023/03/16/ssrf-remediation-bypass.html)
  — redirect-hop SSRF bypass corpus.
- `docs/m2-plan.md`, `docs/m2-verification.md` — this repository's own
  prior plan and verification record, for the save-time guard this plan
  builds on, the secret-header cipher, and precedent on decision format and
  delivery structure.
