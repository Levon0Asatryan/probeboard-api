import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { OAuthIdentityRepository, type ProviderAccount } from './oauth-identity.repository.js';

let ctx: TestDb;
let identities: OAuthIdentityRepository;
let users: UserRepository;
let aliceId: string;
let bobId: string;

const googleAccount = (accountId: string, email = 'alice@example.com'): ProviderAccount => ({
  provider: 'google',
  accountId,
  email,
  emailVerified: true,
});

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  identities = new OAuthIdentityRepository(db);
  users = new UserRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  aliceId = (await users.create('alice@example.com', '$argon2id$hash'))!.id;
  bobId = (await users.create('bob@example.com', '$argon2id$hash'))!.id;
});

describe('accounts without a password', () => {
  it('can be created, which the schema previously forbade', async () => {
    const user = await users.createFromProvider('carol@example.com', new Date());

    expect(user?.password_hash).toBeNull();
    expect(user?.email_verified_at).toBeInstanceOf(Date);
  });

  it('still cannot duplicate an address', async () => {
    const duplicate = await users.createFromProvider('alice@example.com', new Date());

    // The caller must not read this as "sign them in to the existing account".
    // That fallback is CVE-2026-53516.
    expect(duplicate).toBeUndefined();
  });
});

describe('findOwner', () => {
  it('resolves a provider account to its probeboard account', async () => {
    await identities.link(aliceId, googleAccount('sub-1'));

    const owner = await identities.findOwner('google', 'sub-1');

    expect(owner?.userId).toBe(aliceId);
    expect(owner?.email).toBe('alice@example.com');
  });

  it('does not resolve the same id under a different provider', async () => {
    await identities.link(aliceId, googleAccount('shared-id'));

    expect(await identities.findOwner('github', 'shared-id')).toBeUndefined();
  });

  it('keys on the provider account, never on the email address', async () => {
    await identities.link(aliceId, googleAccount('sub-1', 'alice@example.com'));

    // Bob's provider account asserts Alice's address. If the lookup fell back
    // to email this would return Alice, which is the takeover.
    expect(await identities.findOwner('google', 'sub-2')).toBeUndefined();
  });
});

describe('link', () => {
  it('refuses a provider account that already belongs to someone else', async () => {
    await identities.link(aliceId, googleAccount('sub-1'));

    const stolen = await identities.link(bobId, googleAccount('sub-1'));

    expect(stolen).toBeUndefined();
    // And the original is untouched: an identity is never moved.
    expect((await identities.findOwner('google', 'sub-1'))?.userId).toBe(aliceId);
  });

  it('refuses a second identity with the same provider on one account', async () => {
    await identities.link(aliceId, googleAccount('sub-1'));

    expect(await identities.link(aliceId, googleAccount('sub-2'))).toBeUndefined();
  });

  it('allows one identity per provider on one account', async () => {
    await identities.link(aliceId, googleAccount('sub-1'));

    const github = await identities.link(aliceId, {
      provider: 'github',
      accountId: '12345',
      email: 'alice@users.noreply.github.com',
      emailVerified: true,
    });

    expect(github).toBeDefined();
    expect(await identities.listForUser(aliceId)).toHaveLength(2);
  });

  it('admits only one of two concurrent links of the same provider account', async () => {
    // Two callbacks arriving together is the ordinary case for a double-click,
    // and the unique index is what has to hold, not the code around it.
    const [first, second] = await Promise.all([
      identities.link(aliceId, googleAccount('race')),
      identities.link(bobId, googleAccount('race')),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe('recordLogin', () => {
  it('refreshes the display email without changing which account is reached', async () => {
    const identity = await identities.link(aliceId, googleAccount('sub-1', 'old@example.com'));

    await identities.recordLogin(identity!.id, googleAccount('sub-1', 'new@example.com'));

    const [refreshed] = await identities.listForUser(aliceId);
    expect(refreshed.provider_email).toBe('new@example.com');
    // The address Alice signs in with is unchanged; only the provider's is.
    expect((await identities.findOwner('google', 'sub-1'))?.email).toBe('alice@example.com');
  });
});

describe('countCredentials', () => {
  it('counts the password and each identity', async () => {
    expect(await identities.countCredentials(aliceId)).toBe(1);

    await identities.link(aliceId, googleAccount('sub-1'));
    expect(await identities.countCredentials(aliceId)).toBe(2);
  });

  it('counts an account with no password as having only its identities', async () => {
    const carol = await users.createFromProvider('carol@example.com', new Date());
    await identities.link(carol!.id, { ...googleAccount('sub-9'), email: 'carol@example.com' });

    expect(await identities.countCredentials(carol!.id)).toBe(1);
  });

  it('is zero for an account that does not exist', async () => {
    expect(await identities.countCredentials('00000000-0000-0000-0000-000000000000')).toBe(0);
  });
});

describe('unlink', () => {
  it('removes an identity when the account keeps a way in', async () => {
    await identities.link(aliceId, googleAccount('sub-1'));

    expect(await identities.unlink(aliceId, 'google')).toBe('unlinked');
    expect(await identities.listForUser(aliceId)).toHaveLength(0);
  });

  it('refuses to remove the last credential, and removes nothing', async () => {
    const carol = (await users.createFromProvider('carol@example.com', new Date()))!;
    await identities.link(carol.id, { ...googleAccount('sub-9'), email: 'carol@example.com' });

    expect(await identities.unlink(carol.id, 'google')).toBe('last_credential');
    // The refusal has to leave the account reachable, not merely report so.
    expect(await identities.listForUser(carol.id)).toHaveLength(1);
  });

  it('reports nothing to remove for a provider that is not linked', async () => {
    expect(await identities.unlink(aliceId, 'github')).toBe('not_found');
  });

  it('never leaves an account with no way in, even under concurrent unlinks', async () => {
    // The failure this prevents: two unlinks of different providers each read
    // "two credentials", each remove one, and the account is unreachable.
    const carol = (await users.createFromProvider('carol@example.com', new Date()))!;
    await identities.link(carol.id, { ...googleAccount('sub-9'), email: 'carol@example.com' });
    await identities.link(carol.id, {
      provider: 'github',
      accountId: '999',
      email: 'carol@example.com',
      emailVerified: true,
    });

    const results = await Promise.all([
      identities.unlink(carol.id, 'google'),
      identities.unlink(carol.id, 'github'),
    ]);

    expect(results.filter((r) => r === 'unlinked')).toHaveLength(1);
    expect(results.filter((r) => r === 'last_credential')).toHaveLength(1);
    expect(await identities.countCredentials(carol.id)).toBe(1);
  });
});
