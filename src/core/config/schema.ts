import { hostname } from 'node:os';
import { z } from 'zod';
import { parseByteSize } from './byte-size.js';

/**
 * An absolute `http://` or `https://` URL, or unset.
 *
 * `z.url()` alone accepts any WHATWG-valid URL, `mailto:ops@example.com`
 * included: syntactically fine, and it would sail through validation only to
 * throw on the first request that tries `new URL(path, thisValue)`, which is
 * not a hierarchical base a relative reference can resolve against. Boot is
 * the place to catch a configuration mistake like that, not the first
 * inbound flow.
 */
function httpBaseUrl() {
  return z
    .url()
    .refine((v) => new URL(v).protocol === 'http:' || new URL(v).protocol === 'https:', {
      message: 'must be an http:// or https:// URL',
    })
    .optional();
}

/** How the process presents itself and what it logs. */
const runtime = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
};

/** HTTP server. Only the api process reads these. */
const api = {
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Monitors are small JSON documents; nothing legitimate needs more.
  //
  // Validated here rather than left to body-parser, whose parser is lenient in
  // ways that turn a typo into a silent misconfiguration: "64kbb" becomes 64
  // bytes and "abc" becomes no limit at all. A bad value must stop the process
  // at boot, not quietly remove the cap.
  // Whether Swagger UI is served at /docs.
  //
  // Off, like every other switch here that widens what is reachable. The page
  // is a large piece of third-party browser code with its own history of
  // cross-site scripting advisories, and it exists for people building against
  // this API rather than people using it. docker-compose turns it on, which is
  // where it is wanted.
  API_DOCS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Bounds the readiness check's response, not the query itself.
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  API_BODY_LIMIT: z
    .string()
    .default('64kb')
    .refine((v) => parseByteSize(v) !== undefined, {
      message: 'must be a positive byte size with an explicit unit, such as "64kb"',
    })
    .refine((v) => (parseByteSize(v) ?? 0) <= 8 * 1024 * 1024, {
      message: 'must not exceed 8mb',
    }),
};

/**
 * Authentication (NFR-10, NFR-14). Only the api reads these.
 *
 * The Argon2 costs are configuration rather than constants so they can be
 * raised to match the deployment target: the figure that belongs in the
 * evaluation chapter is measured there, not on a developer laptop. The
 * defaults are OWASP's current minimum for Argon2id.
 */
const auth = {
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(10),

  // Fixed, not sliding: a session ends when it ends, which keeps revocation
  // reasoning simple (A-3). last_seen_at is recorded but does not extend it.
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // Two different jobs (A-6): throttling one noisy host, and resisting
  // credential stuffing against one account from many hosts.
  AUTH_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(15 * 60_000),
  AUTH_MAX_PER_IP: z.coerce.number().int().min(1).default(20),
  AUTH_MAX_FAILURES_PER_EMAIL: z.coerce.number().int().min(1).default(5),
  // Registrations per address per AUTH_WINDOW_MS, counted apart from
  // AUTH_MAX_PER_IP: sharing one budget let a room of people registering
  // behind one NAT lock that address out of login (#72).
  AUTH_MAX_REGISTRATIONS_PER_IP: z.coerce.number().int().min(1).max(10_000).default(20),
  AUTH_ATTEMPT_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(24 * 3600_000),

  // How long an expired or revoked session is kept before it is swept. Kept
  // rather than deleted at expiry so an operator can still answer "was this
  // session live at the time?" after an incident.
  // How often housekeeping runs, deliberately independent of how old a row
  // must be to be swept. Tying the two together meant the sweep never ran at
  // all when the process restarted more often than the retention period --
  // which, at a 24-hour default, is every ordinary deploy.
  AUTH_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3600_000),

  // Sent on the session cookie. Off only for plain-HTTP local
  // development, where a Secure cookie would never be stored at all.
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Whether X-Forwarded-For may be believed.
  //
  // This is a security setting, not a convenience one: the per-IP rate
  // limit keys on the client address, and trusting a header any client can
  // set lets an attacker present a new address per request and bypass it
  // entirely. Default off; enable it only when a proxy you control
  // overwrites the header.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // A login that never expires its predecessors leaves a row per login for
  // the whole session lifetime. Capping keeps one account from
  // accumulating sessions indefinitely, and gives "sign out my other
  // devices" a bound to reason about.
  MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(1000).default(10),

  // last_seen_at is written by every authenticated request. Updating it on
  // each one is a write per read for a value no page refreshes that often,
  // so the write is skipped unless the recorded time is already this old.
  SESSION_TOUCH_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),

  SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  // Whether a provider sign-in may attach itself to an existing account
  // because the addresses match.
  //
  // Off, and named to say what it is. Matching an incoming provider identity
  // to an account by email is a published account-takeover primitive: an
  // attacker registers with the victim's address, the victim later signs in
  // with Google, and the two are joined into one account the attacker also
  // holds a password for. That is Better Auth CVE-2026-53516; Grafana
  // CVE-2023-3128 and Google Workspace domain re-registration are the same
  // mistake reached by different routes.
  //
  // Turning it on is still not sufficient on its own: the policy additionally
  // requires that *our* record of the address is verified, not only the
  // provider's claim about it. Reading only the provider's claim is precisely
  // what the CVE above was. Since email verification arrives in M7, no local
  // row is verified yet and this flag currently changes nothing -- which is
  // the intended state, and is asserted by a test.
  OAUTH_ALLOW_EMAIL_LINKING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Caps every provider response body a strategy buffers: GitHub's /user,
  // /user/emails, and the token endpoint's error body. GitHub's own responses
  // are a few hundred bytes; an unexpectedly large or indefinitely streamed
  // one is refused rather than buffered without limit. Validated the same way
  // as API_BODY_LIMIT, for the same reason: a typo here must stop the process
  // at boot, not quietly remove the cap.
  OAUTH_PROVIDER_MAX_RESPONSE_BYTES: z
    .string()
    .default('1mb')
    .refine((v) => parseByteSize(v) !== undefined, {
      message: 'must be a positive byte size with an explicit unit, such as "1mb"',
    })
    .refine((v) => (parseByteSize(v) ?? 0) <= 8 * 1024 * 1024, {
      message: 'must not exceed 8mb',
    }),
};

