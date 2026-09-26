import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import type { DbService } from '../../../core/db/db.service.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { AuthAttemptRepository } from '../repositories/auth-attempt.repository.js';
import { AuthRateLimitService } from '../services/rate-limit.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  AUTH_WINDOW_MS: '60000',
  AUTH_MAX_PER_IP: '5',
  AUTH_MAX_FAILURES_PER_EMAIL: '3',
  AUTH_MAX_REGISTRATIONS_PER_IP: '4',
});

let ctx: TestDb;
let repo: AuthAttemptRepository;
let limiter: AuthRateLimitService;

const IP = '203.0.113.7';

beforeAll(() => {
  ctx = connectTestDb();
  repo = new AuthAttemptRepository({ kysely: ctx.db } as DbService);
  limiter = new AuthRateLimitService(cfg, repo);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.pool);
});

/** One failed attempt: admitted, then never promoted. */
const failedAttempt = (ip: string, email?: string) => limiter.admit(ip, email);

describe('per-IP limit', () => {
  it('admits up to the limit and then refuses', async () => {
    // A distinct address each time, so only the IP limit is in play.
    for (let i = 0; i < 5; i++) {
      expect((await limiter.admit(IP, `u${String(i)}@example.com`)).allowed).toBe(true);
    }

    const verdict = await limiter.admit(IP, 'fresh@example.com');
    expect(verdict.allowed).toBe(false);
    expect(verdict.scope).toBe('ip');
    expect(verdict.retryAfterSeconds).toBe(60);
  });

  it('counts successes too, so a hammering host is still throttled', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.admit(IP, `u${String(i)}@example.com`);
      await limiter.succeeded(IP, `u${String(i)}@example.com`);
    }

    expect((await limiter.admit(IP, 'next@example.com')).allowed).toBe(false);
  });

  it('does not throttle a different host', async () => {
    for (let i = 0; i < 6; i++) await failedAttempt(IP, `u${String(i)}@example.com`);

    expect((await limiter.admit('198.51.100.9', 'fresh@example.com')).allowed).toBe(true);
  });

  it('forgets attempts once the window has passed', async () => {
    const old = new Date(Date.now() - 120_000);
    for (let i = 0; i < 6; i++) await limiter.admit(IP, 'a@example.com', old);

    expect((await limiter.admit(IP, 'a@example.com')).allowed).toBe(true);
  });
});

describe('per-account limit', () => {
  it('locks an account after repeated failures from different hosts', async () => {
    // The threat the IP limit cannot see: one account, many hosts.
    for (let i = 0; i < 3; i++) await failedAttempt(`192.0.2.${String(i)}`, 'victim@example.com');

    const verdict = await limiter.admit('192.0.2.99', 'victim@example.com');
    expect(verdict.allowed).toBe(false);
    expect(verdict.scope).toBe('email');
  });

  it('counts only failures, so ordinary logins never lock an account', async () => {
    for (let i = 0; i < 10; i++) {
      const ip = `192.0.2.${String(i)}`;
      await limiter.admit(ip, 'busy@example.com');
      await limiter.succeeded(ip, 'busy@example.com');
    }

    expect((await limiter.admit('192.0.2.200', 'busy@example.com')).allowed).toBe(true);
  });

  it('clears failures on success, so remembering your password unlocks you', async () => {
    await failedAttempt('192.0.2.1', 'alice@example.com');
    await failedAttempt('192.0.2.1', 'alice@example.com');
    await limiter.admit('192.0.2.1', 'alice@example.com');
    await limiter.succeeded('192.0.2.1', 'alice@example.com');

    expect((await limiter.admit('192.0.2.9', 'alice@example.com')).allowed).toBe(true);
  });

  it('treats differently-cased addresses as one account', async () => {
    for (let i = 0; i < 3; i++) await failedAttempt(`192.0.2.${String(i)}`, 'Victim@Example.COM');

    expect((await limiter.admit('192.0.2.99', 'victim@example.com')).allowed).toBe(false);
  });

  it('does not lock a different account', async () => {
    for (let i = 0; i < 4; i++) await failedAttempt('192.0.2.1', 'victim@example.com');

    expect((await limiter.admit('198.51.100.1', 'other@example.com')).allowed).toBe(true);
  });

  it('applies the IP limit even when no email was supplied', async () => {
    for (let i = 0; i < 5; i++) await limiter.admit(IP, undefined);

    expect((await limiter.admit(IP, undefined)).allowed).toBe(false);
  });

  it('lets the account limit fire before the IP limit when one address is hammered', async () => {
    for (let i = 0; i < 3; i++) await failedAttempt(IP, 'victim@example.com');

    expect((await limiter.admit(IP, 'victim@example.com')).scope).toBe('email');
  });
});

