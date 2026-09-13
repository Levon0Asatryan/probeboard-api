import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { normalizeEmail } from '../../../core/users/utils/email.js';
import {
  OAuthIdentityRepository,
  type ProviderAccount,
} from '../repositories/oauth-identity.repository.js';

/**
 * What happened, rather than what to tell the client.
 *
 * A union instead of thrown errors because this is the decision, and a
 * decision is easier to test exhaustively when every branch is a value. The
 * controller maps these to error codes and redirects.
 */
export type SignInOutcome =
  /** A known provider account. The ordinary case. */
  | { kind: 'signed_in'; userId: string }
  /** A provider account nobody had, with an address nobody had. */
  | { kind: 'created'; userId: string }
  /** The provider account now belongs to this user. */
  | { kind: 'linked'; userId: string }
  /**
   * The address belongs to an existing account and this provider account does
   * not. Refused, not joined: see `linkByEmailAllowed`.
   */
  | { kind: 'account_exists' }
  /** The provider account already signs in to somebody else's account. */
  | { kind: 'identity_taken' }
  /** This account already has an identity with this provider. */
  | { kind: 'already_linked' }
  /** The provider gave us no address we can deliver alerts to. */
  | { kind: 'no_email' };

/**
 * Decides what a completed provider flow means.
 *
 * This is the part of social login that carries the vulnerabilities, so it is
 * its own service with no HTTP, no provider and no token handling in it: the
 * inputs are "which provider account signed in" and "which account, if any, is
 * asking", and the output is a decision.
 *
 * The rule it exists to enforce: **an identity is `(provider, account_id)` and
 * an email address is not an identity.** Every published failure in this area
 * is a system that forgot that.
 */
