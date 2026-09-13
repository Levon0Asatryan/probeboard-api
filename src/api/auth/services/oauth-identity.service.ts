import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
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

    const existing = await this.users.findByEmail(account.email);

    if (existing) {
      if (!this.linkByEmailAllowed(account, existing.email_verified_at)) {
        return { kind: 'account_exists' };
      }

      const linked = await this.identities.link(existing.id, account);
      // Lost a race with a concurrent link of the same provider account.
      return linked ? { kind: 'linked', userId: existing.id } : { kind: 'identity_taken' };
    }

    return this.createAccount(account);
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
    return owned ? { kind: 'identity_taken' } : { kind: 'already_linked' };
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

  /**
   * Creates an account and its first identity, together or not at all.
   *
   * Two statements, one transaction. Creating the user and then failing to
   * insert the identity leaves an account with no password and no identity:
   * nobody can sign in to it, and it is worse than merely orphaned, because
   * its address now matches — so every later attempt is refused as
   * `account_exists` and the person is told to log in with a password that
   * does not exist. Permanently, with no way out.
   */
  private async createAccount(account: ProviderAccount): Promise<SignInOutcome> {
    const email = account.email;
    if (!email) return { kind: 'no_email' };

    const outcome = await this.db.kysely
      .transaction()
      .execute<SignInOutcome>(async (trx) => {
        // The provider's assertion is recorded because it is true, not because
        // anything matches on it.
        const verifiedAt = account.emailVerified ? new Date() : null;
        const user = await this.users.createFromProvider(email, verifiedAt, trx);

        // Somebody registered this address between the read above and here.
        if (!user) return { kind: 'account_exists' };

        const identity = await this.identities.link(user.id, account, trx);

        // Somebody else claimed this provider account in the same window. Roll
        // the user back rather than leave one nobody can reach; the caller
        // retries and finds the account they made.
        if (!identity) throw new IdentityRaceLost();

        return { kind: 'created', userId: user.id };
      })
      .catch((err: unknown) => {
        if (err instanceof IdentityRaceLost) return undefined;
        throw err;
      });

    if (outcome) return outcome;

    // Retry once, from the top. The winner of the race has created the
    // identity, so this resolves to `signed_in` rather than looping.
    const owner = await this.identities.findOwner(account.provider, account.accountId);
    return owner ? { kind: 'signed_in', userId: owner.userId } : { kind: 'account_exists' };
  }
}

/** Rolls the transaction back without becoming a 500. */
class IdentityRaceLost extends Error {}
