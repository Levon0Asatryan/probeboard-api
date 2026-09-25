import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { HISTOGRAM_EDGES_MS } from '../../../core/stats/constants.js';
import { bucketIndex, emptyHistogram } from '../../../core/stats/histogram.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import {
  createEndpoint,
  insertRaw,
  insertRawOn,
  type RawRow,
} from '../../../testing/storage-fixtures.js';
import { PartitionService } from '../../storage/services/partition.service.js';
import { RollupRepository } from '../repositories/rollup.repository.js';

const { db, pool, close } = connectTestDb();
afterAll(close);

const dbLike = { kysely: db } as never;
const repo = new RollupRepository(dbLike);
const DAY = '2032-01-10';
const FROM = new Date('2032-01-09T00:00:00Z');
const TO = new Date('2032-01-13T00:00:00Z');

async function dropRange(): Promise<void> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relname ~ '_p(2032[0-9]{2,4})$' AND relkind = 'r'`,
  );
  for (const r of rows) await pool.query(`DROP TABLE IF EXISTS "${r.relname}"`);
}

beforeEach(async () => {
  await truncateAll(pool);
  await dropRange();
  await new PartitionService(
    dbLike,
    loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    }),
  ).ensureRange(FROM, TO, TO, { wait: true });
});
afterAll(dropRange);

interface Stat {
  granularity: string;
  bucket_start: Date;
  count_up: number;
  count_down: number;
  count_degraded: number;
  count_unknown: number;
  covered_seconds: number;
  up_seconds: number;
  degraded_seconds: number;
  sum_total_ms: string;
  min_total_ms: number | null;
  max_total_ms: number | null;
  sum_ttfb_ms: string;
  hist_total: number[];
}

async function stats(endpointId: string, grain?: string): Promise<Stat[]> {
  const { rows } = await pool.query<Stat>(
    `SELECT * FROM probe_stats WHERE endpoint_id = $1 ${grain ? `AND granularity = '${grain}'` : ''}
     ORDER BY granularity, bucket_start`,
    [endpointId],
  );
  return rows;
}

describe('the fold', () => {
  it('puts the FIRST probe of a bucket into the histogram (07 §7.5 dropped it)', async () => {
    const { endpointId } = await createEndpoint(pool, 'a@example.com');
    await insertRaw(pool, [
      { endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'up', totalMs: 120, ttfbMs: 60 },
    ]);
    await repo.runOnce(5000);
    for (const grain of ['m1', 'h1', 'd1']) {
      const [row] = await stats(endpointId, grain);
      expect(row.count_up).toBe(1);
      expect(row.up_seconds).toBe(60);
      const expected = emptyHistogram();
      expected[bucketIndex(120)] = 1;
      expect(row.hist_total).toEqual(expected);
    }
  });

  it('equals an independent fold of the raw rows, per endpoint, grain and bucket', async () => {
    const a = await createEndpoint(pool, 'p1@example.com');
    const b = await createEndpoint(pool, 'p2@example.com', 30);
    // A tiny deterministic generator: the test must not depend on the SQL under test.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows: RawRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      const endpointId = i % 3 === 0 ? b.endpointId : a.endpointId;
      const r = rnd();
      const outcome = r < 0.7 ? 'up' : r < 0.85 ? 'down' : r < 0.95 ? 'unknown' : 'degraded';
      const ms = 1 + Math.floor(rnd() * rnd() * 3000);
      const responded = outcome === 'up' || outcome === 'degraded' || rnd() < 0.5;
      const minute = Math.floor(rnd() * 60 * 30);
      rows.push({
        endpointId,
        startedAt: new Date(Date.parse(`${DAY}T00:00:00Z`) + minute * 60_000 + i).toISOString(),
        outcome,
        intervalS: endpointId === b.endpointId ? 30 : 60,
        totalMs: ms,
        ttfbMs: responded ? Math.max(1, Math.floor(ms / 2)) : null,
      });
    }
    // Several transactions, so several distinct xids and a real multi-batch fold.
    for (let i = 0; i < rows.length; i += 20) await insertRaw(pool, rows.slice(i, i + 20));
    await repo.runOnce(3);

    const unit = { m1: 60_000, h1: 3_600_000, d1: 86_400_000 } as const;
    const expected = new Map<string, Stat>();
    for (const r of rows) {
      for (const g of ['m1', 'h1', 'd1'] as const) {
        const t = Date.parse(r.startedAt);
        const bucket = Math.floor(t / unit[g]) * unit[g];
        const key = `${r.endpointId}|${g}|${bucket}`;
        const e = expected.get(key) ?? {
          granularity: g,
          bucket_start: new Date(bucket),
          count_up: 0,
          count_down: 0,
          count_degraded: 0,
          count_unknown: 0,
          covered_seconds: 0,
          up_seconds: 0,
          degraded_seconds: 0,
          sum_total_ms: '0',
          min_total_ms: null,
          max_total_ms: null,
          sum_ttfb_ms: '0',
          hist_total: emptyHistogram(),
        };
        (e as unknown as Record<string, number>)[`count_${r.outcome}`] += 1;
        if (r.outcome !== 'unknown') e.covered_seconds += r.intervalS!;
        if (r.outcome === 'up') e.up_seconds += r.intervalS!;
        if (r.outcome === 'degraded') e.degraded_seconds += r.intervalS!;
        if (r.ttfbMs !== null) {
          e.sum_total_ms = String(Number(e.sum_total_ms) + r.totalMs!);
          e.sum_ttfb_ms = String(Number(e.sum_ttfb_ms) + r.ttfbMs!);
          e.min_total_ms =
            e.min_total_ms === null ? r.totalMs! : Math.min(e.min_total_ms, r.totalMs!);
          e.max_total_ms =
            e.max_total_ms === null ? r.totalMs! : Math.max(e.max_total_ms, r.totalMs!);
          e.hist_total[bucketIndex(r.totalMs!)] += 1;
        }
        expected.set(key, e);
      }
    }

    const actual = await pool.query<Stat & { endpoint_id: string }>(`SELECT * FROM probe_stats`);
    expect(actual.rows).toHaveLength(expected.size);
    for (const row of actual.rows) {
      const key = `${row.endpoint_id}|${row.granularity}|${row.bucket_start.getTime()}`;
      const want = expected.get(key);
      expect(want, key).toBeDefined();
      expect(row).toMatchObject({
        count_up: want!.count_up,
        count_down: want!.count_down,
        count_degraded: want!.count_degraded,
        count_unknown: want!.count_unknown,
        covered_seconds: want!.covered_seconds,
        up_seconds: want!.up_seconds,
        degraded_seconds: want!.degraded_seconds,
        sum_total_ms: want!.sum_total_ms,
        min_total_ms: want!.min_total_ms,
        max_total_ms: want!.max_total_ms,
        sum_ttfb_ms: want!.sum_ttfb_ms,
        hist_total: want!.hist_total,
      });
    }
  });

  it('adds a later result to an existing bucket: counts and histogram add, min and max widen', async () => {
    const { endpointId } = await createEndpoint(pool, 'u@example.com');
    await insertRaw(pool, [
      { endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'up', totalMs: 100, ttfbMs: 50 },
    ]);
    await repo.runOnce(5000);
    await insertRaw(pool, [
      { endpointId, startedAt: `${DAY}T10:00:40Z`, outcome: 'up', totalMs: 400, ttfbMs: 200 },
    ]);
    await repo.runOnce(5000);
    const [m1] = await stats(endpointId, 'm1');
    expect(m1).toMatchObject({
      count_up: 2,
      min_total_ms: 100,
      max_total_ms: 400,
      sum_total_ms: '500',
    });
    expect(m1.hist_total[bucketIndex(100)]).toBe(1);
    expect(m1.hist_total[bucketIndex(400)]).toBe(1);
  });

  it('buckets exactly as the TypeScript function does, at every edge and one either side', async () => {
    const { endpointId } = await createEndpoint(pool, 'edges@example.com');
    const values = HISTOGRAM_EDGES_MS.flatMap((e) => [e - 1, e, e + 1]).concat([1, 100_000]);
    await insertRaw(
      pool,
      values.map((ms, i) => ({
        endpointId,
        startedAt: new Date(Date.parse(`${DAY}T00:00:00Z`) + i * 1000).toISOString(),
        outcome: 'up' as const,
        totalMs: ms,
        ttfbMs: 1,
      })),
    );
    await repo.runOnce(5000);
    const expected = emptyHistogram();
    for (const ms of values) expected[bucketIndex(ms)] += 1;
    expect((await stats(endpointId, 'd1'))[0].hist_total).toEqual(expected);
  });

  it('counts a probe that reached no server, but keeps it out of latency', async () => {
    const { endpointId } = await createEndpoint(pool, 'l@example.com');
    await insertRaw(pool, [
      { endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'down', totalMs: 10_000, ttfbMs: null },
      { endpointId, startedAt: `${DAY}T10:00:40Z`, outcome: 'up', totalMs: 50, ttfbMs: 25 },
    ]);
    await repo.runOnce(5000);
    const [row] = await stats(endpointId, 'm1');
    expect(row).toMatchObject({ count_up: 1, count_down: 1, max_total_ms: 50, sum_total_ms: '50' });
    expect(row.hist_total.reduce((s, v) => s + v, 0)).toBe(1);
  });

  it('an unknown probe adds a count and no observed seconds', async () => {
    const { endpointId } = await createEndpoint(pool, 'k@example.com');
    await insertRaw(pool, [
      { endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'unknown', totalMs: 1, ttfbMs: null },
    ]);
    await repo.runOnce(5000);
    const [row] = await stats(endpointId, 'd1');
    expect(row).toMatchObject({ count_unknown: 1, covered_seconds: 0, up_seconds: 0 });
  });
});

describe('exactly once', () => {
  it('a second pass over the same rows folds nothing', async () => {
    const { endpointId } = await createEndpoint(pool, 'x@example.com');
    await insertRaw(pool, [{ endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'up' }]);
    expect((await repo.runOnce(5000)).folded).toBe(1);
    expect((await repo.runOnce(5000)).folded).toBe(0);
    expect((await stats(endpointId, 'd1'))[0].count_up).toBe(1);
  });

  it('a failure between the fold and the watermark rolls back both; the retry applies it once', async () => {
    const { endpointId } = await createEndpoint(pool, 'r@example.com');
    await insertRaw(pool, [{ endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'up' }]);
    // Make the watermark UPDATE fail *after* the fold has run.
    await pool.query(
      `ALTER TABLE rollup_state ADD CONSTRAINT no_advance CHECK (last_xid = '0'::xid8)`,
    );
    try {
      await expect(repo.runOnce(5000)).rejects.toThrow(/no_advance/);
      expect(await stats(endpointId)).toHaveLength(0);
    } finally {
      await pool.query(`ALTER TABLE rollup_state DROP CONSTRAINT no_advance`);
    }
    await repo.runOnce(5000);
    expect((await stats(endpointId, 'd1'))[0].count_up).toBe(1);
    await repo.runOnce(5000);
    expect((await stats(endpointId, 'd1'))[0].count_up).toBe(1);
  });
});

describe('no row lost to commit order', () => {
  it('holds back a later row while an earlier transaction is open, then folds both once', async () => {
    const { endpointId } = await createEndpoint(pool, 'h@example.com');
    const open = new Client({ connectionString: testDatabaseUrl() });
    await open.connect();
    try {
      // A's xid is assigned by its insert, before B's.
      await open.query('BEGIN');
      await insertRawOn(open, { endpointId, startedAt: `${DAY}T10:00:00Z`, outcome: 'up' });
      // B commits after A started, with a later timestamp.
      await insertRaw(pool, [{ endpointId, startedAt: `${DAY}T10:00:05Z`, outcome: 'up' }]);

      const first = await repo.runOnce(5000);
      expect(first.folded).toBe(0); // B is committed but not below the horizon
      expect(await stats(endpointId)).toHaveLength(0);

      await open.query('COMMIT');
    } finally {
      await open.end();
    }
    const second = await repo.runOnce(5000);
    expect(second.folded).toBe(2);
    expect((await stats(endpointId, 'd1'))[0].count_up).toBe(2);
    expect((await repo.runOnce(5000)).folded).toBe(0);
  });
});

describe('single flight', () => {
  it('a second worker returns at once while the state row is held, and does not fold', async () => {
    const { endpointId } = await createEndpoint(pool, 's@example.com');
    await insertRaw(pool, [{ endpointId, startedAt: `${DAY}T10:00:10Z`, outcome: 'up' }]);
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM rollup_state WHERE name = 'probe_results' FOR UPDATE`);
      const pass = await repo.runOnce(5000);
      expect(pass).toMatchObject({ skipped: true, folded: 0 });
      expect(await stats(endpointId)).toHaveLength(0);
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    expect((await repo.runOnce(5000)).folded).toBe(1);
  });
});

