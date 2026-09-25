import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { createDb } from '../../../core/db/utils/kysely.js';
import { HISTOGRAM_EDGES_MS } from '../../../core/stats/constants.js';
import { bucketIndex } from '../../../core/stats/histogram.js';
import { StatsRepository } from '../../../core/stats/repositories/stats.repository.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { createEndpoint, dropPartitionsOfYear } from '../../../testing/storage-fixtures.js';
import { RollupRepository } from '../../rollup/repositories/rollup.repository.js';
import { PartitionService } from '../services/partition.service.js';
import { RetentionService } from '../services/retention.service.js';
import type { WindowStats } from '../../../core/stats/repositories/stats.repository.js';
import type { PinoLogger } from 'nestjs-pino';

/**
 * M5's exit test (docs/m5-plan.md §8): a 30-day percentile is served from
 * aggregates, agrees with the raw rows within the histogram's bucket width, and
 * is **identical after retention has dropped the raw rows** (NFR-8, NFR-9).
 *
 * Year 2010, deliberately earlier than every other partition on the database:
 * retention drops *anything* older than its cutoff, so a later year here would
 * drop the current partitions and break every test that runs after this one.
 */
const { db, pool, close } = connectTestDb();
const dbLike = { kysely: db } as never;
const READER = 'probeboard_stats_reader';

const SEED_FROM = new Date('2010-02-20T00:00:00Z');
const SEED_TO = new Date('2010-04-01T00:00:00Z');
const WIN_FROM = new Date('2010-03-01T00:00:00Z');
const WIN_TO = new Date('2010-03-31T00:00:00Z'); // 30 whole days

let readerPool: Pool;
const endpoints: { userId: string; endpointId: string }[] = [];
const before: { stats: WindowStats; exact: number; raw: number }[] = [];
const NOW = new Date('2010-04-01T00:00:00Z'); // retention: raw and m1 keep 7 days -> cutoff 2010-03-25