const database = {
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
};

/**
 * Sign in with Google or GitHub (social-login-plan.md §6). Only the api reads
 * these.
 *
 * A provider is usable when its own id and secret are both set -- there is no
 * separate per-provider switch, because a client id with no secret is not a
 * partial configuration worth accepting, it is a typo. `OAUTH_ENABLED` is the
 * master switch: off, the feature does not exist regardless of what is
 * configured, so a deployment can hold credentials in its environment without
 * turning the surface on early.
 */
const oauth = {
  OAUTH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),

  // Never derived from the request's Host header, which is attacker-supplied.
  // Absolute, and https:// when cookies are Secure -- the authorization code
  // and the session cookie both depend on the redirect actually reaching us.
  OAUTH_REDIRECT_BASE_URL: httpBaseUrl(),
  // Where the callback sends the browser once a session is issued.
  WEB_BASE_URL: httpBaseUrl(),

  // Ten minutes, matching GitHub's authorization code expiry.
  OAUTH_STATE_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  // Every outbound call to a provider is bounded by this.
  OAUTH_HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
};

/**
 * A comma-separated list of TCP ports, parsed and bounds-checked at boot.
 *
 * A typo here (a stray letter, an out-of-range number) must fail the process
 * at boot, the same rule `API_BODY_LIMIT` follows -- not silently parse to an
 * empty or partial list and quietly stop blocking a port.
 */
/** A comma-separated list of bounded integers, e.g. a port or interval set. */
function numberList(defaultValue: string, bounds: { min: number; max: number; label: string }) {
  return z
    .string()
    .default(defaultValue)
    .transform((v, ctx) => {
      const entries = v.split(',').map((p) => p.trim());
      const parsed = entries.map((p) => {
        const n = Number(p);
        if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
          ctx.addIssue({
            code: 'custom',
            message: `"${p}" is not a valid ${bounds.label} (${String(bounds.min)}-${String(bounds.max)})`,
          });
          return z.NEVER;
        }
        return n;
      });
      return parsed;
    });
}

function portList(defaultValue: string) {
  return numberList(defaultValue, { min: 1, max: 65535, label: 'TCP port' });
}

/**
 * Probe execution limits (NFR-13, FR-8), and the SSRF guard both the api
 * (save-time, M2) and the worker (connect-time, M3) enforce -- one policy,
 * shared, rather than two flags that can drift apart (docs/m2-plan.md §4 D2).
 */
