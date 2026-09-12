import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { generateToken, hashToken } from '../utils/session-token.js';
import { SessionRepository } from '../repositories/session.repository.js';

let ctx: TestDb;
let sessions: SessionRepository;
let users: UserRepository;
let userId: string;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  sessions = new SessionRepository(db);
  users = new UserRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  const user = await users.create('alice@example.com', '$argon2id$hash');
  userId = user!.id;
});

async function issue(expiresAt = inDays(30)) {
  const token = generateToken();
  const session = await sessions.create(userId, hashToken(token), expiresAt);
  return { token, session };
}

describe('create and findActive', () => {
  it('resolves a live session to its user', async () => {
    const { token } = await issue();

    const active = await sessions.findActive(hashToken(token));

    expect(active?.userId).toBe(userId);
    expect(active?.email).toBe('alice@example.com');
  });

  it('stores only the hash, never the token', async () => {
    const { token } = await issue();

    const { rows } = await ctx.pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM sessions',
    );
    const stored = rows[0].token_hash.toString('utf8');

    expect(stored).not.toContain(token);
    // And the stored value cannot be replayed as a cookie.
    expect(await sessions.findActive(Buffer.from(stored))).toBeUndefined();
  });

  it('does not resolve an unknown token', async () => {
    await issue();
    expect(await sessions.findActive(hashToken(generateToken()))).toBeUndefined();
  });
});

describe('expiry', () => {
  it('does not resolve a session whose expiry has passed', async () => {
    const { token } = await issue(new Date(Date.now() - 1000));
    expect(await sessions.findActive(hashToken(token))).toBeUndefined();
  });

  it('applies expiry at the moment asked about, not only at insert', async () => {
    const { token } = await issue(inDays(1));

    expect(await sessions.findActive(hashToken(token))).toBeDefined();
    expect(await sessions.findActive(hashToken(token), inDays(2))).toBeUndefined();
  });
});

describe('revocation', () => {
  it('stops resolving once revoked', async () => {
    const { token, session } = await issue();

    await sessions.revoke(session.id);

    expect(await sessions.findActive(hashToken(token))).toBeUndefined();
  });

  it('keeps the first revocation time when revoked twice', async () => {
    const { session } = await issue();
    await sessions.revoke(session.id, new Date('2026-01-01T00:00:00Z'));
    await sessions.revoke(session.id, new Date('2026-02-01T00:00:00Z'));

    const { rows } = await ctx.pool.query<{ revoked_at: Date }>('SELECT revoked_at FROM sessions');
    expect(rows[0].revoked_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('revokes every session for a user', async () => {
    const a = await issue();
    const b = await issue();

    expect(await sessions.revokeAllForUser(userId)).toBe(2);

    expect(await sessions.findActive(hashToken(a.token))).toBeUndefined();
    expect(await sessions.findActive(hashToken(b.token))).toBeUndefined();
  });

  it('can spare the caller̕s own session, which is what A-5 needs', async () => {
    // Changing a password logs you out everywhere else, not here.
    const mine = await issue();
    const other = await issue();

    expect(await sessions.revokeAllForUser(userId, mine.session.id)).toBe(1);

    expect(await sessions.findActive(hashToken(mine.token))).toBeDefined();
    expect(await sessions.findActive(hashToken(other.token))).toBeUndefined();
  });

  it('does not touch another user̕s sessions', async () => {
    const mine = await issue();
    const bob = await users.create('bob@example.com', 'h');
    const bobToken = generateToken();
    await sessions.create(bob!.id, hashToken(bobToken), inDays(30));

    await sessions.revokeAllForUser(userId);

    expect(await sessions.findActive(hashToken(bobToken))).toBeDefined();
    expect(await sessions.findActive(hashToken(mine.token))).toBeUndefined();
  });
});

describe('touch', () => {
  it('records activity without extending the session', async () => {
    // A fixed lifetime is what keeps revocation reasoning simple (A-3).
    const expiresAt = inDays(30);
    const { session } = await issue(expiresAt);

    await sessions.touch(session.id);

    const { rows } = await ctx.pool.query<{ expires_at: Date; last_seen_at: Date }>(
      'SELECT expires_at, last_seen_at FROM sessions',
    );
    expect(rows[0].expires_at.getTime()).toBe(expiresAt.getTime());
    expect(rows[0].last_seen_at.getTime()).toBeGreaterThanOrEqual(session.last_seen_at.getTime());
  });
});

describe('housekeeping', () => {
  it('counts only live sessions', async () => {
    await issue();
    const revoked = await issue();
    await issue(new Date(Date.now() - 1000));
    await sessions.revoke(revoked.session.id);

    expect(await sessions.countActive(userId)).toBe(1);
  });

  it('prunes sessions expired before the cutoff, and no others', async () => {
    await issue(new Date(Date.now() - 90 * 86_400_000));
    await issue(inDays(30));

    expect(await sessions.pruneExpired(new Date(Date.now() - 30 * 86_400_000))).toBe(1);
    expect(await sessions.countActive(userId)).toBe(1);
  });

  it('removes a user̕s sessions when the user goes', async () => {
    // ON DELETE CASCADE, so FR-5 does not leave orphans behind.
    const { token } = await issue();
    await ctx.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    expect(await sessions.findActive(hashToken(token))).toBeUndefined();
  });
});