describe('registration has its own per-address budget (#72)', () => {
  it('refuses registrations past their own limit, as scope register', async () => {
    for (let i = 0; i < 4; i++) expect((await limiter.admitRegistration(IP)).allowed).toBe(true);

    const verdict = await limiter.admitRegistration(IP);
    expect(verdict).toMatchObject({ allowed: false, scope: 'register', retryAfterSeconds: 60 });
  });

  // Each direction needs caps that a shared counter would trip: registrations
  // outnumbering login's cap for the first, login's attempts outnumbering the
  // registration cap for the second. Otherwise both pass either way.
  const withCaps = (registrations: string) =>
    new AuthRateLimitService(
      { ...cfg, AUTH_MAX_REGISTRATIONS_PER_IP: Number(registrations) },
      repo,
    );

  it('leaves login admitted after registrations exhaust theirs', async () => {
    // The NAT case: a room registering from one address must not lock that
    // address out of login. 8 registrations against a login cap of 5.
    const roomy = withCaps('8');
    for (let i = 0; i < 10; i++) await roomy.admitRegistration(IP);
    expect((await roomy.admitRegistration(IP)).allowed).toBe(false);

    expect((await roomy.admit(IP, 'someone@example.com')).allowed).toBe(true);
  });

  it('leaves registration admitted after login exhausts its budget', async () => {
    // 5 login attempts against a registration cap of 4.
    for (let i = 0; i < 6; i++) await failedAttempt(IP, `u${String(i)}@example.com`);
    expect((await limiter.admit(IP, 'next@example.com')).allowed).toBe(false);

    expect((await limiter.admitRegistration(IP)).allowed).toBe(true);
  });

  it('does not let a parallel burst exceed the registration cap', async () => {
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => limiter.admitRegistration('203.0.113.2')),
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(4);
  });
});

describe('admission is atomic', () => {
  it('does not let a parallel burst exceed the per-IP cap', async () => {
    // Twenty requests arrive at once. Before admission was atomic, all twenty
    // were admitted against a cap of five: each read a count below the limit
    // before any of them recorded anything.
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.admit('203.0.113.1', `u${String(i)}@x.com`)),
    );

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
  });

  it('does not let a parallel burst exceed the per-account cap', async () => {
    // This is the realistic shape of credential stuffing: one account, many
    // hosts, all at once.
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limiter.admit(`192.0.2.${String(i)}`, 'victim@example.com'),
      ),
    );

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(3);
  });

  it('records exactly one row per scope for each admitted attempt', async () => {
    // A half-written outcome would make the two limits fire at different times.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => limiter.admit(`198.51.100.${String(i)}`, 'a@x.com')),
    );

    const { rows } = await ctx.pool.query<{ scope: string; n: string }>(
      'SELECT scope, count(*) AS n FROM auth_attempts GROUP BY scope ORDER BY scope',
    );
    const byScope = Object.fromEntries(rows.map((r) => [r.scope, Number(r.n)]));
    expect(byScope.email).toBe(byScope.ip);
  });

  it('does not deadlock when two keys are contended from both directions', async () => {
    // Locks are taken in sorted order precisely so this cannot deadlock.
    await Promise.all([
      ...Array.from({ length: 10 }, () => limiter.admit('10.0.0.1', 'a@example.com')),
      ...Array.from({ length: 10 }, () => limiter.admit('10.0.0.2', 'a@example.com')),
    ]);
    expect(true).toBe(true);
  });
});

describe('durability', () => {
  it('survives a restart, because the counters are in the database', async () => {
    for (let i = 0; i < 5; i++) await failedAttempt(IP, `u${String(i)}@example.com`);

    const restarted = new AuthRateLimitService(
      cfg,
      new AuthAttemptRepository({ kysely: ctx.db } as DbService),
    );

    expect((await restarted.admit(IP, 'fresh@example.com')).allowed).toBe(false);
  });
});

describe('retention', () => {
  it('prunes attempts older than the cutoff, and no others', async () => {
    await limiter.admit(IP, undefined, new Date(Date.now() - 86_400_000 * 2));
    await limiter.admit(IP, undefined);

    expect(await repo.pruneBefore(new Date(Date.now() - 86_400_000))).toBe(1);
    expect(await repo.countSince('ip', IP, new Date(0), false)).toBe(1);
  });
});
