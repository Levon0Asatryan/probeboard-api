import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { NotFoundError } from '../../../core/errors/app-error.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import {
  createEndpoint,
  dropPartitionsOfYear,
  insertRaw,
  type RawRow,
} from '../../../testing/storage-fixtures.js';
import { RollupRepository } from '../repositories/rollup.repository.js';
import { PartitionService } from '../../storage/services/partition.service.js';
import { bucketIndex } from '../../../core/stats/histogram.js';
import { StatsRepository } from '../../../core/stats/repositories/stats.repository.js';

const { db, pool, close } = connectTestDb();
afterAll(close);

const dbLike = { kysely: db } as never;
const stats = new StatsRepository(dbLike);
const rollup = new RollupRepository(dbLike);
const FROM = new Date('2032-05-01T00:00:00Z');
const TO = new Date('2032-05-06T00:00:00Z');

beforeEach(async () => {
  await truncateAll(pool);
  await dropPartitionsOfYear(pool, 2032);
  await new PartitionService(
    dbLike,
    loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    }),
  ).ensureRange(FROM, TO, TO, { wait: true });
});
afterAll(() => dropPartitionsOfYear(pool, 2032));

async function seed(endpointId: string): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  for (let m = 0; m < 3 * 24 * 60; m += 7) {
    const ms = 20 + ((m * 37) % 900);
    rows.push({
      endpointId,
      startedAt: new Date(Date.parse('2032-05-01T00:00:00Z') + m * 60_000).toISOString(),
      outcome: m % 50 === 0 ? 'down' : 'up',
      totalMs: m % 50 === 0 ? 5000 : ms,
      ttfbMs: m % 50 === 0 ? null : Math.floor(ms / 2),
    });
  }
  for (let i = 0; i < rows.length; i += 100) await insertRaw(pool, rows.slice(i, i + 100));
  await rollup.runOnce(5000);
  return rows;
}