const probing = {
  PROBE_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(64 * 1024),
  // Capped at five minutes, not at the int4 ceiling. The column can hold
  // int4, but a *probe* timeout beyond minutes is pathological, and the
  // scheduler's shutdown grace must cover one worst-case probe
  // (SCHEDULER_SHUTDOWN_GRACE_MS >= SCHEDULER_LOAD_BUDGET_MS +
  // PROBE_MAX_TIMEOUT_MS). Left at int4, that rule was unsatisfiable at every
  // legal value of every other key for any timeout above 299,900ms -- the same
  // configuration trap the interval floor below exists to avoid, reached
  // through a different pair of keys. This bound is the system maximum FR-8
  // speaks of; it is applied to a stored endpoints.timeout_ms at probe time
  // (Math.min, M3 D35), so it validates no existing row.
  PROBE_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  // The worker's probe pool size (NFR-1). Capped: it bounds how many sockets
  // one process opens at once, and an unbounded value is an unbounded socket
  // count rather than more throughput.
  PROBE_CONCURRENCY: z.coerce.number().int().min(1).max(10_000).default(50),
  // FR-7: interval is chosen from a bounded set, not an arbitrary integer --
  // an unbounded per-endpoint interval is itself an abuse vector (NFR-6/7).
  // Membership is checked in the registration service, not a DTO field
  // bound, the same reason PASSWORD_MIN_LENGTH is enforced in AuthService
  // rather than in a static zod schema (dto/fields.ts): a parameter
  // decorator's schema is built before config injection runs.
  // The floor is 10, not 1: the NFR-2 drift rule below caps
  // SCHEDULER_TICK_MS + SCHEDULER_LOAD_BUDGET_MS at 10% of the shortest
  // permitted interval, and those two cannot together go below 200ms. A 1s
  // interval would make that rule unsatisfiable at *every* legal value of
  // both keys -- a configuration trap rather than a check. A one-second probe
  // interval was never supported anyway: FR-7 makes the interval a bounded
  // set and NFR-6 is stated at 60s.
  PROBE_ALLOWED_INTERVALS_S: numberList('30,60,300,900,3600', {
    min: 10,
    max: 86_400,
    label: 'probe interval in seconds',
  }),
  PROBE_DEFAULT_INTERVAL_S: z.coerce.number().int().min(1).default(60),
  // FR-8: "bounded by a system maximum" -- PROBE_MAX_TIMEOUT_MS above is that
  // ceiling; this is only the value applied when an endpoint does not name
  // its own.
  // Same ceiling as PROBE_MAX_TIMEOUT_MS, which it must not exceed: left at
  // int4 while that one is capped at 300_000, every value above the cap would
  // be unsatisfiable at any legal value of the key the error names.
  PROBE_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
  // FR-21: redirect-following is per-monitor, but the count itself stays
  // system-bounded.
  PROBE_MAX_REDIRECTS_CAP: z.coerce.number().int().min(0).max(50).default(10),
  PROBE_DEFAULT_MAX_REDIRECTS: z.coerce.number().int().min(0).default(5),
  // Leave true. Users supply the URLs this server then fetches, which is a
  // textbook SSRF primitive. False is for tests against a local server only.
  SSRF_GUARD_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Rejected even on an otherwise-public address at save time
  // (docs/m2-plan.md §5.1 rule 1): a fully public IP can still front a
  // database, cache or container-management port that answers exploitably to
  // a garbage HTTP request. Not an allowlist -- an unlisted port is accepted,
  // 80/443 included, because the set of legitimate API ports is unbounded and
  // the set of dangerous well-known ones is not.
  SSRF_BLOCKED_PORTS: portList(
    '25,111,135,139,445,1433,1521,2375,2376,3306,3389,5432,5984,6379,7000,9200,9300,11211,27017',
  ),
};

/**
 * Registration (M2): secret request-header storage. Only the api reads this.
 *
 * No default, unlike almost everything else here -- a default key would mean
 * every deployment that forgets to set one shares the same key, which is
 * worse than refusing to boot. Required, like DATABASE_URL, validated for
 * shape rather than merely presence: 32 raw bytes, base64-encoded, the exact
 * width AES-256-GCM needs. Generate one with `openssl rand -base64 32`.
 *
 * No rotation support in M2 -- a single active key. Rotating it means
 * re-encrypting every stored secret header, which is future work, not a
 * config concern; recorded as a limitation in docs/m2-plan.md §10.
 */
