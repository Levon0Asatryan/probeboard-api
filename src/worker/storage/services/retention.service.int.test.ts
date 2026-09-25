import { randomUUID } from 'node:crypto';
import type { PinoLogger } from 'nestjs-pino';
import { Client, Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { createDb } from '../../../core/db/utils/kysely.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { dropPartitionsOfYear, insertRaw } from '../../../testing/storage-fixtures.js';
import { RollupRepository } from '../../rollup/repositories/rollup.repository.js';
import { PartitionService } from './partition.service.js';
import { RETENTION_APPLICATION_NAME, RetentionService } from './retention.service.js';

/**
 * Year 2020, and `now` is set explicitly: every other partition on this
 * database (the current ones) is *newer* than any cutoff computed from it, so
 * retention here can never touch a partition another test relies on.
 */
const { db, pool, close } = connectTestDb();
afterAll(async () => {
  await dropPartitionsOfYear(pool, 2020);
  await close();
});

const dbLike = { kysely: db } as never;
const NOW = new Date('2020-01-20T00:00:00Z'); // raw/m1 cutoff (7 d): 2020-01-13
const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    RETENTION_H1_DAYS: '7',
    ...over,
  });
}

const retention = (over: Record<string, string> = {}) =>
  new RetentionService(dbLike, config(over), logger);

