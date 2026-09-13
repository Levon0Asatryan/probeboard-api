import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import {
  OAuthAuthorizationRepository,
  type NewAuthorization,
} from './oauth-authorization.repository.js';

let ctx: TestDb;
let pending: OAuthAuthorizationRepository;
let users: UserRepository;
let userId: string;

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000);

function signin(overrides: Partial<NewAuthorization> = {}): NewAuthorization {
  return {
    provider: 'google',
    mode: 'signin',
    state: `state-${Math.random().toString(36).slice(2)}`,
    codeVerifier: 'verifier',
    nonce: 'nonce',
    returnTo: '/',
    expiresAt: inMinutes(10),
    ...overrides,
  };
}

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  pending = new OAuthAuthorizationRepository(db);
  users = new UserRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  userId = (await users.create('alice@example.com', '$argon2id$hash'))!.id;
});

describe('consume', () => {
  it('returns the flow and destroys it', async () => {
    const row = await pending.create(signin({ returnTo: '/services' }));

    const taken = await pending.consume(row.id, row.state, row.provider);

    expect(taken?.code_verifier).toBe('verifier');
    expect(taken?.return_to).toBe('/services');
  });

  it('is single use, so a replayed callback finds nothing', async () => {
    const row = await pending.create(signin());

    expect(await pending.consume(row.id, row.state, row.provider)).toBeDefined();
    expect(await pending.consume(row.id, row.state, row.provider)).toBeUndefined();
  });

  it('admits only one of two simultaneous replays', async () => {
    // A read followed by a delete would let both proceed, which is
    // authorization code injection with extra steps.
    const row = await pending.create(signin());

    const results = await Promise.all([
      pending.consume(row.id, row.state, row.provider),
      pending.consume(row.id, row.state, row.provider),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a state that belongs to a different flow', async () => {
    const mine = await pending.create(signin());
    const theirs = await pending.create(signin());

    expect(await pending.consume(mine.id, theirs.state, mine.provider)).toBeUndefined();
    // And refusing must not have consumed it.
    expect(await pending.consume(mine.id, mine.state, mine.provider)).toBeDefined();
  });

  it('refuses a flow completed through the wrong provider (OAuth mix-up)', async () => {
    // A flow started for google must not be completable through github's
    // callback, even presenting the row's own id and state -- otherwise a
    // relayed authorization response can reuse one provider's state and PKCE
    // challenge at the other, whose callback then processes it with the
    // original verifier.
    const row = await pending.create(signin({ provider: 'google' }));

    expect(await pending.consume(row.id, row.state, 'github')).toBeUndefined();
    // Not consumed by the mismatched attempt.
    expect(await pending.consume(row.id, row.state, 'google')).toBeDefined();
  });

  it('refuses an id that does not exist', async () => {
    const row = await pending.create(signin());

    expect(
      await pending.consume('00000000-0000-0000-0000-000000000000', row.state, row.provider),
    ).toBeUndefined();
  });

  it('refuses an expired flow', async () => {
    const row = await pending.create(signin({ expiresAt: inMinutes(-1) }));

    expect(await pending.consume(row.id, row.state, row.provider)).toBeUndefined();
  });

  it('applies expiry as a clause, not by trusting the caller to check', async () => {
    // The same row is refused or admitted purely by the clock passed in, so a
    // caller cannot forget the check: there is nowhere to forget it.
    const row = await pending.create(signin({ expiresAt: inMinutes(10) }));

    expect(await pending.consume(row.id, row.state, row.provider, inMinutes(20))).toBeUndefined();
    expect(await pending.consume(row.id, row.state, row.provider, inMinutes(1))).toBeDefined();
  });
});

describe('state uniqueness', () => {
  it('refuses two flows with the same state', async () => {
    await pending.create(signin({ state: 'fixed' }));

    await expect(pending.create(signin({ state: 'fixed' }))).rejects.toThrow();
  });
});

describe('mode', () => {
  it('accepts a link flow carrying the user it will attach to', async () => {
    const row = await pending.create(signin({ mode: 'link', userId }));

    expect((await pending.consume(row.id, row.state, row.provider))?.user_id).toBe(userId);
  });

  it('refuses a link flow with no user, which would attach to nobody', async () => {
    await expect(pending.create(signin({ mode: 'link' }))).rejects.toThrow();
  });

  it('refuses a signin flow carrying a user, which would silently be a link', async () => {
    await expect(pending.create(signin({ mode: 'signin', userId }))).rejects.toThrow();
  });
});

describe('housekeeping', () => {
  it('discards a flow without completing it', async () => {
    const row = await pending.create(signin());

    await pending.discard(row.id);

    expect(await pending.consume(row.id, row.state, row.provider)).toBeUndefined();
  });

  it('prunes expired rows and leaves live ones', async () => {
    await pending.create(signin({ expiresAt: inMinutes(-5) }));
    await pending.create(signin({ expiresAt: inMinutes(-5) }));
    const live = await pending.create(signin({ expiresAt: inMinutes(10) }));

    expect(await pending.pruneExpired()).toBe(2);
    expect(await pending.consume(live.id, live.state, live.provider)).toBeDefined();
  });
});

describe('cascade', () => {
  it('removes a user’s pending link flows when the user is deleted', async () => {
    const row = await pending.create(signin({ mode: 'link', userId }));

    await ctx.db.deleteFrom('users').where('id', '=', userId).execute();

    expect(await pending.consume(row.id, row.state, row.provider)).toBeUndefined();
  });
});
