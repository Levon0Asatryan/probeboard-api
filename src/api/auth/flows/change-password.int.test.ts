import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigModule } from '../../../core/config/config.module.js';
import { DbModule } from '../../../core/db/db.module.js';
import { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/user.repository.js';
import { truncateAll } from '../../../testing/database.js';
import { AuthModule } from '../auth.module.js';
import { AuthService } from '../auth.service.js';
import { SessionRepository } from '../sessions/session.repository.js';
import { generateToken, hashToken } from '../sessions/session-token.js';

/**
 * Changing a password and revoking the other sessions must commit together.
 *
 * If the password changed and the revocation failed, the caller would get a
 * 500 while every session they were trying to invalidate stayed live — and
 * changing a password is precisely what someone does when they believe a
 * session is compromised.
 */

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let auth: AuthService;
let users: UserRepository;
let sessions: SessionRepository;
let db: DbService;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';
  process.env.LOG_LEVEL = 'fatal';

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
  sessions = app.get(SessionRepository);
  db = app.get(DbService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll((db as unknown as { pool: import('pg').Pool }).pool);
});

async function setup() {
  await auth.register('alice@example.com', 'correct horse battery', '203.0.113.1');
  const user = (await users.findByEmail('alice@example.com'))!;

  const issue = async () => {
    const token = generateToken();
    const session = await sessions.create(
      user.id,
      hashToken(token),
      new Date(Date.now() + 86_400_000),
    );
    return { token, id: session.id };
  };

  return { user, mine: await issue(), other: await issue() };
}

describe('changePassword', () => {
  it('changes the password and revokes the other sessions', async () => {
    const { user, mine, other } = await setup();

    await auth.changePassword(
      user.id,
      mine.id,
      'correct horse battery',
      'a brand new one',
      '203.0.113.9',
    );

    expect(await sessions.findActive(hashToken(mine.token))).toBeDefined();
    expect(await sessions.findActive(hashToken(other.token))).toBeUndefined();
    expect((await users.findByEmail('alice@example.com'))!.password_hash).not.toBe(
      user.password_hash,
    );
  });

  it('leaves the password unchanged when the revocation fails', async () => {
    // Without one transaction the password would be replaced while every
    // session it was meant to invalidate stayed live.
    const { user, mine, other } = await setup();

    const spy = vi
      .spyOn(sessions, 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      auth.changePassword(
        user.id,
        mine.id,
        'correct horse battery',
        'a brand new one',
        '203.0.113.9',
      ),
    ).rejects.toThrow(/connection terminated/);

    spy.mockRestore();

    // The old password still works, and nothing was revoked.
    expect((await users.findByEmail('alice@example.com'))!.password_hash).toBe(user.password_hash);
    expect(await sessions.findActive(hashToken(other.token))).toBeDefined();
  });

  it('rejects a wrong current password without changing anything', async () => {
    const { user, mine, other } = await setup();

    await expect(
      auth.changePassword(user.id, mine.id, 'not the password', 'a brand new one', '203.0.113.9'),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect((await users.findByEmail('alice@example.com'))!.password_hash).toBe(user.password_hash);
    expect(await sessions.findActive(hashToken(other.token))).toBeDefined();
  });
});
