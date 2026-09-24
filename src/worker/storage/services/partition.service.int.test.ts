import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { PartitionService } from './partition.service.js';

const { db, pool, close } = connectTestDb();
afterAll(close);

const dbLike = { kysely: db } as never;

function partitions(): PartitionService {
  return new PartitionService(
    dbLike,
    loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    }),
  );
}

beforeEach(async () => {
  await truncateAll(pool);
});

describe('PartitionService', () => {
  const FAR = new Date('2031-03-30T12:00:00Z');
  const FAR_END = new Date('2031-04-02T12:00:00Z');

  async function dropFar(): Promise<void> {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname ~ '_p(2031[0-9]{2,4})$' AND relkind = 'r'`,
    );
    for (const r of rows) await pool.query(`DROP TABLE IF EXISTS "${r.relname}"`);
  }

  beforeEach(dropFar);
  afterAll(dropFar);

  it('creates every family up to the horizon, each partition attached to its own parent', async () => {
    const res = await partitions().ensureRange(FAR, FAR_END, FAR_END, { wait: true });
    expect(res.ran).toBe(true);
    expect(res.created).toEqual(
      expect.arrayContaining([
        'probe_results_p20310330',
        'probe_results_p20310402',
        'claim_log_p20310331',
        'probe_stats_m1_p20310401',
        'probe_stats_h1_p203103',
        'probe_stats_h1_p203104',
      ]),
    );
    const { rows } = await pool.query<{ child: string; parent: string; bound: string }>(
      `SELECT c.relname AS child, p.relname AS parent, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
        WHERE c.relname = 'probe_results_p20310331'`,
    );
    expect(rows[0]).toMatchObject({ parent: 'probe_results' });
    // Explicit UTC bounds: midnight to midnight, whatever the session zone.
    expect(rows[0].bound).toContain("'2031-03-31 00:00:00+00'");
    expect(rows[0].bound).toContain("'2031-04-01 00:00:00+00'");
  });

  it('is idempotent: a second pass over the same range creates nothing and fails nothing', async () => {
    const svc = partitions();
    await svc.ensureRange(FAR, FAR_END, FAR_END, { wait: true });
    const again = await svc.ensureRange(FAR, FAR_END, FAR_END, { wait: true });
    expect(again).toEqual({ ran: true, created: [] });
  });

  it('survives concurrent callers: no "relation already exists", each partition created once', async () => {
    const svc = partitions();
    const results = await Promise.all([
      svc.ensureRange(FAR, FAR_END, FAR_END, { wait: true }),
      svc.ensureRange(FAR, FAR_END, FAR_END, { wait: true }),
      svc.ensureRange(FAR, FAR_END, FAR_END, { wait: true }),
    ]);
    const all = results.flatMap((r) => r.created);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });

  it('skips, without waiting, when another worker holds the lock -- and runs once it is released', async () => {
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('probeboard:partitions'))`);
      const skipped = await partitions().ensureRange(FAR, FAR_END, FAR_END, { wait: false });
      expect(skipped).toEqual({ ran: false, created: [] });
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    const ran = await partitions().ensureRange(FAR, FAR_END, FAR_END, { wait: false });
    expect(ran.ran).toBe(true);
  });

  it('reports the horizon from the catalogue: ensure() leaves at least the configured days', async () => {
    await partitions().ensure(new Date(), { wait: true });
    expect(await partitions().horizonDays(new Date())).toBeGreaterThanOrEqual(3);
  });
});
