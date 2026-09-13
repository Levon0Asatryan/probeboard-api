import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database, OAuthIdentity, OAuthProvider } from '../../../core/db/types.js';

/** What a provider asserted about the person who just signed in. */
export interface ProviderAccount {
  provider: OAuthProvider;
  /** Google's `sub`, GitHub's numeric id. Never an email, never a username. */
  accountId: string;
  email: string | null;
  emailVerified: boolean;
}

/** An identity joined to the account it signs in to. */
export interface IdentityOwner {
  identityId: string;
  userId: string;
  email: string;
}

/**
 * Why an unlink did or did not happen.
 *
 * `last_credential` is a refusal, not a failure: removing it would leave an
 * account nobody can sign in to, which is data loss wearing a success code.
 */
export type UnlinkResult = 'unlinked' | 'last_credential' | 'not_found';

@Injectable()
export class OAuthIdentityRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Resolves a provider account to the probeboard account it signs in to.
   *
   * The lookup key is the pair, never the email address. Matching on email is
   * the account-takeover primitive this whole table exists to avoid.
   */
  async findOwner(provider: OAuthProvider, accountId: string): Promise<IdentityOwner | undefined> {
    return this.db.kysely
      .selectFrom('oauth_identities')
      .innerJoin('users', 'users.id', 'oauth_identities.user_id')
      .select([
        'oauth_identities.id as identityId',
        'oauth_identities.user_id as userId',
        'users.email as email',
      ])
      .where('oauth_identities.provider', '=', provider)
      .where('oauth_identities.provider_account_id', '=', accountId)
      .executeTakeFirst();
  }

  /**
   * Attaches a provider account to a user.
   *
   * Returns undefined when the provider account already belongs to somebody
   * else, or when the user already has an identity with this provider. Both
   * are refusals rather than errors: the caller turns them into a message, and
   * neither may silently move an identity between accounts — doing so would
   * sign the previous owner out of their own account on the say-so of whoever
   * holds the provider account today.
   *
   * `ON CONFLICT DO NOTHING` rather than a read followed by an insert: two
   * concurrent link attempts would both pass the read.
   */
  async link(
    userId: string,
    account: ProviderAccount,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<OAuthIdentity | undefined> {
    return (
      executor
        .insertInto('oauth_identities')
        .values({
          user_id: userId,
          provider: account.provider,
          provider_account_id: account.accountId,
          provider_email: account.email,
          provider_email_verified: account.emailVerified,
        })
        // Both unique indexes are covered: the provider account being taken, and
        // the user already holding this provider.
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .executeTakeFirst()
    );
  }

  /**
   * Records a sign-in through an identity that already exists.
   *
   * The provider's email is refreshed because it is display text and people
   * change addresses; it is still never a lookup key. Written as one UPDATE
   * rather than read-modify-write.
   */
  async recordLogin(
    identityId: string,
    account: ProviderAccount,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.kysely
      .updateTable('oauth_identities')
      .set({
        provider_email: account.email,
        provider_email_verified: account.emailVerified,
        last_login_at: now,
      })
      .where('id', '=', identityId)
      .execute();
  }

  /**
   * Removes one identity, unless it is the account's last way to sign in.
   *
   * Counting and then deleting as two steps is a read-modify-write on shared
   * state: two concurrent unlinks of different providers would each see two
   * credentials, each remove one, and leave an account nobody can reach. The
   * user row is locked for the duration so callers that share an account
   * serialise; callers on different accounts never contend.
   *
   * `FOR UPDATE` on `users` rather than on `oauth_identities` because the row
   * being protected is the account, and the rows being counted include one
   * that may not exist yet.
   */
  async unlink(userId: string, provider: OAuthProvider): Promise<UnlinkResult> {
    return this.db.kysely.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();

      if (!user) return 'not_found';

      // Existence first, then the credential count. The other order reports
      // `last_credential` for a provider that was never linked — refusing to
      // remove something that is not there, and telling the caller their
      // account is at risk when nothing happened.
      const existing = await trx
        .selectFrom('oauth_identities')
        .select('id')
        .where('user_id', '=', userId)
        .where('provider', '=', provider)
        .executeTakeFirst();

      if (!existing) return 'not_found';

      if ((await this.countCredentials(userId, trx)) <= 1) return 'last_credential';

      await trx.deleteFrom('oauth_identities').where('id', '=', existing.id).execute();

      return 'unlinked';
    });
  }

  /** Every identity on an account, for the settings page and for unlink. */
  async listForUser(userId: string): Promise<OAuthIdentity[]> {
    return this.db.kysely
      .selectFrom('oauth_identities')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * How many ways an account has to sign in: its password, plus each identity.
   *
   * One query across both tables, so the answer is a single consistent
   * snapshot rather than two reads that can disagree.
   */
  async countCredentials(
    userId: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<number> {
    const row = await executor
      .selectFrom('users')
      .select(
        sql<number>`(users.password_hash IS NOT NULL)::int + (
          SELECT count(*) FROM oauth_identities WHERE oauth_identities.user_id = users.id
        )::int`.as('credentials'),
      )
      .where('users.id', '=', userId)
      .executeTakeFirst();

    return row?.credentials ?? 0;
  }
}
