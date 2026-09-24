import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import {
  PARTITION_FAMILIES,
  addUtcDays,
  addUtcMonths,
  partitionName,
  periodsCovering,
} from '../utils/partition-periods.js';

export interface EnsureResult {
  /** `false` when another worker held the lock and this call did nothing. */
  ran: boolean;
  created: string[];
}

/**
 * Creates partitions ahead of need (docs/m5-plan.md §3.6).
 *
 * `CREATE TABLE (LIKE parent INCLUDING ALL)` then `ATTACH PARTITION`, not
 * `CREATE TABLE ... PARTITION OF`: the latter takes ACCESS EXCLUSIVE on the
 * parent, so every insert into an unrelated partition waits behind it
 * (measured: 2.04 s vs 0.065 s, plan §2.4.4).
 *
 * `IF NOT EXISTS` is not a lock -- two sessions creating one partition, one
 * fails with `relation already exists` (§2.4.5) -- so the whole pass runs under
 * an advisory transaction lock. There is deliberately no DEFAULT partition:
 * a missing one is a loud insert error, not a silent unbounded table (ADR-0007).
 */
@Injectable()
export class PartitionService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * The configured horizon from `now`. `wait: true` takes the blocking form of
   * the lock -- bootstrap must not skip because a peer is already creating.
   */
  async ensure(
    now: Date = new Date(),
    opts: { wait: boolean } = { wait: false },
  ): Promise<EnsureResult> {
    return this.ensureRange(
      now,
      addUtcDays(now, this.cfg.PARTITION_AHEAD_DAYS),
      addUtcMonths(now, this.cfg.PARTITION_AHEAD_MONTHS),
      opts,
    );
  }

  /** Any range, daily and monthly families separately. Also how tests create the past. */
  async ensureRange(
    from: Date,
    dailyTo: Date,
    monthlyTo: Date = dailyTo,
    opts: { wait: boolean } = { wait: true },
  ): Promise<EnsureResult> {
    return this.db.kysely.transaction().execute(async (trx) => {
      if (opts.wait) {
        await sql`SELECT pg_advisory_xact_lock(hashtext('probeboard:partitions'))`.execute(trx);
      } else {
        const got = await sql<{
          ok: boolean;
        }>`SELECT pg_try_advisory_xact_lock(hashtext('probeboard:partitions')) AS ok`.execute(trx);
        if (!got.rows[0]?.ok) return { ran: false, created: [] };
      }

      const created: string[] = [];
      for (const family of PARTITION_FAMILIES) {
        const to = family.kind === 'day' ? dailyTo : monthlyTo;
        for (const period of periodsCovering(family.kind, from, to)) {
          const name = partitionName(family, period);
          const exists = await sql<{ e: boolean }>`
            SELECT to_regclass(${name}) IS NOT NULL AS e
          `.execute(trx);
          if (exists.rows[0]?.e) continue;

          await sql`CREATE TABLE ${sql.id(name)} (LIKE ${sql.id(family.parent)} INCLUDING ALL)`.execute(
            trx,
          );
          await sql`
            ALTER TABLE ${sql.id(family.parent)} ATTACH PARTITION ${sql.id(name)}
            FOR VALUES FROM (${sql.lit(period.from.toISOString())}) TO (${sql.lit(period.to.toISOString())})
          `.execute(trx);
          created.push(name);
        }
      }
      return { ran: true, created };
    });
  }

  /**
   * Days of raw partitions that exist beyond `now`, read from the catalogue.
   * Below one day is what the maintenance loop reports as an error: inserts
   * are about to start failing.
   */
  async horizonDays(now: Date = new Date()): Promise<number> {
    const { rows } = await sql<{ latest: string | null }>`
      SELECT max(substring(c.relname FROM '_p([0-9]{8})$')) AS latest
      FROM   pg_class c
      JOIN   pg_inherits i ON i.inhrelid = c.oid
      WHERE  i.inhparent = 'probe_results'::regclass
    `.execute(this.db.kysely);
    const latest = rows[0]?.latest;
    if (!latest) return 0;
    const upper = Date.UTC(
      Number(latest.slice(0, 4)),
      Number(latest.slice(4, 6)) - 1,
      Number(latest.slice(6, 8)) + 1,
    );
    return Math.max(0, (upper - now.getTime()) / 86_400_000);
  }
}
