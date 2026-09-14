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
function portList(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform((v, ctx) => {
      const ports = v.split(',').map((p) => p.trim());
      const parsed = ports.map((p) => {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          ctx.addIssue({
            code: 'custom',
            message: `"${p}" is not a valid TCP port (1-65535)`,
          });
          return z.NEVER;
        }
        return n;
      });
      return parsed;
    });
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
  PROBE_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  PROBE_CONCURRENCY: z.coerce.number().int().min(1).default(50),
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
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be 32 bytes, base64-encoded -- generate one with `openssl rand -base64 32`' },
  ),
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
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(1000),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).default(100),
  SCHEDULER_LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
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
  });

export type AppConfig = z.infer<typeof baseSchema>;
