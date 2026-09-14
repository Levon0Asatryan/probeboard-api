import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, ConfigModule } from '../../../core/config/config.module.js';
import { DbModule } from '../../../core/db/db.module.js';
import { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { truncateAll } from '../../../testing/database.js';
import { AuthModule } from '../auth.module.js';
import { PasswordService } from '../services/password.service.js';
import { AuthRateLimitService } from '../services/rate-limit.service.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { generateToken, hashToken } from '../utils/session-token.js';

/**
 * The whole of M1's logic, resolved through the real Nest container against a
 * real PostgreSQL.
 *
 * The other integration tests construct services by hand, which proves the
 * queries work but not that the module graph does. "AuthModule dependencies
 * initialized" in a log proves only that injection resolved -- not that the
 * wiring produces working behaviour. This is the gap that let the version
 * prefix bug through in M0: asserting a thing was configured rather than that
 * it works.
 */

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let passwords: PasswordService;
let sessions: SessionRepository;
let users: UserRepository;
let limiter: AuthRateLimitService;
let db: DbService;

const IP = '203.0.113.10';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.HEADER_ENCRYPTION_KEY = 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';
  process.env.AUTH_MAX_FAILURES_PER_EMAIL = '3';
  process.env.AUTH_MAX_PER_IP = '50';

  const moduleRef = await Test.createTestingModule({
    // LoggerModule because DbService injects PinoLogger. The real AppModule
    // provides it at the root; a graph without it fails to resolve at boot,
    // which is exactly the kind of thing this test exists to catch.
    imports: [
      ConfigModule,
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      DbModule,
      AuthModule,
    ],
  }).compile();

  app = await moduleRef.init();

  passwords = app.get(PasswordService);
  sessions = app.get(SessionRepository);
  limiter = app.get(AuthRateLimitService);
  users = app.get(UserRepository);
  db = app.get(DbService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const pool = (db as unknown as { pool: import('pg').Pool }).pool;
  await truncateAll(pool);
});

/** Everything register would do, once PR 3 gives it a controller. */
async function register(email: string, password: string) {
  const user = await users.create(email, await passwords.hash(password));
  if (!user) return undefined;

  const token = generateToken();
  const ttlDays = app.get<{ SESSION_TTL_DAYS: number }>(APP_CONFIG).SESSION_TTL_DAYS;
  await sessions.create(user.id, hashToken(token), new Date(Date.now() + ttlDays * 86_400_000));
  return { user, token };
}

/** Everything login would do. */
async function login(email: string, password: string, ip = IP) {
  // Admission records the attempt as part of the decision, so a parallel burst
  // cannot slip past the cap.
  const verdict = await limiter.admit(ip, email);
  if (!verdict.allowed) return { outcome: 'rate_limited' as const };

  const user = await users.findByEmail(email);

  // Every path spends one Argon2 verification (A-2), including an account
  // with no password, which signs in through a provider. Mirrors
  // AuthService.login; the property itself is asserted there.
  const ok =
    user?.password_hash != null
      ? await passwords.verify(user.password_hash, password)
      : await passwords.verifyDummy(password);

  if (!ok || !user) return { outcome: 'rejected' as const };
  await limiter.succeeded(ip, email);

  const token = generateToken();
  await sessions.create(user.id, hashToken(token), new Date(Date.now() + 86_400_000));
  return { outcome: 'ok' as const, token, user };
}

describe('the module graph', () => {
  it('resolves every service through the real container', () => {
    for (const service of [passwords, sessions, limiter, users, db]) {
      expect(service).toBeDefined();
    }
  });

  it('gives services the configuration, not a default', () => {
    expect(app.get<{ ARGON2_MEMORY_KIB: number }>(APP_CONFIG).ARGON2_MEMORY_KIB).toBe(8192);
  });
});

