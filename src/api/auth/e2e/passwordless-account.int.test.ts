import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ConfigModule } from '../../../core/config/config.module.js';
import { DbModule } from '../../../core/db/db.module.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { createTestPool, truncateAll } from '../../../testing/database.js';
import { AuthModule } from '../auth.module.js';
import { AuthService, InvalidCredentialsError, NoPasswordSetError } from '../auth.service.js';

/**
 * An account created through a provider has no password.
 *
 * That is a new shape for every code path that reads `password_hash`, and the
 * dangerous one is login: an early return for "no password to check" would
 * answer faster than a real verification, and the timing difference is a list
 * of which accounts sign in through a provider — a list worth phishing rather
 * than brute-forcing. A-2 does not stop applying because an account happens to
 * have no password.
 */

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let auth: AuthService;
let users: UserRepository;
/** Its own pool, so the test does not reach inside DbService to truncate. */
let pool: Pool;

const PASSWORD = 'a perfectly fine password';

/** A well-formed session id that belongs to nobody: these tests spare none. */
const NO_SESSION = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  // Production Argon2 cost, unlike the other suites, which turn it down for
  // speed. The timing assertion below needs the hash to dominate the
  // measurement: at 8 MiB and one pass the verification is faster than the
  // database round trip and the rate-limiter transaction around it, so
  // removing the dummy verification changes the total by less than the noise
  // and the test passes against the bug. Verified by removing the guard.
  process.env.ARGON2_MEMORY_KIB = '19456';
  process.env.ARGON2_TIME_COST = '2';
  process.env.LOG_LEVEL = 'fatal';
  // High enough that the measurements below never meet the limiter.
  process.env.AUTH_MAX_PER_IP = '500';
  process.env.AUTH_MAX_FAILURES_PER_EMAIL = '500';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      DbModule,
      AuthModule,
    ],
  }).compile();

  app = await moduleRef.init();
  auth = app.get(AuthService);
  users = app.get(UserRepository);
  pool = createTestPool();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  await auth.register('withpassword@example.com', PASSWORD, '198.51.100.1');
  await users.createFromProvider('provideronly@example.com', new Date());
});

/** Median of several samples: one timing is noise, a median is a signal. */
async function medianMs(run: () => Promise<unknown>, samples = 7): Promise<number> {
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    await run().catch(() => undefined);
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)];
}

describe('login against an account with no password', () => {
  it('is rejected with the same error as a wrong password', async () => {
    await expect(auth.login('provideronly@example.com', PASSWORD, '198.51.100.2')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('does not leak, through timing, which accounts have no password', async () => {
    const wrongPassword = await medianMs(() =>
      auth.login('withpassword@example.com', 'the wrong password', '198.51.100.3'),
    );
    const noPassword = await medianMs(() =>
      auth.login('provideronly@example.com', 'the wrong password', '198.51.100.4'),
    );
    const unknownAddress = await medianMs(() =>
      auth.login('nobody@example.com', 'the wrong password', '198.51.100.5'),
    );

    // Every path spends one Argon2 verification, so the three medians sit
    // close together. Returning early instead makes the no-password path skip
    // the hash entirely and finish in a fraction of the time, which is what
    // this ratio catches; the bound is loose enough not to flake on a busy
    // machine and tight enough to fail against that bug, both confirmed by
    // running it with the guard removed.
    const fastest = Math.min(wrongPassword, noPassword, unknownAddress);
    const slowest = Math.max(wrongPassword, noPassword, unknownAddress);

    expect(slowest / fastest).toBeLessThan(2);
  });

  it('still admits the account it should', async () => {
    // The account has no password, but the address is not poisoned: a password
    // account with a different address keeps working.
    const session = await auth.login('withpassword@example.com', PASSWORD, '198.51.100.6');
    expect(session.token).toMatch(/^pbs_/);
  });
});

describe('changing a password that does not exist', () => {
  it('is refused with a distinct error rather than a crash', async () => {
    const user = await users.findByEmail('provideronly@example.com');

    await expect(
      auth.changePassword(user!.id, NO_SESSION, 'anything', 'a brand new password', '198.51.100.7'),
    ).rejects.toThrow(NoPasswordSetError);
  });

  it('leaves the account with no password, rather than setting one', async () => {
    const user = await users.findByEmail('provideronly@example.com');

    await auth
      .changePassword(user!.id, NO_SESSION, 'anything', 'a brand new password', '198.51.100.8')
      .catch(() => undefined);

    expect((await users.findById(user!.id))?.password_hash).toBeNull();
  });
});

describe('accounts that do have a password', () => {
  it('are unaffected by the column becoming nullable', async () => {
    const user = await users.findByEmail('withpassword@example.com');
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);

    await auth.changePassword(
      user!.id,
      NO_SESSION,
      PASSWORD,
      'a replacement password',
      '198.51.100.9',
    );

    await expect(
      auth.login('withpassword@example.com', 'a replacement password', '198.51.100.10'),
    ).resolves.toBeDefined();
  });
});
