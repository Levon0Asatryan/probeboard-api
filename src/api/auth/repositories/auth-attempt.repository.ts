import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database, AuthAttemptScope } from '../../../core/db/types.js';

export interface ReserveLimits {
  since: Date;
  maxPerIp: number;
  maxFailuresPerEmail: number;
  /**
   * Which per-address counter this attempt draws on: login's `ip` by
   * default, or registration's own `register`, so the two never exhaust
   * each other.
   */
  ipScope?: 'ip' | 'register';
}

export interface ReserveResult {
  allowed: boolean;
  scope?: AuthAttemptScope;
}

@Injectable()
export class AuthAttemptRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Decides and records in one transaction.
   *
   * Counting and then inserting as two steps is a read-modify-write on shared
   * state: concurrent requests all read a count below the limit and all
   * proceed. Measured before this was written — twenty parallel attempts were
   * admitted against a cap of five, so the limiter did nothing against the one
   * threat it exists for, since credential stuffing arrives in parallel.
   *
   * A transaction alone is not enough under READ COMMITTED, because each
   * transaction's count cannot see another's uncommitted insert. The advisory
   * lock is what serialises callers that share a key; callers with different
   * keys never contend.
   *
   * The attempt is recorded pessimistically as a failure. An in-flight attempt
   * counts against the limit until proven otherwise, which is the correct bias
   * — it fails closed.
   */
  async reserve(
    ip: string,
    email: string | undefined,
    limits: ReserveLimits,
    now: Date = new Date(),
  ): Promise<ReserveResult> {
    const ipScope = limits.ipScope ?? 'ip';
    return this.db.kysely.transaction().execute(async (trx) => {
      // Sorted, so two requests that share both keys always take them in the
      // same order and cannot deadlock against each other.
      const lockKeys = [
        `${ipScope}:${ip}`,
        ...(email === undefined ? [] : [`email:${email}`]),
      ].sort();
      for (const key of lockKeys) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(trx);
      }

      const fromIp = await this.count(trx, ipScope, ip, limits.since, false);
      if (fromIp >= limits.maxPerIp) return { allowed: false, scope: ipScope };

      if (email !== undefined) {
        const failures = await this.count(trx, 'email', email, limits.since, true);
        if (failures >= limits.maxFailuresPerEmail) {
          return { allowed: false, scope: 'email' as const };
        }
      }

      // Both rows in the same transaction: a half-written outcome would make
      // the two limits fire at different times.
      await trx
        .insertInto('auth_attempts')
        .values([
          { scope: ipScope, key: ip, succeeded: false, occurred_at: now },
          ...(email === undefined
            ? []
            : [{ scope: 'email' as const, key: email, succeeded: false, occurred_at: now }]),
        ])
        .execute();

      return { allowed: true };
    });
  }

  /**
   * Promotes a reserved attempt to a success.
   *
   * The IP row is marked rather than removed, because that limit counts every
   * attempt: one success among many is what a successful stuffing run looks
   * like. The account's failures are cleared, so someone who finally remembers
   * their password is not still locked out.
   */
  async markSucceeded(
    ip: string,
    email: string | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.kysely.transaction().execute(async (trx) => {
      await sql`
        UPDATE auth_attempts SET succeeded = true
        WHERE id = (
          SELECT id FROM auth_attempts
          WHERE scope = 'ip' AND key = ${ip} AND succeeded = false AND occurred_at <= ${now}
          ORDER BY occurred_at DESC, id DESC LIMIT 1
        )
      `.execute(trx);

      if (email !== undefined) {
        await trx
          .deleteFrom('auth_attempts')
          .where('scope', '=', 'email')
          .where('key', '=', email)
          .execute();
      }
    });
  }

  /** Attempts in the window, optionally only the failed ones. */
  countSince(
    scope: AuthAttemptScope,
    key: string,
    since: Date,
    onlyFailures: boolean,
  ): Promise<number> {
    return this.count(this.db.kysely, scope, key, since, onlyFailures);
  }

  private async count(
    executor: Transaction<Database> | DbService['kysely'],
    scope: AuthAttemptScope,
    key: string,
    since: Date,
    onlyFailures: boolean,
  ): Promise<number> {
    let query = executor
      .selectFrom('auth_attempts')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('scope', '=', scope)
      .where('key', '=', key)
      .where('occurred_at', '>=', since);

    if (onlyFailures) query = query.where('succeeded', '=', false);

    return (await query.executeTakeFirstOrThrow()).count;
  }

  /** Bounds the table. Without this it is an unbounded log of every attempt. */
  async pruneBefore(cutoff: Date): Promise<number> {
    const result = await this.db.kysely
      .deleteFrom('auth_attempts')
      .where('occurred_at', '<', cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