describe('register then log in', () => {
  it('completes the whole flow', async () => {
    const registered = await register('alice@example.com', 'correct horse battery');
    expect(registered).toBeDefined();

    // The session issued at registration authenticates immediately (A-3).
    const fromRegister = await sessions.findActive(hashToken(registered!.token));
    expect(fromRegister?.email).toBe('alice@example.com');

    const result = await login('alice@example.com', 'correct horse battery');
    expect(result.outcome).toBe('ok');

    const active = await sessions.findActive(hashToken(result.token!));
    expect(active?.userId).toBe(registered!.user.id);
  });

  it('stores no plaintext password anywhere in the row', async () => {
    const password = 'correct horse battery';
    await register('alice@example.com', password);

    const { rows } = await db.kysely.executeQuery(
      db.kysely.selectFrom('users').selectAll().compile(),
    );
    expect(JSON.stringify(rows)).not.toContain(password);
    expect((rows[0] as { password_hash: string }).password_hash.startsWith('$argon2id$')).toBe(
      true,
    );
  });

  it('rejects a wrong password', async () => {
    await register('alice@example.com', 'right');
    expect((await login('alice@example.com', 'wrong')).outcome).toBe('rejected');
  });

  it('refuses a second account on the same address, however it is cased', async () => {
    await register('alice@example.com', 'first');
    expect(await register('ALICE@Example.com', 'second')).toBeUndefined();
  });
});

describe('A-2: login reveals nothing about which half was wrong', () => {
  it('returns the same outcome for an unknown address and a wrong password', async () => {
    await register('alice@example.com', 'right');

    expect((await login('nobody@example.com', 'whatever')).outcome).toBe('rejected');
    expect((await login('alice@example.com', 'wrong')).outcome).toBe('rejected');
  });

  it('takes comparable time on both paths', async () => {
    await register('alice@example.com', 'right');

    const time = async (fn: () => Promise<unknown>) => {
      const runs: number[] = [];
      for (let i = 0; i < 6; i++) {
        const t = process.hrtime.bigint();
        await fn();
        runs.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      return runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    };

    // A fresh address each time, so the account lockout does not interfere.
    let n = 0;
    const unknown = await time(() => login(`nobody${String(n++)}@example.com`, 'whatever'));
    const wrongPassword = await time(() => login('alice@example.com', 'wrong'));

    // Without verifyDummy the unknown-address path skips Argon2 entirely and
    // comes back an order of magnitude faster, which is the leak.
    const ratio = Math.max(unknown, wrongPassword) / Math.min(unknown, wrongPassword);
    expect(ratio).toBeLessThan(3);
  });
});

describe('A-6: rate limiting applies to the real flow', () => {
  it('locks the account after repeated failures and stops verifying passwords', async () => {
    await register('victim@example.com', 'right');

    for (let i = 0; i < 3; i++) {
      expect((await login('victim@example.com', 'wrong', `192.0.2.${String(i)}`)).outcome).toBe(
        'rejected',
      );
    }

    // Even the correct password is refused while locked out.
    const locked = await login('victim@example.com', 'right', '192.0.2.99');
    expect(locked.outcome).toBe('rate_limited');
  });

  it('a successful login clears the account̕s failures', async () => {
    await register('alice@example.com', 'right');

    await login('alice@example.com', 'wrong');
    await login('alice@example.com', 'wrong');
    expect((await login('alice@example.com', 'right')).outcome).toBe('ok');

    // Two failures earlier no longer count toward the limit.
    await login('alice@example.com', 'wrong');
    await login('alice@example.com', 'wrong');
    expect((await login('alice@example.com', 'right')).outcome).toBe('ok');
  });
});

describe('A-5: changing a password logs out everywhere else', () => {
  it('keeps the current session and revokes the others', async () => {
    const registered = await register('alice@example.com', 'old password');
    const elsewhere = await login('alice@example.com', 'old password');
    const another = await login('alice@example.com', 'old password');

    expect(await sessions.countActive(registered!.user.id)).toBe(3);

    // What the change-password endpoint will do in PR 3.
    const current = await sessions.findActive(hashToken(elsewhere.token!));
    await users.updatePasswordHash(registered!.user.id, await passwords.hash('new password'));
    await sessions.revokeAllForUser(registered!.user.id, current!.sessionId);

    expect(await sessions.findActive(hashToken(elsewhere.token!))).toBeDefined();
    expect(await sessions.findActive(hashToken(registered!.token))).toBeUndefined();
    expect(await sessions.findActive(hashToken(another.token!))).toBeUndefined();
    expect(await sessions.countActive(registered!.user.id)).toBe(1);
  });

  it('the old password stops working and the new one starts', async () => {
    await register('alice@example.com', 'old password');
    const user = await users.findByEmail('alice@example.com');
    await users.updatePasswordHash(user!.id, await passwords.hash('new password'));

    expect((await login('alice@example.com', 'old password')).outcome).toBe('rejected');
    expect((await login('alice@example.com', 'new password')).outcome).toBe('ok');
  });
});
