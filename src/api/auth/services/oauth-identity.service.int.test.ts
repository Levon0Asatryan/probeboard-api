import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import type { AppConfig } from '../../../core/config/schema.js';
import type { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import {
  OAuthIdentityRepository,
  type ProviderAccount,
} from '../repositories/oauth-identity.repository.js';
import { OAuthIdentityService } from './oauth-identity.service.js';

/**
 * The linking policy, against a real database.
 *
 * Against a real one rather than mocked repositories because the decisions
 * here are inseparable from the constraints that enforce them: two unique
 * indexes, a transaction, and what happens when two flows race. A mock would
 * assert that we called the mock.
 */

let ctx: TestDb;
let users: UserRepository;
let identities: OAuthIdentityRepository;

const BASE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
};

function makeService(env: Record<string, string> = {}): OAuthIdentityService {
  const cfg: AppConfig = loadConfig({ ...BASE, ...env });
  const db = { kysely: ctx.db } as DbService;
  return new OAuthIdentityService(cfg, db, users, identities);
}

const google = (
  accountId: string,
  email: string | null,
  emailVerified = true,
): ProviderAccount => ({
  provider: 'google',
  accountId,
  email,
  emailVerified,
});

const github = (
  accountId: string,
  email: string | null,
  emailVerified = true,
): ProviderAccount => ({
  provider: 'github',
  accountId,
  email,
  emailVerified,
});

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  identities = new OAuthIdentityRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
});

describe('a provider account nobody has yet', () => {
  it('creates an account with no password', async () => {
    const outcome = await makeService().signIn(google('sub-1', 'new@example.com'));

    expect(outcome.kind).toBe('created');
    const user = await users.findByEmail('new@example.com');
    expect(user?.password_hash).toBeNull();
  });

  it('records the provider’s verification of the address, because it is true', async () => {
    await makeService().signIn(google('sub-1', 'new@example.com', true));

    expect((await users.findByEmail('new@example.com'))?.email_verified_at).toBeInstanceOf(Date);
  });

  it('does not record verification the provider did not assert', async () => {
    await makeService().signIn(google('sub-1', 'new@example.com', false));

    expect((await users.findByEmail('new@example.com'))?.email_verified_at).toBeNull();
  });

  it('creates the account and the identity together, or not at all', async () => {
    await makeService().signIn(google('sub-1', 'new@example.com'));

    const user = await users.findByEmail('new@example.com');
    expect(await identities.countCredentials(user!.id)).toBe(1);
    expect((await identities.findOwner('google', 'sub-1'))?.userId).toBe(user!.id);
  });

  it('refuses when the provider gave no address, and creates nothing', async () => {
    // GitHub can decline to give one, and M7 has no way to tell an account
    // with no address that its API is down.
    const outcome = await makeService().signIn(github('12345', null));

    expect(outcome.kind).toBe('no_email');
    expect(await identities.findOwner('github', '12345')).toBeUndefined();
  });
});

describe('a provider account we already know', () => {
  it('signs in to the same account', async () => {
    const first = await makeService().signIn(google('sub-1', 'alice@example.com'));
    const second = await makeService().signIn(google('sub-1', 'alice@example.com'));

    expect(second).toEqual({ kind: 'signed_in', userId: (first as { userId: string }).userId });
  });

  it('reaches the same account after the provider address changes', async () => {
    // The identity is the pair, so a changed address is a display update and
    // nothing more. Keying on email would send this to a different account or
    // to none.
    const first = await makeService().signIn(google('sub-1', 'old@example.com'));
    const second = await makeService().signIn(google('sub-1', 'renamed@example.com'));

    expect(second).toEqual({ kind: 'signed_in', userId: (first as { userId: string }).userId });
    const [identity] = await identities.listForUser((first as { userId: string }).userId);
    expect(identity.provider_email).toBe('renamed@example.com');
  });

  it('creates no second account for the changed address', async () => {
    await makeService().signIn(google('sub-1', 'old@example.com'));
    await makeService().signIn(google('sub-1', 'renamed@example.com'));

    expect(await users.findByEmail('renamed@example.com')).toBeUndefined();
  });
});