beforeAll(async () => {
  await truncateAll(pool);
  await dropPartitionsOfYear(pool, 2010);
  await new PartitionService(
    dbLike,
    loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    }),
  ).ensureRange(SEED_FROM, SEED_TO, SEED_TO, { wait: true });

  for (let i = 0; i < 3; i += 1) {
    const ep = await createEndpoint(pool, `accept${i}@example.com`);
    endpoints.push(ep);
    // 60 s interval, lognormal latency around 120 ms, ~1% down (connect timeout: no headers).
    await pool.query(
      `INSERT INTO probe_results (endpoint_id, started_at, scheduled_at, interval_s, outcome,
                                  failure_class, total_ms, ttfb_ms, redirects, truncated,
                                  worker_id, attempt_id)
       SELECT $1, ts, ts, 60,
              CASE WHEN dn THEN 'down'::probe_outcome ELSE 'up'::probe_outcome END,
              CASE WHEN dn THEN 'connection_timeout'::failure_class END,
              CASE WHEN dn THEN 5000 ELSE ms END,
              CASE WHEN dn THEN NULL ELSE greatest(1, ms / 2) END,
              0, false, 'seed', gen_random_uuid()
       FROM (SELECT ts, random() < 0.01 AS dn,
                    greatest(1, round(exp(ln(120) + 0.7 * sqrt(-2 * ln(1 - random()))
                                                    * cos(2 * pi() * random()))))::int AS ms
             FROM generate_series($2::timestamptz, $3::timestamptz - interval '1 minute',
                                  interval '60 seconds') ts) x`,
      [ep.endpointId, SEED_FROM.toISOString(), SEED_TO.toISOString()],
    );
  }

  const rollup = new RollupRepository(dbLike);
  while ((await rollup.runOnce(5000)).folded > 0) {
    /* to a fixed point */
  }

  // A role that may read the aggregates and the endpoints table and NOTHING else:
  // if the read path touched a raw partition it would fail, not merely be slow.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN
        CREATE ROLE ${READER} NOLOGIN;
      END IF;
    END $$`);
  await pool.query(`GRANT SELECT ON probe_stats, endpoints TO ${READER}`);
  readerPool = new Pool({
    connectionString: testDatabaseUrl(),
    max: 2,
    options: `-c role=${READER}`,
  });
  readerPool.on('error', () => undefined);
}, 240_000);

afterAll(async () => {
  await readerPool?.end();
  await dropPartitionsOfYear(pool, 2010);
  await pool.query(`DROP OWNED BY ${READER}`).catch(() => undefined);
  await pool.query(`DROP ROLE IF EXISTS ${READER}`).catch(() => undefined);
  await close();
});

describe('acceptance (NFR-8, NFR-9): a 30-day percentile from aggregates', () => {
  it('the control: the reader role really cannot read raw results', async () => {
    await expect(readerPool.query(`SELECT 1 FROM probe_results LIMIT 1`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(readerPool.query(`SELECT 1 FROM probe_stats LIMIT 1`)).resolves.toBeDefined();
  });

  it.each([0, 1, 2])(
    'endpoint %i: the 30-day p95 read as a role with no access to raw rows agrees with the raw rows within one bucket',
    async (i) => {
      const { userId, endpointId } = endpoints[i];
      const raw = await pool.query<{ n: string; exact: number }>(
        `SELECT count(*) AS n,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE ttfb_ms IS NOT NULL) AS exact
           FROM probe_results
          WHERE endpoint_id = $1 AND started_at >= $2 AND started_at < $3`,
        [endpointId, WIN_FROM.toISOString(), WIN_TO.toISOString()],
      );
      // The number NFR-9 names: 30 days at 60 s is 43,200 raw rows per monitor.
      expect(Number(raw.rows[0].n)).toBe(43_200);

      const reader = new StatsRepository({ kysely: createDb(readerPool) } as never);
      const w = await reader.windowStats(userId, endpointId, WIN_FROM, WIN_TO);

      // Served from 30 aggregate rows, not 43,200.
      before[i] = { stats: w, exact: raw.rows[0].exact, raw: Number(raw.rows[0].n) };
      expect(w.rowsRead).toBe(30);
      expect(w.tiles).toEqual({ d1: 30, h1: 0, m1: 0 });
      expect(w.counts.up + w.counts.down + w.counts.unknown + w.counts.degraded).toBe(43_200);

      const exact = raw.rows[0].exact;
      const b = bucketIndex(exact);
      const width =
        (HISTOGRAM_EDGES_MS[b] ?? exact * 2) - (b === 0 ? 0 : HISTOGRAM_EDGES_MS[b - 1]);
      expect(w.latency.p95).not.toBeNull();
      expect(Math.abs(w.latency.p95! - exact)).toBeLessThanOrEqual(width);
    },
    120_000,
  );

  it('the same window read by the ordinary pool gives the identical answer', async () => {
    const { userId, endpointId } = endpoints[0];
    const viaReader = await new StatsRepository({
      kysely: createDb(readerPool),
    } as never).windowStats(userId, endpointId, WIN_FROM, WIN_TO);
    const viaSuper = await new StatsRepository(dbLike).windowStats(
      userId,
      endpointId,
      WIN_FROM,
      WIN_TO,
    );
    expect(viaReader).toEqual(viaSuper);
  });
});

describe('after retention has dropped the raw rows', () => {
  let dropped: string[] = [];

  it('step 4: retention removes the raw partitions older than the window, by dropping them', async () => {
    const cfg = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
      RETENTION_RAW_DAYS: '7',
      RETENTION_M1_DAYS: '7',
    });
    const noop = { warn: () => undefined, info: () => undefined, error: () => undefined };
    const r = await new RetentionService(dbLike, cfg, noop as unknown as PinoLogger).run(NOW);
    expect(r.blocked).toEqual([]); // everything had been folded
    dropped = r.dropped;
    expect(dropped).toContain('probe_results_p20100301');
    expect(dropped).toContain('probe_results_p20100324');
    expect(dropped).not.toContain('probe_results_p20100325');

    // The raw rows for those days are really gone: 6 days remain of the 30.
    for (const { endpointId } of endpoints) {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM probe_results
          WHERE endpoint_id = $1 AND started_at >= $2 AND started_at < $3`,
        [endpointId, WIN_FROM.toISOString(), WIN_TO.toISOString()],
      );
      expect(Number(rows[0].n)).toBe(6 * 1440);
    }
  });

  it.each([0, 1, 2])(
    'step 5: endpoint %i: the 30-day statistics are identical to before retention, and still within one bucket of the exact p95 taken earlier',
    async (i) => {
      const { userId, endpointId } = endpoints[i];
      const reader = new StatsRepository({ kysely: createDb(readerPool) } as never);
      const after = await reader.windowStats(userId, endpointId, WIN_FROM, WIN_TO);
      expect(after).toEqual(before[i].stats);
      expect(after.counts.up + after.counts.down).toBe(43_200); // 43,200 probes, 6 days of raw left
      expect(after.rowsRead).toBe(30);
      const b = bucketIndex(before[i].exact);
      const width =
        (HISTOGRAM_EDGES_MS[b] ?? before[i].exact * 2) - (b === 0 ? 0 : HISTOGRAM_EDGES_MS[b - 1]);
      expect(Math.abs(after.latency.p95! - before[i].exact)).toBeLessThanOrEqual(width);
    },
  );

  it('step 6: that read still touches no raw partition (the reader role has no access to them)', async () => {
    await expect(readerPool.query(`SELECT 1 FROM probe_results LIMIT 1`)).rejects.toThrow(
      /permission denied/,
    );
    const { userId, endpointId } = endpoints[0];
    const w = await new StatsRepository({ kysely: createDb(readerPool) } as never).windowStats(
      userId,
      endpointId,
      WIN_FROM,
      WIN_TO,
    );
    expect(w.latency.p95).not.toBeNull();
  });

  it('a window inside the retained days but needing hourly detail is refused once its m1/h1 are gone', async () => {
    // Hour edges older than the surviving m1 partitions cannot be answered exactly.
    const { userId, endpointId } = endpoints[0];
    const reader = new StatsRepository({ kysely: createDb(readerPool) } as never);
    await expect(
      reader.windowStats(
        userId,
        endpointId,
        new Date('2010-03-05T03:30:00Z'),
        new Date('2010-03-06T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ windowCode: 'WINDOW_GRAIN_RETIRED' });
  });
});