async function live(parent: string): Promise<string[]> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = $1::regclass AND c.relname ~ '_p2020' ORDER BY 1`,
    [parent],
  );
  return rows.map((r) => r.relname);
}

const exists = async (name: string) =>
  (await pool.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [name])).rows[0]!.e as boolean;

beforeEach(async () => {
  await truncateAll(pool);
  await dropPartitionsOfYear(pool, 2020);
  await new PartitionService(dbLike, config()).ensureRange(
    new Date('2020-01-01T00:00:00Z'),
    new Date('2020-01-20T00:00:00Z'),
    new Date('2020-03-20T00:00:00Z'),
    { wait: true },
  );
});

describe('what is dropped', () => {
  it('drops every family older than its own retention and keeps the rest', async () => {
    const r = await retention({ RETENTION_CLAIM_LOG_DAYS: '3' }).run(NOW);
    expect(r.skipped).toBe(false);
    expect(r.blocked).toEqual([]);

    // raw and m1: 7 days -> partitions ending on or before 2020-01-13 are gone.
    for (const parent of ['probe_results', 'probe_stats_m1']) {
      const left = await live(parent);
      expect(left[0]).toMatch(/_p20200113$/);
      expect(left).toHaveLength(8); // 13th..20th
    }
    // claim_log: 3 days -> gone through the 16th.
    expect((await live('claim_log'))[0]).toMatch(/_p20200117$/);
    // h1 (7 days) at 2020-01-20: January ends 2020-02-01, after the cutoff: kept.
    expect(await live('probe_stats_h1')).toHaveLength(3);
  });

  it('keeps the partition whose period ends after the cutoff, and drops the one that ends on it', async () => {
    await retention().run(NOW);
    expect(await exists('probe_results_p20200112')).toBe(false); // ends 2020-01-13 00:00 = cutoff
    expect(await exists('probe_results_p20200113')).toBe(true);
  });

  it('drops an expired monthly aggregate partition and keeps the current one', async () => {
    await retention().run(new Date('2020-03-20T00:00:00Z'));
    expect(await live('probe_stats_h1')).toEqual(['probe_stats_h1_p202003']);
  });

  it('never touches d1, however old', async () => {
    await pool.query(
      `INSERT INTO probe_stats (endpoint_id, granularity, bucket_start, count_up)
       VALUES ($1, 'd1', '2019-01-01', 5)`,
      [randomUUID()],
    );
    await retention().run(NOW);
    const { rows } = await pool.query(`SELECT 1 FROM probe_stats WHERE granularity = 'd1'`);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent: a second pass over an already-pruned database drops nothing', async () => {
    await retention().run(NOW);
    expect((await retention().run(NOW)).dropped).toEqual([]);
  });
});

describe('the guard: unfolded data is never dropped', () => {
  it('leaves a raw partition and the m1 partition it targets while a row is unfolded, then drops both once folded', async () => {
    const endpointId = randomUUID();
    await insertRaw(pool, [{ endpointId, startedAt: '2020-01-05T10:00:00Z', outcome: 'up' }]);

    const first = await retention().run(NOW);
    expect(first.blocked.map((b) => b.partition).sort()).toEqual([
      'probe_results_p20200105',
      'probe_stats_m1_p20200105',
    ]);
    expect(await exists('probe_results_p20200105')).toBe(true);
    expect(await exists('probe_stats_m1_p20200105')).toBe(true);
    expect(await exists('probe_results_p20200104')).toBe(false); // its neighbours are fine

    await new RollupRepository(dbLike).runOnce(5000);
    const second = await retention().run(NOW);
    expect(second.blocked).toEqual([]);
    expect(await exists('probe_results_p20200105')).toBe(false);
    expect(await exists('probe_stats_m1_p20200105')).toBe(false);

    // The raw rows are gone; what they established survives in the aggregates.
    const { rows } = await pool.query<{ count_up: number }>(
      `SELECT count_up FROM probe_stats WHERE endpoint_id = $1 AND granularity = 'd1'`,
      [endpointId],
    );
    expect(rows).toEqual([{ count_up: 1 }]);
  });

  it('fails closed: with the watermark row missing, a partition holding rows is not dropped', async () => {
    await insertRaw(pool, [
      { endpointId: randomUUID(), startedAt: '2020-01-05T10:00:00Z', outcome: 'up' },
    ]);
    await pool.query(`DELETE FROM rollup_state`);
    try {
      const r = await retention().run(NOW);
      expect(r.blocked.map((b) => b.partition)).toContain('probe_results_p20200105');
      expect(await exists('probe_results_p20200105')).toBe(true);
    } finally {
      await pool.query(
        `INSERT INTO rollup_state (name, last_xid) VALUES ('probe_results', '0') ON CONFLICT DO NOTHING`,
      );
    }
  });
});

describe('a reader holding the partition', () => {
  it('leaves the detach pending on lock_timeout, and the next pass finalises and drops it', async () => {
    const reader = new Client({ connectionString: testDatabaseUrl() });
    await reader.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM probe_results_p20200103');

      const first = await retention({ MAINTENANCE_LOCK_TIMEOUT_MS: '100' }).run(NOW);
      expect(first.deferred).toContain('probe_results_p20200103');
      expect(first.dropped).not.toContain('probe_results_p20200103');
      const pending = await pool.query<{ p: boolean }>(
        `SELECT inhdetachpending AS p FROM pg_inherits WHERE inhrelid = 'probe_results_p20200103'::regclass`,
      );
      expect(pending.rows[0].p).toBe(true);
      await reader.query('COMMIT');
    } finally {
      await reader.end();
    }
    const second = await retention().run(NOW);
    expect(second.dropped).toContain('probe_results_p20200103');
    expect(await exists('probe_results_p20200103')).toBe(false);
  });

  it('does not block inserts into other partitions while it waits (plain DROP measured 2 s)', async () => {
    const reader = new Client({ connectionString: testDatabaseUrl() });
    await reader.connect();
    const observer = new Client({ connectionString: testDatabaseUrl() });
    await observer.connect();
    let run: Promise<unknown> | undefined;
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM probe_results_p20200104');
      run = retention({ MAINTENANCE_LOCK_TIMEOUT_MS: '5000' }).run(NOW);

      // Barrier on observable state: a backend is waiting on a lock for the detach.
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rows } = await observer.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE 'ALTER TABLE%DETACH PARTITION%'`,
        );
        if (rows.length > 0) break;
        if (Date.now() > deadline) throw new Error('the detach never started waiting');
        await new Promise((r) => setTimeout(r, 20));
      }

      const started = Date.now();
      await insertRaw(pool, [
        { endpointId: randomUUID(), startedAt: new Date().toISOString(), outcome: 'up' },
      ]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      await reader.query('COMMIT').catch(() => undefined);
      await reader.end();
      await observer.end();
      await run;
    }
  });

  it('closes the dedicated connection it used: no retention backend survives a timed-out detach', async () => {
    const reader = new Client({ connectionString: testDatabaseUrl() });
    await reader.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM probe_results_p20200103');
      const r = await retention({ MAINTENANCE_LOCK_TIMEOUT_MS: '100' }).run(NOW);
      expect(r.deferred).toContain('probe_results_p20200103');
      await reader.query('COMMIT');
    } finally {
      await reader.end();
    }
    // A connection returned to a pool (or leaked) would still be listed, holding
    // the lock_timeout it was given.
    const { rows } = await pool.query(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1`,
      [RETENTION_APPLICATION_NAME],
    );
    expect(rows).toEqual([]);
  });
});

describe('the connection pool', () => {
  it('completes with a pool of ONE connection: retention reserves none while it waits', async () => {
    const tiny = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    tiny.on('error', () => undefined);
    try {
      const svc = new RetentionService({ kysely: createDb(tiny) } as never, config(), logger);
      // Before the fix this held the only connection and waited for a second one.
      const r = await Promise.race([
        svc.run(NOW),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 8000)),
      ]);
      expect(r.dropped).toContain('probe_results_p20200101');
    } finally {
      await tiny.end();
    }
  });
});

describe('leftovers and single flight', () => {
  it('drops a partition detached by a crash between detach and drop', async () => {
    await pool.query(`ALTER TABLE probe_results DETACH PARTITION probe_results_p20200106`);
    expect(await exists('probe_results_p20200106')).toBe(true);
    const r = await retention().run(NOW);
    expect(r.dropped).toContain('probe_results_p20200106');
    expect(await exists('probe_results_p20200106')).toBe(false);
  });

  it('does not drop a stray table whose name only resembles a partition of a recent period', async () => {
    await pool.query(`CREATE TABLE probe_results_p20200125 (LIKE probe_results INCLUDING ALL)`);
    await retention().run(NOW);
    expect(await exists('probe_results_p20200125')).toBe(true);
  });

  it('a second worker skips at once while the first holds the retention lock', async () => {
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('probeboard:retention'))`);
      const r = await retention().run(NOW);
      expect(r).toEqual({ skipped: true, dropped: [], blocked: [], deferred: [] });
      expect(await exists('probe_results_p20200101')).toBe(true);
    } finally {
      await holder.query('COMMIT');
      await holder.end();
    }
    expect((await retention().run(NOW)).skipped).toBe(false);
  });
});
