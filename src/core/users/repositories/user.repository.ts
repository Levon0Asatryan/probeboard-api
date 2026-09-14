import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database } from '../../db/types.js';
import type { User } from '../../db/types.js';
import { normalizeEmail } from '../utils/email.js';

/**
 * Data access for accounts.
 *
 * In `core` rather than `api` because M7's notifier reads a user's email from
 * the *worker* to send an incident alert. Authentication itself — hashing,
 * sessions, guards — never leaves the api.
 */
@Injectable()
export class UserRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Creates an account, or returns undefined if the address is taken.
   *
   * `ON CONFLICT DO NOTHING` rather than a read followed by a write: two
   * concurrent registrations of the same address would both pass the read and
   * one would then fail on the unique index (review rule g15). The caller
   * decides what to tell the client — A-1 requires that a taken address is
   * indistinguishable from a fresh one.
   */
  async create(
    email: string,
    passwordHash: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<User | undefined> {
    return this.insert(email, passwordHash, executor);
  }

  /**
   * Creates an account that signs in through a provider, with no password.
   *
   * `email_verified_at` is left null, deliberately, even though the provider
   * usually asserts the address is verified.
   *
   * That column means "probeboard verified this address", and a provider's
   * claim is not that. Writing the claim here would make it indistinguishable
   * from our own verification, and the linking policy reads this column to
   * decide whether an incoming identity may attach itself to an existing
   * account by address -- so a provider-created account would immediately
   * satisfy a check designed to require independent evidence. The new holder
   * of a recycled domain could then attach a second sign-in method to the
   * previous owner's account, which is the Google Workspace takeover this
   * design exists to avoid.
   *
   * The provider's claim is not lost: it is stored on the identity row, as
   * `oauth_identities.provider_email_verified`, where it is attributable to
   * the provider that made it. M7 sets this column when it sends and confirms
   * a verification mail.
   *
   * Returns undefined if the address is taken, exactly like `create`. The
   * caller must not then fall back to signing that account in; that fallback
   * is the published takeover (CVE-2026-53516).
   */
  async createFromProvider(
    email: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<User | undefined> {
    return this.insert(email, null, executor);
  }

  /**
   * No `emailVerifiedAt` parameter, deliberately.
   *
   * Nothing may set that column at creation time. It means probeboard verified
   * the address, which cannot be true of a row that has just come into
   * existence, and a parameter for it is an invitation to pass a provider's
   * claim -- the bug this file was just fixed for. M7 sets it with an update,
   * after a mail is sent and confirmed.
   */
  private async insert(
    email: string,
    passwordHash: string | null,
    executor: Kysely<Database>,
  ): Promise<User | undefined> {
    return executor
      .insertInto('users')
      .values({
        email: normalizeEmail(email),
        password_hash: passwordHash,
      })
      .onConflict((oc) => oc.column('email').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  findByEmail(
    email: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<User | undefined> {
    return executor
      .selectFrom('users')
      .selectAll()
      .where('email', '=', normalizeEmail(email))
      .executeTakeFirst();
  }

  findById(id: string): Promise<User | undefined> {
    return this.db.kysely.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Returns the updated row, or undefined if no such user exists.
   *
   * Takes an optional executor so a caller can commit this together with
   * another write — changing a password and revoking sessions must not be
   * separable.
   */
  async updatePasswordHash(
    id: string,
    passwordHash: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<User | undefined> {
    return executor
      .updateTable('users')
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Locks the user row for the rest of the caller's transaction, without
   * changing it.
   *
   * The one shared mutex every credential of an account hangs off, so two
   * writes that must not interleave -- issuing a session while revoking every
   * session, say -- serialize against each other by both taking this lock
   * first, rather than by locking whichever row each happens to touch. Must
   * be called before any lock this transaction takes on that user's other
   * rows (`sessions`, `oauth_identities`): a consistent users-first order is
   * what keeps two transactions that both need both locks from deadlocking.
   *
   * Returns whether the user still exists, so a caller does not have to make
   * a second trip to find out.
   */
  async lockForUpdate(id: string, executor: Kysely<Database> = this.db.kysely): Promise<boolean> {
    const row = await executor
      .selectFrom('users')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }
}