describe('batches are whole transactions', () => {
  it.each([1, 2, 7])('ROLLUP_BATCH_ROWS = %i still folds every row once', async (n) => {
    const { endpointId } = await createEndpoint(pool, `b${n}@example.com`);
    for (let i = 0; i < 5; i += 1) {
      await insertRaw(pool, [
        { endpointId, startedAt: `${DAY}T10:0${i}:10Z`, outcome: 'up', totalMs: 30 },
      ]);
    }
    const pass = await repo.runOnce(n);
    expect(pass.folded).toBe(5);
    expect((await stats(endpointId, 'd1'))[0].count_up).toBe(5);
  });

  it('never splits one transaction across two batches', async () => {
    const { endpointId } = await createEndpoint(pool, 'w@example.com');
    // One transaction, six rows, one xid; batch size 1 must fold all six together.
    await insertRaw(
      pool,
      Array.from({ length: 6 }, (_, i) => ({
        endpointId,
        startedAt: `${DAY}T11:00:${String(i * 5).padStart(2, '0')}Z`,
        outcome: 'up' as const,
      })),
    );
    expect((await repo.runOnce(1)).folded).toBe(6);
    expect((await stats(endpointId, 'd1'))[0].count_up).toBe(6);
  });
});

describe('the watermark', () => {
  it('does not refresh advanced_at while an open write transaction pins the horizon', async () => {
    const { endpointId } = await createEndpoint(pool, 'stall@example.com');
    const at = async () =>
      (
        await pool.query<{ t: string }>(
          `SELECT advanced_at::text AS t FROM rollup_state WHERE name = 'probe_results'`,
        )
      ).rows[0].t;
    const open = new Client({ connectionString: testDatabaseUrl() });
    await open.connect();
    try {
      await open.query('BEGIN');
      await insertRawOn(open, { endpointId, startedAt: `${DAY}T10:00:00Z`, outcome: 'up' });
      await repo.runOnce(5000); // moves up to the pinned horizon, once
      const pinned = await at();
      await repo.runOnce(5000);
      await repo.runOnce(5000);
      expect(await at()).toBe(pinned);
      await open.query('COMMIT');
    } finally {
      await open.end();
    }
    const before = await at();
    await repo.runOnce(5000); // the horizon is free: the watermark moves, and so does the timestamp
    expect(await at()).not.toBe(before);
  });

  it('advances on an idle pass, so the next pass does not re-scan the range', async () => {
    const before = await pool.query<{ last_xid: string }>(
      `SELECT last_xid::text FROM rollup_state WHERE name = 'probe_results'`,
    );
    await repo.runOnce(5000);
    const after = await pool.query<{ last_xid: string; advanced_at: Date }>(
      `SELECT last_xid::text, advanced_at FROM rollup_state WHERE name = 'probe_results'`,
    );
    expect(BigInt(after.rows[0].last_xid)).toBeGreaterThan(BigInt(before.rows[0].last_xid));
  });
});