const registration = {
  HEADER_ENCRYPTION_KEY: z.string().refine(
    (v) => {
      try {
        const decoded = Buffer.from(v, 'base64');
        // Buffer.from(..., 'base64') silently drops characters that are not
        // valid base64 instead of rejecting them -- a value with a stray
        // trailing or embedded character can still decode to exactly 32
        // bytes, differing from what was intended. Re-encoding and comparing
        // catches that: only a canonical encoding round-trips to itself.
        return decoded.length === 32 && decoded.toString('base64') === v;
      } catch {
        return false;
      }
    },
    { message: 'must be 32 bytes, base64-encoded -- generate one with `openssl rand -base64 32`' },
  ),
  // FR-16/B-8. Configurable per the PRD; 100 is comfortably above what a
  // solo developer or small team (the PRD's stated primary user) would
  // register (docs/m2-plan.md §10).
  ENDPOINT_QUOTA_PER_USER: z.coerce.number().int().min(1).max(100_000).default(100),

  // How long the json_path audit waits for one recovery-record write before
  // giving up (docs/m3-plan.md D66). The write happens inside the per-row
  // transaction, so an unbounded wait holds `FOR UPDATE` on that endpoint
  // indefinitely: a reader that stops consuming stdout without closing it
  // produces backpressure, not `EPIPE`, and the write callback never fires.
  // Rejecting rolls the removal back and releases the lock. Generous, because
  // exceeding it aborts a destructive repair -- it is a stall detector, not a
  // latency target.
  AUDIT_WRITE_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  // Service and endpoint headers are counted separately against this cap
  // (docs/m2-plan.md §5.2).
  MAX_HEADERS_PER_OWNER: z.coerce.number().int().min(1).max(1000).default(20),
  MAX_HEADER_NAME_BYTES: z.coerce.number().int().min(1).max(8192).default(256),
  MAX_HEADER_VALUE_BYTES: z.coerce.number().int().min(1).max(65_536).default(4096),
  // The services/endpoints list endpoints' page-size cap (docs/m2-plan.md
  // §5.5). Enforced in the service layer, not the request DTO -- a
  // parameter decorator's schema is built before config injection runs.
  MAX_LIST_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
  // An endpoint's path, byte-length (docs/m2-plan.md §3) -- checked against
  // the canonical path (post-URL-parse) in the service layer, not a DTO
  // .max(), since z.string().max() counts UTF-16 code units rather than
  // UTF-8 bytes and a parameter decorator's schema is built before config
  // injection runs.
  MAX_ENDPOINT_PATH_BYTES: z.coerce.number().int().min(1).max(8192).default(2048),
};

/** Claim-based scheduling (NFR-2, NFR-3, NFR-4). */
const scheduler = {
  // Must be unique per running instance: it is written to `leased_by`, so an
  // ambiguous value makes it impossible to tell which worker holds a claim or
  // which one died. PID alone is not enough -- every container runs its
  // process as PID 1, so N containers would all report the same id.
  WORKER_ID: z
    .string()
    .min(1)
    .default(() => `${hostname()}-${process.pid}`),
  // How often the tick looks for due work. Bounded above, not only below: a
  // delay over 2^31-1 ms does not become a long timer, it silently becomes
  // 1ms -- measured on the pinned runtime, node:22-alpine reports
  // TimeoutOverflowWarning and fires immediately -- which turns the tick into
  // a hot loop hammering the database. This is why Uptime Kuma depends on
  // `unlimited-timeout`; a bound is cheaper than a dependency.
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  // The longest a repeating scheduler error goes unlogged (#72, D3). A
  // failing tick is logged at once, then at intervals doubling from
  // SCHEDULER_TICK_MS up to this, each line carrying how many it held back.
  // Bounded above like the tick itself, for the same timer-overflow reason.
  SCHEDULER_ERROR_LOG_MAX_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(60_000),
  // Rows claimed per tick. Capped because a batch larger than any plausible
  // pool leases rows nothing will start within the lease.
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(100),
  SCHEDULER_LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
  // Everything between the claim committing and probe() arming its deadline:
  // the endpoint, service and header reads plus decryption. Not zero, and not
  // an estimate -- the load runs under this budget and an overrun releases
  // the row without probing, so the lease arithmetic below is a proof rather
  // than a hope. The floor is 100 so the NFR-2 rule stays satisfiable at the
  // shortest permitted interval.
  SCHEDULER_LOAD_BUDGET_MS: z.coerce.number().int().min(100).max(60_000).default(1_500),
  // Teardown, the release round trip, and the tick granularity around both.
  // The one judged term in the lease arithmetic, which is why it is
  // configuration rather than a literal.
  SCHEDULER_LEASE_SLACK_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),
  // How long a graceful stop waits for in-flight probes before giving up on
  // them. Bounded on both sides by the rules below.
  // Ceiling above PROBE_MAX_TIMEOUT_MS' own, so the floor rule below always
  // has a solution: 600_000 >= 100 + 300_000 at the most permissive legal
  // values of both.
  SCHEDULER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(35_000),
  // Spread applied to a newly adopted endpoint's first slot, so monitors
  // created together do not share a phase for ever and arrive in one tick.
  // Written to the database once, so it survives restarts -- unlike Gatus's
  // boot-order stagger. 0 disables it, which the herd test uses.
  SCHEDULER_ADOPT_JITTER_MAX_S: z.coerce.number().int().min(0).max(3600).default(60),
};

