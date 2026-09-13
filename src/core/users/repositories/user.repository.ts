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
    return this.insert(email, passwordHash, null, executor);
  }

  /**
   * Creates an account that signs in through a provider, with no password.
   *
   * `emailVerifiedAt` comes from the provider's own assertion. It is recorded
   * because it is true — the provider verified it — and not because it makes
   * anything easier: it is never used to match an incoming identity to an
   * existing account. See the linking policy in docs/social-login-plan.md.
   *
   * Returns undefined if the address is taken, exactly like `create`. The
   * caller must not then fall back to signing that account in; that fallback
   * is the published takeover (CVE-2026-53516).
   */
  async createFromProvider(
    email: string,
    emailVerifiedAt: Date | null,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<User | undefined> {
    return this.insert(email, null, emailVerifiedAt, executor);
  }

  private async insert(
    email: string,
    passwordHash: string | null,
    emailVerifiedAt: Date | null,
    executor: Kysely<Database>,
  ): Promise<User | undefined> {
    return executor
      .insertInto('users')
      .values({
        email: normalizeEmail(email),
        password_hash: passwordHash,
        email_verified_at: emailVerifiedAt,
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
}