@Injectable()
export class OAuthIdentityService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly users: UserRepository,
    private readonly identities: OAuthIdentityRepository,
  ) {}

  /**
   * A sign-in: find the account this provider account belongs to, or make one.
   */
  async signIn(account: ProviderAccount, now: Date = new Date()): Promise<SignInOutcome> {
    const owner = await this.identities.findOwner(account.provider, account.accountId);

    if (owner) {
      // The provider's address is refreshed because people change addresses
      // and it is display text. It is still not how we found this account.
      await this.identities.recordLogin(owner.identityId, account, now);
      return { kind: 'signed_in', userId: owner.userId };
    }

    // An account must be reachable by email: M7 tells people their API is
    // down by sending them mail, and an account nobody can be told about is
    // not worth creating. GitHub in particular can decline to give one.
    if (!account.email) return { kind: 'no_email' };

    return this.resolveUnknownIdentity(account, account.email, now);
  }

  /**
   * Decides what to do with a provider account we have never seen, under a
   * lock on the address.
   *
   * Every read here has to be inside the lock, and that is the whole point.
   * The first version looked the identity up, then looked the address up, and
   * concluded from the second read alone. Two simultaneous first sign-ins with
   * the same provider account then interleaved between those two reads: the
   * loser saw no identity, then saw the account the winner had just committed,
   * and answered `account_exists` -- telling somebody signing in with their
   * own Google account that the address was already taken, by themselves,
   * permanently.
   *
   * It passed locally and failed in CI, which is what a read-read window looks
   * like from the outside. The lock makes the interleaving deterministic
   * rather than a matter of who is faster: the loser now takes the lock only
   * after the winner has committed, and sees a complete picture.
   *
   * Keyed on the address rather than taken globally, so unrelated sign-ins
   * never contend. It is the idiom the rate limiter already uses.
   */
  private async resolveUnknownIdentity(
    account: ProviderAccount,
    email: string,
    now: Date,
  ): Promise<SignInOutcome> {
    const outcome = await this.db.kysely
      .transaction()
      .execute<SignInOutcome>(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`oauth:signup:${normalizeEmail(email)}`}))`.execute(
          trx,
        );

        // Re-read under the lock. Somebody may have created this identity
        // while we were waiting for it.
        const owner = await this.identities.findOwner(account.provider, account.accountId, trx);
        if (owner) {
          await this.identities.recordLogin(owner.identityId, account, now, trx);
          return { kind: 'signed_in', userId: owner.userId };
        }

        const existing = await this.users.findByEmail(email, trx);

        if (existing) {
          if (!this.linkByEmailAllowed(account, existing.email_verified_at)) {
            return { kind: 'account_exists' };
          }

          const linked = await this.identities.link(existing.id, account, now, trx);
          if (linked) return { kind: 'linked', userId: existing.id };

          // Two unique indexes can refuse that insert, and both can refuse it
          // at once. Order matters, and ownership of the incoming provider
          // account comes first: if somebody linked it while we were between
          // the re-read above and this insert, it now has an owner, and this
          // is an ordinary sign-in to *their* account whatever else is true of
          // the address-matched one.
          //
          // Checking the local clash first would answer `already_linked`,
          // which names the wrong account: it describes the account we matched
          // by address rather than the one the provider account actually signs
          // in to.
          //
          // Covered by a test that forces the interleaving rather than hoping
          // for it: a repository wrapper commits the competing identity on a
          // separate connection immediately before the insert below, so both
          // unique indexes refuse it. Removing this block makes that test
          // answer `already_linked`.
          const newOwner = await this.identities.findOwner(
            account.provider,
            account.accountId,
            trx,
          );
          if (newOwner) {
            await this.identities.recordLogin(newOwner.identityId, account, now, trx);
            return { kind: 'signed_in', userId: newOwner.userId };
          }

          // Nobody took it, so the refusal was the (user_id, provider) index:
          // the matched account already holds an identity for this provider.
          // `account_exists` here would send the person to a remedy that does
          // not exist, since linking is precisely what they cannot do.
          const clash = await this.identities
            .listForUser(existing.id, trx)
            .then((rows) => rows.some((r) => r.provider === account.provider));

          if (clash) return { kind: 'already_linked' };
          throw new IdentityRaceLost();
        }

        // The provider's assertion goes on the identity row, not on the user:
        // `users.email_verified_at` means we verified the address ourselves,
        // and the check below reads it as independent evidence. Recording a
        // provider's claim there would satisfy that check with the very thing
        // it exists to corroborate.
        const user = await this.users.createFromProvider(email, trx);
        if (!user) throw new IdentityRaceLost();

        // The account and its first identity commit together or not at all.
        // Failing between them would leave an account with no password and no
        // identity: unreachable, and worse than orphaned, because its address
        // then matches and every later sign-in is refused telling the person
        // to log in with a password that does not exist.
        const identity = await this.identities.link(user.id, account, now, trx);
        if (!identity) throw new IdentityRaceLost();

        return { kind: 'created', userId: user.id };
      })
      .catch((err: unknown) => {
        // A race the address lock does not cover: the identity index is keyed
        // on the provider account, the lock on the address, so two flows for
        // one provider account asserting different addresses do not serialise
        // against each other. Roll back and resolve against what the winner
        // committed.
        //
        // Forced by the same barrier in the suite: the account is created, the
        // identity insert then loses, and the test asserts the user is rolled
        // back rather than left holding the address with no way to sign in.
        if (err instanceof IdentityRaceLost) return undefined;
        throw err;
      });

    if (outcome) return outcome;

    const winner = await this.identities.findOwner(account.provider, account.accountId);
    if (!winner) return { kind: 'account_exists' };

    // Recorded here too. Every other path that answers `signed_in` refreshes
    // the identity, and a sign-in that reaches this one is no less a sign-in
    // for having lost a race -- leaving it out would make `last_login_at`
    // quietly wrong for exactly the requests that were hardest to get right.
    await this.identities.recordLogin(winner.identityId, account, now);
    return { kind: 'signed_in', userId: winner.userId };
  }

  /**
   * Attaches a provider account to an account the caller is already signed in
   * to.
   *
   * The user comes from the session, never from the address the provider
   * asserted, which is what makes linking safe where implicit linking is not.
   */
  async link(userId: string, account: ProviderAccount): Promise<SignInOutcome> {
    const owner = await this.identities.findOwner(account.provider, account.accountId);

    if (owner) {
      // Already ours: linking twice is not an error, it is a no-op. Somebody
      // else's is a refusal, never a transfer -- moving it would sign the
      // previous owner out of their own account on the say-so of whoever holds
      // the provider account today.
      return owner.userId === userId ? { kind: 'linked', userId } : { kind: 'identity_taken' };
    }

    const linked = await this.identities.link(userId, account);
    if (linked) return { kind: 'linked', userId };

    // The insert conflicted on one of two unique indexes. Which one decides
    // what the user is told, so ask rather than guess.
    const owned = await this.identities.findOwner(account.provider, account.accountId);

    // And the owner may be the caller: two link requests racing means the
    // loser finds the link it asked for already made. That is the operation
    // succeeding, not an identity belonging to somebody else -- the same
    // comparison the fast path above already makes.
    if (owned) {
      return owned.userId === userId ? { kind: 'linked', userId } : { kind: 'identity_taken' };
    }
    return { kind: 'already_linked' };
  }

  /**
   * Whether a provider sign-in may join an account it found by address.
   *
   * Two conditions, and the second is the one systems get wrong.
   *
   * The provider must say the address is verified — otherwise anyone who can
   * set an unverified address at any provider can claim anyone's account.
   *
   * And *our own* record of that address must be verified too. Reading only
   * the provider's claim is Better Auth CVE-2026-53516 exactly: the attacker
   * registers with the victim's address by password, the victim later signs in
   * with Google, Google says verified, the accounts are joined, and the
   * attacker's password now opens the victim's account. The local row is the
   * half that proves the address was ever the account owner's.
   *
   * Until M7 ships email verification no local row is verified, so this
   * returns false whatever the configuration says. That is deliberate: the
   * flag can be turned on early without turning the hole on with it.
   */
  private linkByEmailAllowed(account: ProviderAccount, localVerifiedAt: Date | null): boolean {
    if (!this.cfg.OAUTH_ALLOW_EMAIL_LINKING) return false;
    if (!account.emailVerified) return false;
    return localVerifiedAt !== null;
  }
}

/** Rolls the transaction back without becoming a 500. */
class IdentityRaceLost extends Error {}