/** Result storage and partition maintenance (M5, docs/m5-plan.md §5). */
const storage = {
  // Daily partitions created ahead of need. A missing partition is a hard
  // write error (no DEFAULT partition, ADR-0007), so this is the horizon the
  // maintenance job must keep -- see the refine against the interval below.
  PARTITION_AHEAD_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  // Monthly partitions (hourly aggregates) created ahead of need.
  PARTITION_AHEAD_MONTHS: z.coerce.number().int().min(1).max(12).default(2),
  // One day at most; see the refine against PARTITION_AHEAD_DAYS below.
  STORAGE_MAINTENANCE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(86_400_000)
    .default(3_600_000),
  // Attempts at one result's write. It is idempotent by its key, so a retry
  // cannot duplicate; exhausting them leaves the lease to lapse and the slot
  // becomes an UNKNOWN gap, never a healthy one.
  RESULT_WRITE_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Base delay before a retry; attempt n waits n times this. 0 retries at once.
  RESULT_WRITE_BACKOFF_MS: z.coerce.number().int().min(0).max(10_000).default(100),
  // How often the rollup folds new results into the aggregates (07's table).
  // Bounded above: a delay past 2^31-1 ms would fire at once, not late.
  ROLLUP_TICK_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
  // Distinct inserting transactions folded per batch inside one rollup pass. A
  // batch is whole transactions, so rows are never split across two batches.
  ROLLUP_BATCH_ROWS: z.coerce.number().int().min(1).max(100_000).default(5000),
  // Ticks without the watermark advancing before a pass reports it as stale: a
  // diagnostic threshold, not a limit -- a rollup that is behind is lag, not loss.
  ROLLUP_STALE_TICKS: z.coerce.number().int().min(1).max(1000).default(10),
  // How long raw results are kept before their daily partition is dropped
  // (NFR-8). At least two days, and (refine below) longer than lease plus
  // shutdown grace: a probe that started that long ago cannot still be writing.
  RETENTION_RAW_DAYS: z.coerce.number().int().min(2).max(3650).default(7),
  // Minute and hour aggregates are retention-bound too: at a 60 s interval an
  // m1 row per probe is as many rows as raw. Never shorter than raw (refine).
  RETENTION_M1_DAYS: z.coerce.number().int().min(2).max(3650).default(7),
  RETENTION_H1_DAYS: z.coerce.number().int().min(2).max(3650).default(400),
  // claim_log is disjointness evidence for the thesis, not state: a few days.
  RETENTION_CLAIM_LOG_DAYS: z.coerce.number().int().min(1).max(3650).default(3),
  // lock_timeout for the retention detach: how long it may wait behind a reader
  // of the partition before giving up and retrying next tick.
  MAINTENANCE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
};

const baseSchema = z.object({
  ...runtime,
  ...api,
  ...auth,
  ...database,
  ...oauth,
  ...probing,
  ...registration,
  ...scheduler,
  ...storage,
});

/**
 * Cross-field rules, which a per-field schema cannot express.
 */