describe('StatsRepository.windowStats', () => {
  it('serves counts, seconds and a percentile for a day-aligned window from aggregates', async () => {
    const { userId, endpointId } = await createEndpoint(pool, 'a@example.com');
    const rows = await seed(endpointId);
    const w = await stats.windowStats(
      userId,
      endpointId,
      new Date('2032-05-01T00:00:00Z'),
      new Date('2032-05-04T00:00:00Z'),
    );
    expect(w.counts.up + w.counts.down).toBe(rows.length);
    expect(w.counts.down).toBe(rows.filter((r) => r.outcome === 'down').length);
    expect(w.tiles).toEqual({ d1: 3, h1: 0, m1: 0 });
    expect(w.rowsRead).toBe(3);

    const responded = rows.filter((r) => r.ttfbMs !== null).map((r) => r.totalMs!);
    expect(w.latency.count).toBe(responded.length);
    const sorted = [...responded].sort((a, b) => a - b);
    const exact = sorted[Math.ceil(0.95 * sorted.length) - 1];
    expect(w.latency.minMs).toBe(sorted[0]);
    expect(w.latency.maxMs).toBe(sorted.at(-1));
    // Within the bucket that holds the exact value (ADR-0003's error bound).
    const i = bucketIndex(exact);
    expect(Math.abs(w.latency.p95! - exact)).toBeLessThanOrEqual(i === 0 ? 10 : 1e5);
    expect(w.latency.p95).toBeGreaterThan(0);
  });

  it('agrees exactly with the raw rows on a window that needs every grain', async () => {
    const { userId, endpointId } = await createEndpoint(pool, 'g@example.com');
    const rows = await seed(endpointId);
    const from = new Date('2032-05-01T05:17:00Z');
    const to = new Date('2032-05-03T22:41:00Z');
    const w = await stats.windowStats(userId, endpointId, from, to);
    const inWindow = rows.filter((r) => {
      const t = Date.parse(r.startedAt);
      return t >= from.getTime() && t < to.getTime();
    });
    expect(w.counts.up + w.counts.down).toBe(inWindow.length);
    expect(w.tiles.m1).toBeGreaterThan(0);
    expect(w.tiles.h1).toBeGreaterThan(0);
    expect(w.tiles.d1).toBeGreaterThan(0);
    expect(w.latency.count).toBe(inWindow.filter((r) => r.ttfbMs !== null).length);
  });

  it('answers an owned endpoint with no data as zeros and null percentiles, not an error', async () => {
    const { userId, endpointId } = await createEndpoint(pool, 'e@example.com');
    const w = await stats.windowStats(userId, endpointId, FROM, new Date('2032-05-02T00:00:00Z'));
    expect(w.counts).toEqual({ up: 0, down: 0, degraded: 0, unknown: 0 });
    expect(w.latency.p95).toBeNull();
    expect(w.rowsRead).toBe(0);
  });

  it("does not show one user another user's statistics, and looks identical to a missing endpoint", async () => {
    const a = await createEndpoint(pool, 'owner@example.com');
    const b = await createEndpoint(pool, 'intruder@example.com');
    await seed(a.endpointId);
    const win = [new Date('2032-05-01T00:00:00Z'), new Date('2032-05-02T00:00:00Z')] as const;

    const foreign = await stats
      .windowStats(b.userId, a.endpointId, ...win)
      .catch((e: unknown) => e);
    const missing = await stats
      .windowStats(b.userId, '00000000-0000-4000-8000-000000000999', ...win)
      .catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((foreign as NotFoundError).status).toBe(404);
    expect((foreign as NotFoundError).message).toBe((missing as NotFoundError).message);
    // ...and the owner still reads it.
    await expect(stats.windowStats(a.userId, a.endpointId, ...win)).resolves.toBeDefined();
  });

  it('rejects a window that is not minute-aligned, with a typed error', async () => {
    const { userId, endpointId } = await createEndpoint(pool, 'm@example.com');
    await expect(
      stats.windowStats(userId, endpointId, new Date('2032-05-01T00:00:30Z'), TO),
    ).rejects.toMatchObject({ windowCode: 'WINDOW_NOT_MINUTE_ALIGNED' });
  });

  it('rejects an hour edge older than any live h1 partition, and accepts the same span day-aligned', async () => {
    const { userId, endpointId } = await createEndpoint(pool, 'old@example.com');
    // Nothing that old exists as an hourly bucket; only d1 is unpartitioned.
    await expect(
      stats.windowStats(
        userId,
        endpointId,
        new Date('2000-01-01T05:00:00Z'),
        new Date('2000-01-03T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ windowCode: 'WINDOW_GRAIN_RETIRED' });
    const aligned = await stats.windowStats(
      userId,
      endpointId,
      new Date('2000-01-01T00:00:00Z'),
      new Date('2000-01-03T00:00:00Z'),
    );
    expect(aligned.tiles).toEqual({ d1: 2, h1: 0, m1: 0 });
  });

  it('discards a plan whose grain was retired between the availability lookup and the read', async () => {
    const { userId, endpointId } = await createEndpoint(pool, 'c@example.com');
    await seed(endpointId);
    const real = await stats.retainedFrom();
    const spy = vi
      .spyOn(stats, 'retainedFrom')
      .mockResolvedValueOnce(real)
      // The second look, after the read: retention has since dropped h1's oldest partition.
      .mockResolvedValueOnce({ ...real, h1: new Date('2032-06-01T00:00:00Z') });
    await expect(
      stats.windowStats(
        userId,
        endpointId,
        new Date('2032-05-01T05:00:00Z'),
        new Date('2032-05-01T09:00:00Z'),
      ),
    ).rejects.toMatchObject({ windowCode: 'WINDOW_CHANGED_DURING_READ' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('StatsRepository.retainedFrom', () => {
  it('is the oldest live partition of each retention-bound grain, read from the catalogue', async () => {
    const before = await stats.retainedFrom();
    expect(before.m1!.getTime()).toBeLessThanOrEqual(Date.parse('2032-05-01T00:00:00Z'));
    // Add an older partition than any that exists: the answer moves to it.
    await new PartitionService(
      dbLike,
      loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
      }),
    ).ensureRange(
      new Date('2031-12-31T00:00:00Z'),
      new Date('2031-12-31T00:00:00Z'),
      new Date('2031-12-31T00:00:00Z'),
      {
        wait: true,
      },
    );
    try {
      const after = await stats.retainedFrom();
      expect(after.m1!.getTime()).toBeLessThanOrEqual(Date.parse('2031-12-31T00:00:00Z'));
      expect(after.h1!.getTime()).toBeLessThanOrEqual(Date.parse('2031-12-01T00:00:00Z'));
    } finally {
      await dropPartitionsOfYear(pool, 2031);
    }
  });

  it('excludes a partition that is mid-detach: its data is on the way out', async () => {
    const svc = new PartitionService(
      dbLike,
      loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
      }),
    );
    const old = new Date('2020-01-05T00:00:00Z');
    await svc.ensureRange(old, old, old, { wait: true });
    const reader = new Client({ connectionString: testDatabaseUrl() });
    const detacher = new Client({ connectionString: testDatabaseUrl() });
    await reader.connect();
    await detacher.connect();
    try {
      expect((await stats.retainedFrom()).m1!.getTime()).toBeLessThanOrEqual(old.getTime());

      // A reader holds the partition, so DETACH ... CONCURRENTLY cannot finish
      // and leaves it pending. Its lock_timeout (not a sleep) ends the wait.
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM probe_stats_m1_p20200105');
      await detacher.query(`SET lock_timeout = '300ms'`);
      await expect(
        detacher.query(
          `ALTER TABLE probe_stats_m1 DETACH PARTITION probe_stats_m1_p20200105 CONCURRENTLY`,
        ),
      ).rejects.toThrow(/lock timeout/);

      const pending = await pool.query<{ p: boolean }>(
        `SELECT inhdetachpending AS p FROM pg_inherits WHERE inhrelid = 'probe_stats_m1_p20200105'::regclass`,
      );
      expect(pending.rows[0].p).toBe(true);
      expect((await stats.retainedFrom()).m1!.getTime()).toBeGreaterThan(old.getTime());

      await reader.query('COMMIT');
      await detacher.query(
        `ALTER TABLE probe_stats_m1 DETACH PARTITION probe_stats_m1_p20200105 FINALIZE`,
      );
    } finally {
      await reader.end();
      await detacher.end();
      await dropPartitionsOfYear(pool, 2020);
    }
  });
});
