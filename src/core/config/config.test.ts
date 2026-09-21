import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
};

describe('loadConfig', () => {
  it('applies defaults when only required values are present', () => {
    const cfg = loadConfig(valid);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.SSRF_GUARD_ENABLED).toBe(true);
  });

  it('refuses to start without a database url', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('refuses a non-numeric port rather than coercing it to NaN', () => {
    expect(() => loadConfig({ ...valid, API_PORT: 'http' })).toThrow(/API_PORT/);
  });

  it('names every invalid key, not just the first', () => {
    const err = (() => {
      try {
        loadConfig({ API_PORT: '0', LOG_LEVEL: 'loud' });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toMatch(/DATABASE_URL/);
    expect(err).toMatch(/API_PORT/);
    expect(err).toMatch(/LOG_LEVEL/);
  });

  it('treats SSRF_GUARD_ENABLED as a real boolean, not a truthy string', () => {
    expect(loadConfig({ ...valid, SSRF_GUARD_ENABLED: 'false' }).SSRF_GUARD_ENABLED).toBe(false);
  });
});

describe('SSRF_BLOCKED_PORTS', () => {
  it('parses the default list into numbers', () => {
    const ports = loadConfig(valid).SSRF_BLOCKED_PORTS;
    expect(ports).toContain(6379);
    expect(ports).toContain(3306);
    expect(ports.every((p) => typeof p === 'number')).toBe(true);
  });

  it('parses a custom comma-separated list, trimming whitespace', () => {
    const ports = loadConfig({ ...valid, SSRF_BLOCKED_PORTS: '80, 443,8080' }).SSRF_BLOCKED_PORTS;
    expect(ports).toEqual([80, 443, 8080]);
  });

  it('refuses a non-numeric entry rather than silently dropping it', () => {
    expect(() => loadConfig({ ...valid, SSRF_BLOCKED_PORTS: '80,abc' })).toThrow(
      /SSRF_BLOCKED_PORTS/,
    );
  });

  it('refuses a port outside 1-65535', () => {
    expect(() => loadConfig({ ...valid, SSRF_BLOCKED_PORTS: '0' })).toThrow(/SSRF_BLOCKED_PORTS/);
    expect(() => loadConfig({ ...valid, SSRF_BLOCKED_PORTS: '70000' })).toThrow(
      /SSRF_BLOCKED_PORTS/,
    );
  });
});

describe('HEADER_ENCRYPTION_KEY', () => {
  it('refuses to start with no key set', () => {
    const { HEADER_ENCRYPTION_KEY: _omit, ...withoutKey } = valid;
    expect(() => loadConfig(withoutKey)).toThrow(/HEADER_ENCRYPTION_KEY/);
  });

  it('refuses a key that decodes to the wrong length', () => {
    // 16 bytes, not 32 -- AES-128 width, not AES-256.
    expect(() =>
      loadConfig({ ...valid, HEADER_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/HEADER_ENCRYPTION_KEY/);
  });

  it('refuses text that is not valid base64 at all', () => {
    expect(() => loadConfig({ ...valid, HEADER_ENCRYPTION_KEY: 'not base64!!' })).toThrow(
      /HEADER_ENCRYPTION_KEY/,
    );
  });

  it('accepts a correctly-sized key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(loadConfig({ ...valid, HEADER_ENCRYPTION_KEY: key }).HEADER_ENCRYPTION_KEY).toBe(key);
  });

  it('refuses a value with a stray trailing character, even though it still decodes to 32 bytes', () => {
    // Buffer.from(..., 'base64') silently drops invalid characters rather
    // than rejecting them, so a valid-looking prefix plus junk (a copy-paste
    // artifact, a templating suffix) can still decode to exactly 32 bytes --
    // just not the 32 bytes the string visually represents.
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(() => loadConfig({ ...valid, HEADER_ENCRYPTION_KEY: key + '!!!extra' })).toThrow(
      /HEADER_ENCRYPTION_KEY/,
    );
  });

  it('refuses a value with junk embedded in the middle', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const withEmbeddedJunk = key.slice(0, 10) + '@#$' + key.slice(10);
    expect(() => loadConfig({ ...valid, HEADER_ENCRYPTION_KEY: withEmbeddedJunk })).toThrow(
      /HEADER_ENCRYPTION_KEY/,
    );
  });
});

describe('error reporting', () => {
  it('labels an issue with no path as (root) rather than an empty string', () => {
    // zod reports whole-object problems with an empty path; the message must
    // still name something a reader can act on.
    const err = (() => {
      try {
        loadConfig(null as unknown as NodeJS.ProcessEnv);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain('(root)');
  });
});

describe('WORKER_ID', () => {
  it('defaults to something unique per instance, not just the pid', () => {
    // Every container runs its process as PID 1, so a pid-only default would
    // give every worker the same identity.
    const id = loadConfig(valid).WORKER_ID;
    expect(id).toContain(String(process.pid));
    expect(id).not.toBe(`worker-${process.pid}`);
    expect(id.length).toBeGreaterThan(String(process.pid).length + 1);
  });

  it('is overridable from the environment', () => {
    expect(loadConfig({ ...valid, WORKER_ID: 'probe-eu-1' }).WORKER_ID).toBe('probe-eu-1');
  });
});

describe('API_BODY_LIMIT', () => {
  it('accepts a well-formed size', () => {
    expect(loadConfig({ ...valid, API_BODY_LIMIT: '256kb' }).API_BODY_LIMIT).toBe('256kb');
  });

  it('refuses a doubled unit instead of silently shrinking the cap', () => {
    // body-parser's own parser reads "64kbb" as 64 bytes.
    expect(() => loadConfig({ ...valid, API_BODY_LIMIT: '64kbb' })).toThrow(/API_BODY_LIMIT/);
  });

  it('refuses unparseable text instead of silently removing the cap', () => {
    // body-parser treats an unparseable limit as no limit.
    expect(() => loadConfig({ ...valid, API_BODY_LIMIT: 'abc' })).toThrow(/API_BODY_LIMIT/);
  });

  it('refuses a bare number, which would mean bytes rather than kilobytes', () => {
    expect(() => loadConfig({ ...valid, API_BODY_LIMIT: '64' })).toThrow(/API_BODY_LIMIT/);
  });

  it('refuses zero and negative sizes', () => {
    expect(() => loadConfig({ ...valid, API_BODY_LIMIT: '0kb' })).toThrow(/API_BODY_LIMIT/);
    expect(() => loadConfig({ ...valid, API_BODY_LIMIT: '-5kb' })).toThrow(/API_BODY_LIMIT/);
  });

  it('refuses an absurd cap that would defeat the protection', () => {
    expect(() => loadConfig({ ...valid, API_BODY_LIMIT: '5gb' })).toThrow(/API_BODY_LIMIT/);
  });
});

describe('AUDIT_WRITE_TIMEOUT_MS', () => {
  it('defaults to a generous stall detector, not a latency target', () => {
    // Exceeding it aborts a destructive repair mid-run, so it is deliberately
    // far above any healthy write.
    expect(loadConfig(valid).AUDIT_WRITE_TIMEOUT_MS).toBe(10_000);
  });

  it('is overridable from the environment', () => {
    expect(loadConfig({ ...valid, AUDIT_WRITE_TIMEOUT_MS: '2500' }).AUDIT_WRITE_TIMEOUT_MS).toBe(
      2500,
    );
  });

  it('refuses a value so small that a healthy write would abort the audit', () => {
    expect(() => loadConfig({ ...valid, AUDIT_WRITE_TIMEOUT_MS: '0' })).toThrow(
      /AUDIT_WRITE_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...valid, AUDIT_WRITE_TIMEOUT_MS: '100' })).toThrow(
      /AUDIT_WRITE_TIMEOUT_MS/,
    );
  });

  it('refuses a value so large it stops bounding the row lock at all', () => {
    expect(() => loadConfig({ ...valid, AUDIT_WRITE_TIMEOUT_MS: '600000' })).toThrow(
      /AUDIT_WRITE_TIMEOUT_MS/,
    );
  });

  it('refuses text, rather than coercing it to NaN', () => {
    expect(() => loadConfig({ ...valid, AUDIT_WRITE_TIMEOUT_MS: 'soon' })).toThrow(
      /AUDIT_WRITE_TIMEOUT_MS/,
    );
  });
});

describe('probe timeout bounds', () => {
  // endpoints.timeout_ms is a Postgres `integer` column -- a value beyond
  // int4 range would boot fine here and only fail as an opaque database
  // error the first time an endpoint without its own timeoutMs is saved.
  it('refuses a PROBE_MAX_TIMEOUT_MS beyond the int4 column range', () => {
    expect(() => loadConfig({ ...valid, PROBE_MAX_TIMEOUT_MS: '2147483648' })).toThrow(
      /PROBE_MAX_TIMEOUT_MS/,
    );
  });

  it('refuses a PROBE_DEFAULT_TIMEOUT_MS beyond the int4 column range', () => {
    // PROBE_MAX_TIMEOUT_MS raised to match, so the "must not exceed
    // PROBE_MAX_TIMEOUT_MS" refine can't also explain the rejection --
    // only PROBE_DEFAULT_TIMEOUT_MS's own int4 bound should.
    expect(() =>
      loadConfig({
        ...valid,
        PROBE_MAX_TIMEOUT_MS: '2147483648',
        PROBE_DEFAULT_TIMEOUT_MS: '2147483648',
      }),
    ).toThrow(/PROBE_DEFAULT_TIMEOUT_MS/);
  });
});

describe('OAUTH_PROVIDER_MAX_RESPONSE_BYTES', () => {
  it('defaults to a generous but bounded size', () => {
    expect(loadConfig(valid).OAUTH_PROVIDER_MAX_RESPONSE_BYTES).toBe('1mb');
  });

  it('accepts a well-formed size', () => {
    expect(
      loadConfig({ ...valid, OAUTH_PROVIDER_MAX_RESPONSE_BYTES: '256kb' })
        .OAUTH_PROVIDER_MAX_RESPONSE_BYTES,
    ).toBe('256kb');
  });

  it('refuses unparseable text instead of silently removing the cap', () => {
    expect(() => loadConfig({ ...valid, OAUTH_PROVIDER_MAX_RESPONSE_BYTES: 'abc' })).toThrow(
      /OAUTH_PROVIDER_MAX_RESPONSE_BYTES/,
    );
  });

  it('refuses a bare number, which would mean bytes rather than a unit', () => {
    expect(() => loadConfig({ ...valid, OAUTH_PROVIDER_MAX_RESPONSE_BYTES: '64' })).toThrow(
      /OAUTH_PROVIDER_MAX_RESPONSE_BYTES/,
    );
  });

  it('refuses zero and negative sizes', () => {
    expect(() => loadConfig({ ...valid, OAUTH_PROVIDER_MAX_RESPONSE_BYTES: '0kb' })).toThrow(
      /OAUTH_PROVIDER_MAX_RESPONSE_BYTES/,
    );
  });

  it('refuses an absurd cap that would defeat the protection', () => {
    expect(() => loadConfig({ ...valid, OAUTH_PROVIDER_MAX_RESPONSE_BYTES: '5gb' })).toThrow(
      /OAUTH_PROVIDER_MAX_RESPONSE_BYTES/,
    );
  });
});

describe('cross-field rules', () => {
  it('refuses retention shorter than the rate-limit window', () => {
    // The housekeeping sweep would delete the evidence the limiter is still
    // counting, so a 15-minute limit would be bypassed after one minute.
    expect(() =>
      loadConfig({
        ...valid,
        AUTH_WINDOW_MS: '900000',
        AUTH_ATTEMPT_RETENTION_MS: '60000',
      }),
    ).toThrow(/AUTH_ATTEMPT_RETENTION_MS/);
  });

  it('accepts retention equal to the window', () => {
    expect(
      loadConfig({ ...valid, AUTH_WINDOW_MS: '60000', AUTH_ATTEMPT_RETENTION_MS: '60000' })
        .AUTH_ATTEMPT_RETENTION_MS,
    ).toBe(60_000);
  });

  it('accepts retention longer than the window', () => {
    expect(
      loadConfig({ ...valid, AUTH_WINDOW_MS: '60000', AUTH_ATTEMPT_RETENTION_MS: '3600000' })
        .AUTH_ATTEMPT_RETENTION_MS,
    ).toBe(3_600_000);
  });

  it('explains why, rather than only that it is invalid', () => {
    const message = (() => {
      try {
        loadConfig({ ...valid, AUTH_WINDOW_MS: '900000', AUTH_ATTEMPT_RETENTION_MS: '60000' });
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toContain('bypassed');
  });
});

describe('OAuth configuration', () => {
  it('defaults to disabled with no provider configured', () => {
    const cfg = loadConfig(valid);
    expect(cfg.OAUTH_ENABLED).toBe(false);
    expect(cfg.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(cfg.GITHUB_CLIENT_ID).toBeUndefined();
  });

  it('refuses a client id with no secret, for either provider', () => {
    expect(() => loadConfig({ ...valid, GOOGLE_CLIENT_ID: 'g-id' })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
    expect(() => loadConfig({ ...valid, GITHUB_CLIENT_ID: 'gh-id' })).toThrow(
      /GITHUB_CLIENT_SECRET/,
    );
  });

  it('refuses a secret with no client id', () => {
    expect(() => loadConfig({ ...valid, GOOGLE_CLIENT_SECRET: 'g-secret' })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
  });

  it('accepts a fully configured provider', () => {
    const cfg = loadConfig({
      ...valid,
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
    });
    expect(cfg.GOOGLE_CLIENT_ID).toBe('g-id');
  });

  it('refuses OAUTH_ENABLED with no redirect base url', () => {
    expect(() =>
      loadConfig({
        ...valid,
        OAUTH_ENABLED: 'true',
        WEB_BASE_URL: 'https://app.example.com',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
      }),
    ).toThrow(/OAUTH_REDIRECT_BASE_URL/);
  });

  it('refuses OAUTH_ENABLED with no web base url', () => {
    expect(() =>
      loadConfig({
        ...valid,
        OAUTH_ENABLED: 'true',
        OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
      }),
    ).toThrow(/WEB_BASE_URL/);
  });

  it('refuses OAUTH_ENABLED with no provider configured at all', () => {
    expect(() =>
      loadConfig({
        ...valid,
        OAUTH_ENABLED: 'true',
        OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
        WEB_BASE_URL: 'https://app.example.com',
      }),
    ).toThrow(/OAUTH_ENABLED/);
  });

  it('accepts a fully configured, enabled provider', () => {
    const cfg = loadConfig({
      ...valid,
      OAUTH_ENABLED: 'true',
      OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
      WEB_BASE_URL: 'https://app.example.com',
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
    });
    expect(cfg.OAUTH_ENABLED).toBe(true);
  });

  it('refuses a plain-http redirect base url when COOKIE_SECURE is on', () => {
    // A Secure state cookie is never returned to a plain-http callback, so
    // this combination fails every sign-in as OAUTH_STATE_INVALID rather than
    // at boot -- the same class of bug as a __Host- cookie without Secure.
    expect(() =>
      loadConfig({
        ...valid,
        OAUTH_ENABLED: 'true',
        OAUTH_REDIRECT_BASE_URL: 'http://api.example.com',
        WEB_BASE_URL: 'https://app.example.com',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
      }),
    ).toThrow(/OAUTH_REDIRECT_BASE_URL/);
  });

  it('accepts a plain-http redirect base url when COOKIE_SECURE is off', () => {
    // The local-development escape hatch: docker-compose and the e2e suite
    // both run this way against 127.0.0.1.
    const cfg = loadConfig({
      ...valid,
      COOKIE_SECURE: 'false',
      OAUTH_ENABLED: 'true',
      OAUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:3000',
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
    });
    expect(cfg.OAUTH_REDIRECT_BASE_URL).toBe('http://127.0.0.1:3000');
  });

  it('refuses a plain-http web base url when COOKIE_SECURE is on', () => {
    // The session cookie the callback just set is Secure in that
    // configuration; a plain-http web app can never read it back.
    expect(() =>
      loadConfig({
        ...valid,
        OAUTH_ENABLED: 'true',
        OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
        WEB_BASE_URL: 'http://app.example.com',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
      }),
    ).toThrow(/WEB_BASE_URL/);
  });

  it('refuses a non-http(s) base url even though it is a valid URL', () => {
    // z.url() alone accepts mailto: and every other WHATWG-valid scheme;
    // both base URLs are resolved as a base against a relative reference
    // (new URL(path, base)), which throws for a non-hierarchical scheme --
    // an accepted config must not fail on the first request instead of at
    // boot.
    expect(() =>
      loadConfig({
        ...valid,
        COOKIE_SECURE: 'false',
        OAUTH_ENABLED: 'true',
        OAUTH_REDIRECT_BASE_URL: 'mailto:ops@example.com',
        WEB_BASE_URL: 'http://127.0.0.1:5173',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
      }),
    ).toThrow(/OAUTH_REDIRECT_BASE_URL/);

    expect(() =>
      loadConfig({
        ...valid,
        COOKIE_SECURE: 'false',
        OAUTH_ENABLED: 'true',
        OAUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:3000',
        WEB_BASE_URL: 'mailto:ops@example.com',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
      }),
    ).toThrow(/WEB_BASE_URL/);
  });

  it('defaults the state ttl to ten minutes, matching GitHub’s code expiry', () => {
    expect(loadConfig(valid).OAUTH_STATE_TTL_MS).toBe(600_000);
  });

  it('rejects a state ttl too short to be a real limit', () => {
    expect(() => loadConfig({ ...valid, OAUTH_STATE_TTL_MS: '1000' })).toThrow(
      /OAUTH_STATE_TTL_MS/,
    );
  });

  it('defaults the provider http timeout to five seconds', () => {
    expect(loadConfig(valid).OAUTH_HTTP_TIMEOUT_MS).toBe(5000);
  });
});

describe('SESSION_RETENTION_DAYS', () => {
  it('is configurable rather than embedded in the sweep', () => {
    expect(loadConfig({ ...valid, SESSION_RETENTION_DAYS: '90' }).SESSION_RETENTION_DAYS).toBe(90);
  });

  it('defaults to 30 days', () => {
    expect(loadConfig(valid).SESSION_RETENTION_DAYS).toBe(30);
  });
});

describe('authentication bounds reject invalid values at boot', () => {
  // Every bound below is a guard. A guard with no failing-case test is not
  // known to work, so each one is driven past its limit here.
  const cases: [string, string][] = [
    // Argon2 below this is not memory-hard enough to satisfy NFR-10.
    ['ARGON2_MEMORY_KIB', '1024'],
    ['ARGON2_MEMORY_KIB', '0'],
    ['ARGON2_TIME_COST', '0'],
    ['ARGON2_PARALLELISM', '0'],
    ['ARGON2_PARALLELISM', '99'],
    // A short minimum would let a user choose a password Argon2 cannot save.
    ['PASSWORD_MIN_LENGTH', '4'],
    ['SESSION_TTL_DAYS', '0'],
    ['SESSION_TTL_DAYS', '400'],
    ['SESSION_RETENTION_DAYS', '0'],
    // A window of a few milliseconds is no limit at all.
    ['AUTH_WINDOW_MS', '10'],
    ['AUTH_MAX_PER_IP', '0'],
    ['AUTH_MAX_FAILURES_PER_EMAIL', '0'],
    ['AUTH_ATTEMPT_RETENTION_MS', '1000'],
    ['AUTH_SWEEP_INTERVAL_MS', '1000'],
  ];

  it.each(cases)('rejects %s=%s', (key, value) => {
    expect(() => loadConfig({ ...valid, [key]: value })).toThrow(new RegExp(key));
  });

  it.each([
    'ARGON2_MEMORY_KIB',
    'ARGON2_TIME_COST',
    'SESSION_TTL_DAYS',
    'AUTH_MAX_PER_IP',
    'AUTH_WINDOW_MS',
  ])('rejects a non-numeric %s rather than coercing it to NaN', (key) => {
    expect(() => loadConfig({ ...valid, [key]: 'lots' })).toThrow(new RegExp(key));
  });

  it('accepts the documented OWASP minimum for Argon2id', () => {
    const cfg = loadConfig({
      ...valid,
      ARGON2_MEMORY_KIB: '19456',
      ARGON2_TIME_COST: '2',
      ARGON2_PARALLELISM: '1',
    });
    expect([cfg.ARGON2_MEMORY_KIB, cfg.ARGON2_TIME_COST, cfg.ARGON2_PARALLELISM]).toEqual([
      19456, 2, 1,
    ]);
  });

  it('sweeps on its own schedule, not the retention period', () => {
    // These are different questions, and tying them together meant the sweep
    // never ran on an instance that restarted more often than the retention.
    const cfg = loadConfig({
      ...valid,
      AUTH_ATTEMPT_RETENTION_MS: '86400000',
      AUTH_SWEEP_INTERVAL_MS: '3600000',
    });
    expect(cfg.AUTH_SWEEP_INTERVAL_MS).toBeLessThan(cfg.AUTH_ATTEMPT_RETENTION_MS);
  });
});

describe('boolean settings are strict, not truthy', () => {
  // Both gate a security property, so a typo must stop the process rather than
  // being read as one value or the other. 'yes', '1' and 'TRUE' are the
  // spellings an operator actually reaches for.
  const booleans = [
    'SSRF_GUARD_ENABLED',
    'COOKIE_SECURE',
    'TRUST_PROXY',
    'OAUTH_ALLOW_EMAIL_LINKING',
    'API_DOCS_ENABLED',
  ];

  it.each(booleans)('%s accepts only the two documented spellings', (key) => {
    expect(loadConfig({ ...valid, [key]: 'true' })).toBeDefined();
    expect(loadConfig({ ...valid, [key]: 'false' })).toBeDefined();
  });

  it.each(
    booleans.flatMap((key) =>
      ['yes', 'no', '1', '0', 'TRUE', 'False', ''].map((v) => [key, v] as const),
    ),
  )('rejects %s=%s', (key, value) => {
    expect(() => loadConfig({ ...valid, [key]: value })).toThrow(new RegExp(key));
  });

  it('parses to a real boolean, not the string', () => {
    // A truthy string would make "false" enable the setting.
    const off = loadConfig({ ...valid, TRUST_PROXY: 'false', COOKIE_SECURE: 'false' });
    expect(off.TRUST_PROXY).toBe(false);
    expect(off.COOKIE_SECURE).toBe(false);

    const on = loadConfig({ ...valid, TRUST_PROXY: 'true', COOKIE_SECURE: 'true' });
    expect(on.TRUST_PROXY).toBe(true);
    expect(on.COOKIE_SECURE).toBe(true);
  });

  it('defaults to the safe value for each', () => {
    const cfg = loadConfig(valid);
    // Trusting a client-settable header by default would make the per-IP rate
    // limit bypassable; a non-Secure cookie by default would send the session
    // over plain HTTP.
    expect(cfg.TRUST_PROXY).toBe(false);
    expect(cfg.COOKIE_SECURE).toBe(true);
    expect(cfg.SSRF_GUARD_ENABLED).toBe(true);
    // Off: attaching a provider identity to an account matched by address is
    // the published account-takeover primitive.
    expect(cfg.OAUTH_ALLOW_EMAIL_LINKING).toBe(false);
    // Off: third-party browser code with its own XSS history, serving people
    // who build against this API rather than people who use it.
    expect(cfg.API_DOCS_ENABLED).toBe(false);
  });
});

describe('session bounds', () => {
  it('rejects a cap below one session', () => {
    expect(() => loadConfig({ ...valid, MAX_SESSIONS_PER_USER: '0' })).toThrow(
      /MAX_SESSIONS_PER_USER/,
    );
  });

  it('rejects an absurd cap, which would defeat the point of having one', () => {
    expect(() => loadConfig({ ...valid, MAX_SESSIONS_PER_USER: '100000' })).toThrow(
      /MAX_SESSIONS_PER_USER/,
    );
  });

  it('allows disabling the touch interval, writing on every request', () => {
    expect(loadConfig({ ...valid, SESSION_TOUCH_INTERVAL_MS: '0' }).SESSION_TOUCH_INTERVAL_MS).toBe(
      0,
    );
  });

  it('rejects a negative touch interval', () => {
    expect(() => loadConfig({ ...valid, SESSION_TOUCH_INTERVAL_MS: '-1' })).toThrow(
      /SESSION_TOUCH_INTERVAL_MS/,
    );
  });

  it('defaults to bounded sessions and a throttled write', () => {
    const cfg = loadConfig(valid);
    expect(cfg.MAX_SESSIONS_PER_USER).toBe(10);
    expect(cfg.SESSION_TOUCH_INTERVAL_MS).toBe(300_000);
  });
});

describe('scheduler bounds reject invalid values at boot', () => {
  it.each([
    ['SCHEDULER_TICK_MS', '99'],
    ['SCHEDULER_BATCH_SIZE', '0'],
    ['SCHEDULER_BATCH_SIZE', '10001'],
    ['SCHEDULER_LEASE_MS', '999'],
    ['SCHEDULER_LOAD_BUDGET_MS', '99'],
    ['SCHEDULER_LOAD_BUDGET_MS', '60001'],
    ['SCHEDULER_LEASE_SLACK_MS', '999'],
    ['SCHEDULER_SHUTDOWN_GRACE_MS', '-1'],
    ['SCHEDULER_ADOPT_JITTER_MAX_S', '3601'],
    ['PROBE_CONCURRENCY', '0'],
    ['PROBE_CONCURRENCY', '10001'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadConfig({ ...valid, [key]: value })).toThrow(new RegExp(key));
  });

  it('rejects a tick above its ceiling even where the drift budget allows it', () => {
    // The ceiling has to be proved on its own. A 2^31 tick is rejected by the
    // NFR-2 drift rule too -- Node would coerce such a delay to 1ms and warn,
    // turning the loop into a hot loop against the database (measured on
    // node:22-alpine, the pinned major) -- so asserting on that value proves
    // nothing about this bound. Removing `.max()` was confirmed to leave such
    // a test passing.
    //
    // A day-long allowed interval gives the drift rule an 8,640,000ms budget,
    // so 100s passes it and only the ceiling can reject it.
    expect(() =>
      loadConfig({
        ...valid,
        PROBE_ALLOWED_INTERVALS_S: '86400',
        PROBE_DEFAULT_INTERVAL_S: '86400',
        SCHEDULER_LOAD_BUDGET_MS: '100',
        SCHEDULER_TICK_MS: '100000',
      }),
    ).toThrow(/SCHEDULER_TICK_MS/);
  });

  it('rejects a fractional tick rather than truncating it', () => {
    expect(() => loadConfig({ ...valid, SCHEDULER_TICK_MS: '1000.5' })).toThrow(
      /SCHEDULER_TICK_MS/,
    );
  });

  it('rejects a probe interval below the floor the drift rule needs', () => {
    // 1s was accepted before M4. It makes the NFR-2 rule below unsatisfiable
    // at every legal value of both keys it names, which is a trap rather than
    // a check.
    expect(() => loadConfig({ ...valid, PROBE_ALLOWED_INTERVALS_S: '1,30' })).toThrow(
      /PROBE_ALLOWED_INTERVALS_S/,
    );
  });
});

describe('scheduler cross-field rules', () => {
  it('accepts the shipped defaults', () => {
    const cfg = loadConfig(valid);
    expect(cfg.SCHEDULER_LEASE_MS).toBeGreaterThanOrEqual(
      cfg.SCHEDULER_LOAD_BUDGET_MS + cfg.PROBE_MAX_TIMEOUT_MS + cfg.SCHEDULER_LEASE_SLACK_MS,
    );
    expect(cfg.SCHEDULER_SHUTDOWN_GRACE_MS).toBeGreaterThanOrEqual(
      cfg.SCHEDULER_LOAD_BUDGET_MS + cfg.PROBE_MAX_TIMEOUT_MS,
    );
    expect(cfg.SCHEDULER_SHUTDOWN_GRACE_MS).toBeLessThan(cfg.SCHEDULER_LEASE_MS);
    expect(cfg.SCHEDULER_TICK_MS + cfg.SCHEDULER_LOAD_BUDGET_MS).toBeLessThanOrEqual(
      (Math.min(...cfg.PROBE_ALLOWED_INTERVALS_S) * 1000) / 10,
    );
  });

  it('refuses a lease that a slow probe could outlive', () => {
    // Exactly one millisecond short of load + timeout + slack.
    expect(() =>
      loadConfig({
        ...valid,
        SCHEDULER_LOAD_BUDGET_MS: '1500',
        PROBE_MAX_TIMEOUT_MS: '30000',
        SCHEDULER_LEASE_SLACK_MS: '15000',
        SCHEDULER_LEASE_MS: '46499',
      }),
    ).toThrow(/SCHEDULER_LEASE_MS/);
  });

  it('accepts a lease exactly at the sum', () => {
    const cfg = loadConfig({
      ...valid,
      SCHEDULER_LOAD_BUDGET_MS: '1500',
      PROBE_MAX_TIMEOUT_MS: '30000',
      SCHEDULER_LEASE_SLACK_MS: '15000',
      SCHEDULER_LEASE_MS: '46500',
      SCHEDULER_SHUTDOWN_GRACE_MS: '31500',
    });
    expect(cfg.SCHEDULER_LEASE_MS).toBe(46500);
  });

  it('refuses a grace too short for one worst-case probe', () => {
    // Legal on its own bounds, and it would make the keep-the-lease path the
    // outcome of every ordinary restart.
    expect(() => loadConfig({ ...valid, SCHEDULER_SHUTDOWN_GRACE_MS: '1000' })).toThrow(
      /SCHEDULER_SHUTDOWN_GRACE_MS/,
    );
  });

  it('refuses a grace that can outlive the lease it releases', () => {
    expect(() =>
      loadConfig({ ...valid, SCHEDULER_SHUTDOWN_GRACE_MS: '60000', SCHEDULER_LEASE_MS: '60000' }),
    ).toThrow(/SCHEDULER_SHUTDOWN_GRACE_MS/);
  });

  it('refuses a tick and load budget that together break the NFR-2 drift budget', () => {
    // 30s interval gives a 3000ms budget; 1000 + 2500 exceeds it.
    expect(() =>
      loadConfig({ ...valid, SCHEDULER_TICK_MS: '1000', SCHEDULER_LOAD_BUDGET_MS: '2500' }),
    ).toThrow(/SCHEDULER_TICK_MS/);
  });

  it('counts the load budget, not the tick alone', () => {
    // The tick alone is well inside 10% of 30s; only the sum breaks it. This
    // is the case that passed before the loader term was added.
    expect(() =>
      loadConfig({ ...valid, SCHEDULER_TICK_MS: '500', SCHEDULER_LOAD_BUDGET_MS: '2600' }),
    ).toThrow(/SCHEDULER_TICK_MS/);
    expect(loadConfig({ ...valid, SCHEDULER_TICK_MS: '500' }).SCHEDULER_TICK_MS).toBe(500);
  });

  it('is satisfiable at every key floor, so no configuration is trapped', () => {
    // The rule must have a solution at the tightest legal values of the keys
    // its own message names. Before the interval floor rose to 10s and the
    // load floor fell to 100ms, `PROBE_ALLOWED_INTERVALS_S=5,30` could not
    // boot at any tick or budget the operator chose.
    const cfg = loadConfig({
      ...valid,
      PROBE_ALLOWED_INTERVALS_S: '10,30',
      PROBE_DEFAULT_INTERVAL_S: '30',
      SCHEDULER_TICK_MS: '100',
      SCHEDULER_LOAD_BUDGET_MS: '100',
    });
    expect(cfg.SCHEDULER_TICK_MS + cfg.SCHEDULER_LOAD_BUDGET_MS).toBeLessThanOrEqual(1000);
  });
});