export const configSchema = baseSchema
  .refine((c) => c.AUTH_ATTEMPT_RETENTION_MS >= c.AUTH_WINDOW_MS, {
    path: ['AUTH_ATTEMPT_RETENTION_MS'],
    message:
      'must be at least AUTH_WINDOW_MS, or the housekeeping sweep deletes the ' +
      'evidence the rate limiter is still counting and the limit is bypassed',
  })
  .refine((c) => Boolean(c.GOOGLE_CLIENT_ID) === Boolean(c.GOOGLE_CLIENT_SECRET), {
    path: ['GOOGLE_CLIENT_SECRET'],
    message:
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or neither -- ' +
      'a client id with no secret is not a partial configuration, it fails at the ' +
      'first sign-in instead of at boot',
  })
  .refine((c) => Boolean(c.GITHUB_CLIENT_ID) === Boolean(c.GITHUB_CLIENT_SECRET), {
    path: ['GITHUB_CLIENT_SECRET'],
    message: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together, or neither',
  })
  .refine((c) => !c.OAUTH_ENABLED || Boolean(c.OAUTH_REDIRECT_BASE_URL), {
    path: ['OAUTH_REDIRECT_BASE_URL'],
    message: 'required when OAUTH_ENABLED is true',
  })
  .refine(
    (c) =>
      !c.COOKIE_SECURE ||
      !c.OAUTH_REDIRECT_BASE_URL ||
      c.OAUTH_REDIRECT_BASE_URL.startsWith('https://'),
    {
      path: ['OAUTH_REDIRECT_BASE_URL'],
      message:
        'must be https:// when COOKIE_SECURE is on, or the browser refuses to return the ' +
        'state cookie to a plain-http callback and every sign-in fails as ' +
        'OAUTH_STATE_INVALID -- set COOKIE_SECURE=false only for local development',
    },
  )
  .refine((c) => !c.OAUTH_ENABLED || Boolean(c.WEB_BASE_URL), {
    path: ['WEB_BASE_URL'],
    message: 'required when OAUTH_ENABLED is true',
  })
  .refine((c) => !c.COOKIE_SECURE || !c.WEB_BASE_URL || c.WEB_BASE_URL.startsWith('https://'), {
    path: ['WEB_BASE_URL'],
    message:
      'must be https:// when COOKIE_SECURE is on -- the session cookie the callback just set ' +
      'is Secure in that configuration, so a plain-http web app can never read it back, and ' +
      'every sign-in would look successful and then behave as if it were not',
  })
  .refine((c) => !c.OAUTH_ENABLED || Boolean(c.GOOGLE_CLIENT_ID) || Boolean(c.GITHUB_CLIENT_ID), {
    path: ['OAUTH_ENABLED'],
    message: 'true with no provider configured turns on a feature with no way to use it',
  })
  .refine((c) => c.PROBE_ALLOWED_INTERVALS_S.includes(c.PROBE_DEFAULT_INTERVAL_S), {
    path: ['PROBE_DEFAULT_INTERVAL_S'],
    message: 'must be one of PROBE_ALLOWED_INTERVALS_S, or no endpoint could ever use the default',
  })
  .refine((c) => c.PROBE_DEFAULT_TIMEOUT_MS <= c.PROBE_MAX_TIMEOUT_MS, {
    path: ['PROBE_DEFAULT_TIMEOUT_MS'],
    message: 'must not exceed PROBE_MAX_TIMEOUT_MS',
  })
  .refine((c) => c.PROBE_DEFAULT_MAX_REDIRECTS <= c.PROBE_MAX_REDIRECTS_CAP, {
    path: ['PROBE_DEFAULT_MAX_REDIRECTS'],
    message: 'must not exceed PROBE_MAX_REDIRECTS_CAP',
  })
  // ADR-0002's second named edge case, made unreachable by configuration
  // rather than watched for. The lease must outlast everything between the
  // claim committing and the release committing: loading the monitor, the
  // probe itself, then teardown and the release round trip.
  .refine(
    (c) =>
      c.SCHEDULER_LEASE_MS >=
      c.SCHEDULER_LOAD_BUDGET_MS + c.PROBE_MAX_TIMEOUT_MS + c.SCHEDULER_LEASE_SLACK_MS,
    {
      path: ['SCHEDULER_LEASE_MS'],
      message:
        'must be at least SCHEDULER_LOAD_BUDGET_MS + PROBE_MAX_TIMEOUT_MS + ' +
        'SCHEDULER_LEASE_SLACK_MS, or a slow probe outlives its own lease and a ' +
        'second worker probes the same endpoint concurrently',
    },
  )
  // Bounded on both sides. Below the floor a graceful stop cannot let even one
  // worst-case probe finish, so every ordinary restart abandons in-flight work
  // and produces the same UNKNOWN gap as a crash. At or above the lease, a stop
  // can outlive the lease it is trying to release, and a peer starts a second
  // probe while ours is still draining.
  .refine(
    (c) => c.SCHEDULER_SHUTDOWN_GRACE_MS >= c.SCHEDULER_LOAD_BUDGET_MS + c.PROBE_MAX_TIMEOUT_MS,
    {
      path: ['SCHEDULER_SHUTDOWN_GRACE_MS'],
      message:
        'must be at least SCHEDULER_LOAD_BUDGET_MS + PROBE_MAX_TIMEOUT_MS, or a ' +
        'graceful stop cannot let one worst-case probe finish and every restart ' +
        'leaves the same UNKNOWN gap as a crash',
    },
  )
  .refine((c) => c.SCHEDULER_SHUTDOWN_GRACE_MS < c.SCHEDULER_LEASE_MS, {
    path: ['SCHEDULER_SHUTDOWN_GRACE_MS'],
    message:
      'must be less than SCHEDULER_LEASE_MS, or a graceful stop can outlive the ' +
      'lease it is trying to release and a peer starts a second probe while ours ' +
      'is still draining',
  })
  // A raw partition is dropped once it is older than the retention; a probe that
  // started before then must be unable to still be writing, or the drop could
  // race a late insert (docs/m5-plan.md §3.7 step 2).
  .refine(
    (c) => c.RETENTION_RAW_DAYS * 86_400_000 > c.SCHEDULER_LEASE_MS + c.SCHEDULER_SHUTDOWN_GRACE_MS,
    {
      path: ['RETENTION_RAW_DAYS'],
      message:
        'must exceed SCHEDULER_LEASE_MS + SCHEDULER_SHUTDOWN_GRACE_MS, or a drop can race a late result write',
    },
  )
  // The aggregates must outlive the raw rows they summarise: otherwise a raw row
  // still awaiting its fold could find its stats partition already gone.
  .refine((c) => c.RETENTION_M1_DAYS >= c.RETENTION_RAW_DAYS, {
    path: ['RETENTION_M1_DAYS'],
    message: 'must be at least RETENTION_RAW_DAYS, or aggregates are dropped before their raw rows',
  })
  .refine((c) => c.RETENTION_H1_DAYS >= c.RETENTION_RAW_DAYS, {
    path: ['RETENTION_H1_DAYS'],
    message: 'must be at least RETENTION_RAW_DAYS, or aggregates are dropped before their raw rows',
  })
  // Two missed maintenance ticks must still leave a partition to write into.
  // With one tick a day and the minimum horizon of one day, a single missed
  // tick would let the horizon lapse and every insert would fail.
  .refine((c) => c.PARTITION_AHEAD_DAYS * 86_400_000 > 2 * c.STORAGE_MAINTENANCE_INTERVAL_MS, {
    path: ['PARTITION_AHEAD_DAYS'],
    message:
      'must exceed twice STORAGE_MAINTENANCE_INTERVAL_MS, or two missed maintenance ticks ' +
      'leave no partition to write into and every result insert fails',
  })
  // NFR-2: a monitor due at interval T is probed with drift under 10% of T.
  // Two terms, not one: a row becomes due up to one tick before the next claim
  // looks, and the claim is then up to one load budget from probe() arming its
  // deadline. Counting only the tick left the loader budget silently spending
  // the drift budget as well.
  .refine(
    (c) =>
      c.SCHEDULER_TICK_MS + c.SCHEDULER_LOAD_BUDGET_MS <=
      (Math.min(...c.PROBE_ALLOWED_INTERVALS_S) * 1000) / 10,
    {
      path: ['SCHEDULER_TICK_MS'],
      message:
        'SCHEDULER_TICK_MS + SCHEDULER_LOAD_BUDGET_MS must not exceed 10% of the ' +
        'shortest interval in PROBE_ALLOWED_INTERVALS_S, or a monitor at that ' +
        'interval can start outside NFR-2 drift budget',
    },
  );

export type AppConfig = z.infer<typeof baseSchema>;
