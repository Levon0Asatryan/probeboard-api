import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Client } from 'pg';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import {
  PARTITION_FAMILIES,
  nextPeriodStart,
  periodFromSuffix,
  type PartitionFamily,
} from '../utils/partition-periods.js';

export interface RetentionResult {
  /** Another worker held the retention lock; this call did nothing. */
  skipped: boolean;
  dropped: string[];
  /** Left in place on purpose; each is logged at `error` by the caller. */
  blocked: { partition: string; reason: string }[];
  /** Detach could not finish (a reader held the partition); finished next tick. */
  deferred: string[];
}

type Guard = 'raw' | 'stats' | 'none';

export const RETENTION_APPLICATION_NAME = 'probeboard-retention';

/** Identifiers here are `parent_pYYYYMMDD` names already validated by `periodFromSuffix`. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface Expired {
  name: string;
  lo: Date;
  hi: Date;
}

/**
 * Retention by partition removal (docs/m5-plan.md §3.7, ADR-0007).
 *
 * Per family, oldest first: finish any interrupted detach, **guard**, then
 * `DETACH ... CONCURRENTLY` and `DROP`. No `DELETE` anywhere.
 *
 * Why not a plain `DROP`: it takes ACCESS EXCLUSIVE on the **parent**, so every
 * insert into an unrelated partition queues behind it -- measured 2.04 s behind
 * a held transaction, against 0.07 s for the concurrent detach (plan §2.4.4).
 *
 * The guard is what makes dropping safe: a raw partition holding a row the
 * rollup has not folded is never dropped, and neither is a stats partition an
 * unfolded raw row still targets. It **fails closed**: a missing watermark row
 * counts as "nothing folded".
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(RetentionService.name) private readonly logger: PinoLogger,
  ) {}

  private daysFor(parent: string): number {
    switch (parent) {
      case 'probe_results':
        return this.cfg.RETENTION_RAW_DAYS;
      case 'claim_log':
        return this.cfg.RETENTION_CLAIM_LOG_DAYS;
      case 'probe_stats_m1':
        return this.cfg.RETENTION_M1_DAYS;
      case 'probe_stats_h1':
        return this.cfg.RETENTION_H1_DAYS;
      default:
        throw new Error(`no retention configured for ${parent}`);
    }
  }

  private guardFor(parent: string): Guard {
    if (parent === 'probe_results') return 'raw';
    if (parent === 'claim_log') return 'none';
    return 'stats';
  }

  /**
   * Single-flight across workers by a **transaction-level** advisory lock, held
   * by an otherwise idle transaction for the whole pass. There is nothing to
   * unlock and nothing to leak: commit, rollback or a dead connection all release
   * it, so no cleanup step can fail and leave a pooled session still holding it.
   * Two workers must not race a detach and a drop of the same partition.
   */
  async run(now: Date = new Date()): Promise<RetentionResult> {
    return this.db.kysely.transaction().execute(async (lockTx) => {
      const got = await sql<{ ok: boolean }>`
        SELECT pg_try_advisory_xact_lock(hashtext('probeboard:retention')) AS ok
      `.execute(lockTx);
      const result: RetentionResult = { skipped: false, dropped: [], blocked: [], deferred: [] };
      if (!got.rows[0]?.ok) return { ...result, skipped: true };
      for (const family of PARTITION_FAMILIES) await this.runFamily(family, now, result);
      return result;
    });
  }

  private async runFamily(
    family: PartitionFamily,
    now: Date,
    result: RetentionResult,
  ): Promise<void> {
    const cutoff = now.getTime() - this.daysFor(family.parent) * 86_400_000;
    const guard = this.guardFor(family.parent);

    // 1. Recover an interrupted detach: the partition already passed its guard.
    for (const name of await this.pendingDetaches(family.parent)) {
      if (await this.detach(family.parent, name, 'FINALIZE')) await this.drop(name, result);
      else result.deferred.push(name);
    }

    // 2. Expired live partitions, oldest first.
    for (const p of await this.expired(family, cutoff)) {
      const blocked = await this.blockedBy(guard, family.parent, p);
      if (blocked) {
        result.blocked.push({ partition: p.name, reason: blocked });
        continue;
      }
      if (await this.detach(family.parent, p.name, 'CONCURRENTLY')) await this.drop(p.name, result);
      else result.deferred.push(p.name);
    }

    // 3. A detached leftover from a crash between detach and drop.
    for (const name of await this.leftovers(family, cutoff)) await this.drop(name, result);
  }

  private async pendingDetaches(parent: string): Promise<string[]> {
    const { rows } = await sql<{ relname: string }>`
      SELECT c.relname
      FROM   pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE  i.inhparent = ${parent}::regclass AND i.inhdetachpending
      ORDER  BY c.relname
    `.execute(this.db.kysely);
    return rows.map((r) => r.relname);
  }

  private async expired(family: PartitionFamily, cutoff: number): Promise<Expired[]> {
    const { rows } = await sql<{ relname: string }>`
      SELECT c.relname
      FROM   pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE  i.inhparent = ${family.parent}::regclass AND NOT i.inhdetachpending
      ORDER  BY c.relname
    `.execute(this.db.kysely);
    return this.classify(
      family,
      rows.map((r) => r.relname),
      cutoff,
    );
  }

  private async leftovers(family: PartitionFamily, cutoff: number): Promise<string[]> {
    const { rows } = await sql<{ relname: string }>`
      SELECT c.relname
      FROM   pg_class c
      WHERE  c.relkind = 'r'
        AND  c.relname ~ ${`^${family.parent}_p[0-9]+$`}
        AND  NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
    `.execute(this.db.kysely);
    return this.classify(
      family,
      rows.map((r) => r.relname),
      cutoff,
    ).map((e) => e.name);
  }

  /** Names -> those whose whole period ended at or before the cutoff, oldest first. */
  private classify(family: PartitionFamily, names: string[], cutoff: number): Expired[] {
    const prefix = `${family.parent}_p`;
    const out: Expired[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const lo = periodFromSuffix(family.kind, name.slice(prefix.length));
      if (lo === null) continue;
      const hi = nextPeriodStart(family.kind, lo);
      if (hi.getTime() <= cutoff) out.push({ name, lo, hi });
    }
    return out.sort((a, b) => a.lo.getTime() - b.lo.getTime());
  }

  /**
   * `undefined` when the partition may go; otherwise why not. Fails closed: a
   * missing `rollup_state` row is `0`, so every row counts as unfolded.
   */
  private async blockedBy(guard: Guard, parent: string, p: Expired): Promise<string | undefined> {
    if (guard === 'none') return undefined;
    const unfolded =
      guard === 'raw'
        ? await sql<{ n: number }>`
            SELECT 1 AS n FROM ${sql.id(p.name)}
             WHERE insert_xid >= coalesce(
                     (SELECT last_xid FROM rollup_state WHERE name = 'probe_results'), '0'::xid8)
             LIMIT 1`.execute(this.db.kysely)
        : await sql<{ n: number }>`
            SELECT 1 AS n FROM probe_results
             WHERE insert_xid >= coalesce(
                     (SELECT last_xid FROM rollup_state WHERE name = 'probe_results'), '0'::xid8)
               AND started_at >= ${p.lo.toISOString()}::timestamptz
               AND started_at <  ${p.hi.toISOString()}::timestamptz
             LIMIT 1`.execute(this.db.kysely);
    if (unfolded.rows.length === 0) return undefined;
    return guard === 'raw'
      ? `unfolded rows in ${parent} partition past retention`
      : `unfolded raw rows still target this ${parent} partition`;
  }

  /**
   * One statement on a **dedicated, non-pooled** connection with `lock_timeout` set
   * on it: `DETACH ... CONCURRENTLY` cannot run inside a transaction block, and a
   * multi-statement simple query is one (plan §2.4.6). The connection is closed
   * afterwards, never returned to the pool, so a failure while cleaning up cannot
   * hand another caller a session that still carries this `lock_timeout`. A
   * timeout leaves the partition pending; the next tick's `FINALIZE` completes it
   * (§2.4.5).
   */
  private async detach(
    parent: string,
    name: string,
    mode: 'CONCURRENTLY' | 'FINALIZE',
  ): Promise<boolean> {
    const client = new Client({
      connectionString: this.cfg.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      application_name: RETENTION_APPLICATION_NAME,
    });
    // An idle connection's 'error' event is fatal in Node unless listened for; the
    // statement's own rejection is what this method reports.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query(`SET lock_timeout = ${Math.trunc(this.cfg.MAINTENANCE_LOCK_TIMEOUT_MS)}`);
      await client.query(
        `ALTER TABLE ${quoteIdent(parent)} DETACH PARTITION ${quoteIdent(name)} ${mode}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { err, partition: name, mode },
        'retention detach did not finish; it stays pending and is retried next tick',
      );
      return false;
    } finally {
      await client.end().catch((err: unknown) => {
        // The socket is closed either way; this is only worth a line.
        this.logger.warn({ err, partition: name }, 'closing the retention connection failed');
      });
    }
  }

  private async drop(name: string, result: RetentionResult): Promise<void> {
    await sql`DROP TABLE IF EXISTS ${sql.id(name)}`.execute(this.db.kysely);
    result.dropped.push(name);
  }
}