describe('CVE-2026-53516: an address that already belongs to a password account', () => {
  /**
   * The attack this refusal exists for.
   *
   * The attacker registers with the victim's address by password. The victim
   * later signs in with Google, which asserts the same address and says it is
   * verified. A system that joins the two on that basis hands the attacker a
   * password that opens the victim's account, permanently.
   *
   * Better Auth shipped exactly this (CVSS 8.3): its check read the provider's
   * `email_verified` and never read the local row's own verification. Grafana
   * CVE-2023-3128 and Google Workspace domain re-registration are the same
   * mistake by other routes.
   */
  beforeEach(async () => {
    await users.create('victim@example.com', '$argon2id$attackers-password');
  });

  it('refuses, rather than joining the accounts', async () => {
    const outcome = await makeService().signIn(google('victim-sub', 'victim@example.com', true));

    expect(outcome).toEqual({ kind: 'account_exists' });
  });

  it('creates no identity, so nothing is left half-joined', async () => {
    await makeService().signIn(google('victim-sub', 'victim@example.com', true));

    expect(await identities.findOwner('google', 'victim-sub')).toBeUndefined();
    const victim = await users.findByEmail('victim@example.com');
    expect(await identities.listForUser(victim!.id)).toHaveLength(0);
  });

  it('does not promote the existing row to verified', async () => {
    // The step that made requireEmailVerification useless in the CVE: linking
    // flipped the attacker's unverified row to verified, and their password
    // then worked.
    await makeService().signIn(google('victim-sub', 'victim@example.com', true));

    expect((await users.findByEmail('victim@example.com'))?.email_verified_at).toBeNull();
  });

  it('still refuses with email linking turned on, because the local row is unverified', async () => {
    // The configuration flag is not the mitigation; reading *both* sides is.
    // Turning it on must not reopen the CVE.
    const permissive = makeService({ OAUTH_ALLOW_EMAIL_LINKING: 'true' });

    const outcome = await permissive.signIn(google('victim-sub', 'victim@example.com', true));

    expect(outcome).toEqual({ kind: 'account_exists' });
    expect(await identities.findOwner('google', 'victim-sub')).toBeUndefined();
  });

  it('refuses when the provider says the address is unverified, flag or no flag', async () => {
    const permissive = makeService({ OAUTH_ALLOW_EMAIL_LINKING: 'true' });

    expect(await permissive.signIn(google('victim-sub', 'victim@example.com', false))).toEqual({
      kind: 'account_exists',
    });
  });

  it('links only when the flag is on and both sides are verified', async () => {
    // The M7 state, reachable here only by writing email_verified_at directly,
    // because nothing sets it yet. Asserted so the intended behaviour is
    // pinned before the feature that produces it exists.
    const permissive = makeService({ OAUTH_ALLOW_EMAIL_LINKING: 'true' });
    await ctx.db
      .updateTable('users')
      .set({ email_verified_at: new Date() })
      .where('email', '=', 'victim@example.com')
      .execute();

    const outcome = await permissive.signIn(google('victim-sub', 'victim@example.com', true));

    expect(outcome.kind).toBe('linked');
  });

  it('is refused by default even then, since the flag is off', async () => {
    await ctx.db
      .updateTable('users')
      .set({ email_verified_at: new Date() })
      .where('email', '=', 'victim@example.com')
      .execute();

    expect(await makeService().signIn(google('victim-sub', 'victim@example.com', true))).toEqual({
      kind: 'account_exists',
    });
  });
});

describe('linking from an authenticated session', () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    aliceId = (await users.create('alice@example.com', '$argon2id$hash'))!.id;
    bobId = (await users.create('bob@example.com', '$argon2id$hash'))!.id;
  });

  it('attaches the provider account to the session’s user, not the asserted address', async () => {
    // The provider asserts Bob's address; the session says Alice. The session
    // wins, which is the whole reason linking is safe where implicit linking
    // is not.
    const outcome = await makeService().link(aliceId, google('sub-1', 'bob@example.com'));

    expect(outcome).toEqual({ kind: 'linked', userId: aliceId });
    expect((await identities.findOwner('google', 'sub-1'))?.userId).toBe(aliceId);
  });

  it('is a no-op when the account already holds that provider account', async () => {
    await makeService().link(aliceId, google('sub-1', 'alice@example.com'));

    expect(await makeService().link(aliceId, google('sub-1', 'alice@example.com'))).toEqual({
      kind: 'linked',
      userId: aliceId,
    });
    expect(await identities.listForUser(aliceId)).toHaveLength(1);
  });

  it('refuses a provider account that signs in to somebody else, and moves nothing', async () => {
    await makeService().link(aliceId, google('sub-1', 'alice@example.com'));

    expect(await makeService().link(bobId, google('sub-1', 'alice@example.com'))).toEqual({
      kind: 'identity_taken',
    });
    expect((await identities.findOwner('google', 'sub-1'))?.userId).toBe(aliceId);
  });

  it('distinguishes "already linked to this provider" from "identity taken"', async () => {
    // Two different unique indexes, two different things to tell the user.
    await makeService().link(aliceId, google('sub-1', 'alice@example.com'));

    expect(await makeService().link(aliceId, google('sub-2', 'alice@example.com'))).toEqual({
      kind: 'already_linked',
    });
  });

  it('allows one identity per provider on the same account', async () => {
    await makeService().link(aliceId, google('sub-1', 'alice@example.com'));

    expect(await makeService().link(aliceId, github('999', 'alice@example.com'))).toEqual({
      kind: 'linked',
      userId: aliceId,
    });
  });
});

describe('two flows racing', () => {
  it('creates one account, not two, for simultaneous first sign-ins', async () => {
    const service = makeService();

    const [a, b] = await Promise.all([
      service.signIn(google('sub-1', 'race@example.com')),
      service.signIn(google('sub-1', 'race@example.com')),
    ]);

    // One created it; the other found it. Neither may fail, and neither may
    // leave a second account behind.
    expect([a.kind, b.kind].sort()).toEqual(['created', 'signed_in']);
    expect((a as { userId: string }).userId).toBe((b as { userId: string }).userId);
  });

  it('leaves no account without an identity when a race is lost', async () => {
    const service = makeService();

    await Promise.all([
      service.signIn(google('sub-1', 'race@example.com')),
      service.signIn(google('sub-1', 'race@example.com')),
    ]);

    const user = await users.findByEmail('race@example.com');
    expect(await identities.countCredentials(user!.id)).toBe(1);
  });

  it('refuses the second when two different provider accounts claim one address', async () => {
    const service = makeService();

    const [a, b] = await Promise.all([
      service.signIn(google('sub-1', 'shared@example.com')),
      service.signIn(google('sub-2', 'shared@example.com')),
    ]);

    // Whichever loses must not be joined to the winner's account on the
    // strength of the address alone.
    expect([a.kind, b.kind].sort()).toEqual(['account_exists', 'created']);
  });
});
