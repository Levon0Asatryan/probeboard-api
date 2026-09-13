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

  it('keeps the provider’s claim on the identity, not on the account', async () => {
    // users.email_verified_at means probeboard verified the address, and the
    // linking policy reads it as independent evidence. A provider's claim
    // recorded there would satisfy the check it exists to corroborate.
    await makeService().signIn(google('sub-1', 'new@example.com', true));

    expect((await users.findByEmail('new@example.com'))?.email_verified_at).toBeNull();

    const user = await users.findByEmail('new@example.com');
    const [identity] = await identities.listForUser(user!.id);
    expect(identity.provider_email_verified).toBe(true);
  });

  it('records an unverified provider address as unverified on the identity', async () => {
    await makeService().signIn(google('sub-1', 'new@example.com', false));

    const user = await users.findByEmail('new@example.com');
    const [identity] = await identities.listForUser(user!.id);
    expect(identity.provider_email_verified).toBe(false);
  });

  it('does not let a provider-created account become implicitly linkable', async () => {
    // The hole this closes: an account created through Google would carry a
    // non-null email_verified_at, so with the flag on an unrelated GitHub
    // identity asserting the same address would attach itself automatically --
    // which is how the new holder of a recycled domain reaches the previous
    // owner's account.
    const permissive = makeService({ OAUTH_ALLOW_EMAIL_LINKING: 'true' });
    await permissive.signIn(google('google-sub', 'shared@example.com', true));

    const outcome = await permissive.signIn(github('99', 'shared@example.com', true));

    expect(outcome).toEqual({ kind: 'account_exists' });
    expect(await identities.findOwner('github', '99')).toBeUndefined();
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

describe('recording the login', () => {
  it('refreshes last_login_at on the paths a sign-in ordinarily takes', async () => {
    // Three paths answer signed_in: the fast lookup, the re-read under the
    // lock, and the resolution after a rolled-back attempt. This covers the
    // first two. The third is unreachable from here -- the same rolled-back
    // race the comments in the service label as unexercised -- and removing
    // its refresh does not fail this test. Said plainly rather than left to
    // look like coverage it is not.
    const service = makeService();
    await service.signIn(google('sub-1', 'first@example.com'));

    const user = await users.findByEmail('first@example.com');
    const before = (await identities.listForUser(user!.id))[0].last_login_at;

    const later = new Date(Date.now() + 60_000);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => service.signIn(google('sub-1', 'first@example.com'), later)),
    );

    expect(outcomes.every((o) => o.kind === 'signed_in')).toBe(true);
    const after = (await identities.listForUser(user!.id))[0].last_login_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
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

  it('says already_linked, not account_exists, when the account holds that provider', async () => {
    // With linking permitted and the address verified on both sides, the
    // insert can still be refused -- by the (user_id, provider) index, because
    // the account already has a Google identity. Reporting that the address is
    // taken sends the person to a remedy that does not exist.
    const permissive = makeService({ OAUTH_ALLOW_EMAIL_LINKING: 'true' });
    await ctx.db
      .updateTable('users')
      .set({ email_verified_at: new Date() })
      .where('email', '=', 'victim@example.com')
      .execute();
    const victim = await users.findByEmail('victim@example.com');
    await identities.link(victim!.id, google('first-sub', 'victim@example.com'));

    const outcome = await permissive.signIn(google('second-sub', 'victim@example.com', true));

    expect(outcome).toEqual({ kind: 'already_linked' });
  });

  it('signs in to the provider account\u2019s owner, not the address-matched account', async () => {
    // Precedence, at the level a user can observe it. The address matches an
    // account that already holds a Google identity, and the *incoming* Google
    // account belongs to somebody else entirely. Whose account the provider
    // account signs in to is decided by the identity, never by the address --
    // so this is an ordinary sign-in to its owner, not `already_linked`, which
    // would name the wrong account.
    //
    // This is satisfied by the re-read at the top of the transaction, not by
    // the ownership check after a failed insert: that one needs a link to
    // commit mid-transaction and the suite cannot force it. Said plainly so
    // nobody reads this as covering that branch.
    const permissive = makeService({ OAUTH_ALLOW_EMAIL_LINKING: 'true' });
    await ctx.db
      .updateTable('users')
      .set({ email_verified_at: new Date() })
      .where('email', '=', 'victim@example.com')
      .execute();
    const victim = await users.findByEmail('victim@example.com');
    await identities.link(victim!.id, google('first-sub', 'victim@example.com'));

    const other = (await users.create('other@example.com', '$argon2id$hash'))!;
    await identities.link(other.id, google('incoming-sub', 'other@example.com'));

    const outcome = await permissive.signIn(google('incoming-sub', 'victim@example.com', true));

    expect(outcome).toEqual({ kind: 'signed_in', userId: other.id });
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

  it('treats two simultaneous identical links as the success they are', async () => {
    // The loser of the race finds the link it asked for already made. That is
    // the operation succeeding, not somebody else holding the identity.
    const service = makeService();

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => service.link(aliceId, google('sub-1', 'alice@example.com'))),
    );

    expect(outcomes).toEqual(
      Array.from({ length: 6 }, () => ({ kind: 'linked', userId: aliceId })),
    );
    expect(await identities.listForUser(aliceId)).toHaveLength(1);
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
    // Ten rather than two on purpose. The bug this catches lived in the window
    // between reading the identity and reading the address: the loser saw no
    // identity, then saw the account the winner had just committed, and told
    // somebody signing in with their own Google account that the address was
    // already taken. Two requests hit that window rarely enough that it passed
    // locally and failed only in CI.
    const service = makeService();

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => service.signIn(google('sub-1', 'race@example.com'))),
    );

    const kinds = outcomes.map((o) => o.kind);
    expect(kinds.filter((k) => k === 'created')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'signed_in')).toHaveLength(9);

    // And every one of them reached the same account.
    const ids = new Set(outcomes.map((o) => (o as { userId?: string }).userId));
    expect(ids.size).toBe(1);
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

  it('never reports the address as taken to the account that owns it', async () => {
    // The exact regression: a first sign-in answering `account_exists` against
    // an account it had itself just created, which no retry can recover from
    // because the address stays taken forever.
    const service = makeService();

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => service.signIn(google('sub-9', 'self@example.com'))),
    );

    expect(outcomes.map((o) => o.kind)).not.toContain('account_exists');
  });

  it('resolves a race the address lock does not cover', async () => {
    // Same provider account, two different addresses -- the provider changed
    // the address between the flows. The two take *different* address locks,
    // so they do not serialise against each other, and the identity still has
    // to converge on one account rather than creating one per address.
    const service = makeService();

    const outcomes = await Promise.all([
      service.signIn(google('same-sub', 'first@example.com')),
      service.signIn(google('same-sub', 'second@example.com')),
    ]);

    expect(outcomes.map((o) => o.kind).sort()).toEqual(['created', 'signed_in']);
    const ids = new Set(outcomes.map((o) => (o as { userId?: string }).userId));
    expect(ids.size).toBe(1);
    // And the rolled-back attempt left no account behind.
    expect(await identities.countCredentials([...ids][0]!)).toBe(1);
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
