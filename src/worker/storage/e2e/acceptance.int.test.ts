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

/**
 * M5's exit test (docs/m5-plan.md §8), up to and including the read: a 30-day
 * percentile is served from aggregates, and agrees with the raw rows within the
 * histogram's bucket width. (Retention and the same read afterwards: PR 3.)
 */
const { db, pool, close } = connectTestDb();
const dbLike = { kysely: db } as never;
const READER = 'probeboard_stats_reader';

const SEED_FROM = new Date('2032-02-20T00:00:00Z');
const SEED_TO = new Date('2032-04-01T00:00:00Z');
const WIN_FROM = new Date('2032-03-01T00:00:00Z');
const WIN_TO = new Date('2032-03-31T00:00:00Z'); // 30 whole days

let readerPool: Pool;
const endpoints: { userId: string; endpointId: string }[] = [];

beforeAll(async () => {
  await truncateAll(pool);
  await dropPartitionsOfYear(pool, 2032);
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
  await dropPartitionsOfYear(pool, 2032);
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
