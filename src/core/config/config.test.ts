import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const valid = { DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard' };

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
