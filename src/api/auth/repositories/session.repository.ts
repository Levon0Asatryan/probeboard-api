import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database, Session } from '../../../core/db/types.js';

/** A session joined to the user it authenticates. */
export interface ActiveSession {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: Date;
}

@Injectable()
export class SessionRepository {
  constructor(private readonly db: DbService) {}

  async create(userId: string, tokenHash: Buffer, expiresAt: Date): Promise<Session> {
    return this.db.kysely
      .insertInto('sessions')
      .values({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Resolves a token hash to the session and its user, or undefined.
   *
   * Expiry and revocation are applied in the query rather than by the caller.
   * A caller that forgets the check is the whole vulnerability, and there is no
   * reason to let one exist.
   */
  async findActive(tokenHash: Buffer, now: Date = new Date()): Promise<ActiveSession | undefined> {
    const row = await this.db.kysely
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id as sessionId',
        'sessions.user_id as userId',
        'sessions.expires_at as expiresAt',
        'users.email as email',
      ])
      .where('sessions.token_hash', '=', tokenHash)
      .where('sessions.revoked_at', 'is', null)
      .where('sessions.expires_at', '>', now)
      .executeTakeFirst();

    return row;
  }

  /**
   * Records activity, at most once per `staleAfterMs`.
   *
   * Deliberately does not extend the session (A-3). The staleness check is a
   * clause of the same UPDATE rather than a read followed by a write, so
   * concurrent requests cannot both decide the row is due.
   *
   * Without the interval this is one write per authenticated read, which is
   * write amplification for a value nothing displays to the second.
   */
  async touch(sessionId: string, staleAfterMs = 0, now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - staleAfterMs);

    await this.db.kysely
      .updateTable('sessions')
      .set({ last_seen_at: now })
      .where('id', '=', sessionId)
      .where('last_seen_at', '<=', cutoff)
      .execute();
  }

  /**
   * Revokes every session beyond the newest `keep`.
   *
   * One statement, so two concurrent logins cannot each decide a different set
   * is surplus. The session just issued is the newest, so it always survives.
   */
  async revokeBeyondNewest(userId: string, keep: number, now: Date = new Date()): Promise<number> {
    const surplus = this.db.kysely
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('issued_at', 'desc')
      .orderBy('id', 'desc')
      .offset(keep);

    const result = await this.db.kysely
      .updateTable('sessions')
      .set({ revoked_at: now })
      .where('id', 'in', surplus)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  /** Revokes one session. Idempotent: revoking twice keeps the first time. */
  async revoke(sessionId: string, now: Date = new Date()): Promise<void> {
    await this.db.kysely
      .updateTable('sessions')
      .set({ revoked_at: now })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Revokes every session for a user, optionally sparing one.
   *
   * `except` is how changing a password logs out everywhere else without
   * logging out the person doing it (A-5).
   */
  async revokeAllForUser(
    userId: string,
    except?: string,
    now: Date = new Date(),
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<number> {
    let query = executor
      .updateTable('sessions')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);

    if (except) query = query.where('id', '!=', except);

    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Removes sessions that expired long enough ago to be uninteresting.
   *
   * Revoked and expired rows are kept for a grace period so an operator can
   * still answer "was this session live at the time?" after an incident.
   */
  async pruneExpired(before: Date): Promise<number> {
    const result = await this.db.kysely
      .deleteFrom('sessions')
      .where('expires_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Count of live sessions, for tests and for an operator. */
  async countActive(userId: string, now: Date = new Date()): Promise<number> {
    const row = await this.db.kysely
      .selectFrom('sessions')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirstOrThrow();
    return row.count;
  }
}
