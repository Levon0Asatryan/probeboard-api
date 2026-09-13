import { hostname } from 'node:os';
import { z } from 'zod';
import { parseByteSize } from './byte-size.js';

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
};

const database = {
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
};

/** Probe execution limits (NFR-13, FR-8). */
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
  ...probing,
  ...scheduler,
});

/**
 * Cross-field rules, which a per-field schema cannot express.
 */
export const configSchema = baseSchema.refine(
  (c) => c.AUTH_ATTEMPT_RETENTION_MS >= c.AUTH_WINDOW_MS,
  {
    path: ['AUTH_ATTEMPT_RETENTION_MS'],
    message:
      'must be at least AUTH_WINDOW_MS, or the housekeeping sweep deletes the ' +
      'evidence the rate limiter is still counting and the limit is bypassed',
  },
);

export type AppConfig = z.infer<typeof baseSchema>;
