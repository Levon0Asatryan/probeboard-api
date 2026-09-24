import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { EndpointRuntimeRepository } from '../../scheduler/repositories/endpoint-runtime.repository.js';
import { ResultRecorderService } from '../../scheduler/services/result-recorder.service.js';
import type { FailureClass, ProbeOutcome } from '../../probing/index.js';
import { ProbeResultRepository } from '../repositories/probe-result.repository.js';
import { toResultRow } from '../utils/outcome-mapping.js';

const { db, pool, close } = connectTestDb();
afterAll(close);

function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    ...over,
  });
}

const dbLike = { kysely: db } as never;

function recorder(over: Record<string, string> = {}): ResultRecorderService {
  return new ResultRecorderService(
    dbLike,
    new ProbeResultRepository(dbLike),
    new EndpointRuntimeRepository(dbLike),
    config(over),
  );
}

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    monitorId: 'x',
    startedAt: Date.now(),
    success: true,
    status: 200,
    timings: { totalMs: 42.4, ttfbMs: 30 },
    truncated: false,
    redirects: 0,
    ...over,
  };
}

const SLOT = '2026-09-21 08:45:12.178512+00';

/** One endpoint whose runtime row is leased by `leasedBy` for `SLOT`. */
async function leasedEndpoint(leasedBy = 'w1'): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('s@example.com', 'x') RETURNING id`,
  );
  const service = await pool.query<{ id: string }>(
    `INSERT INTO services (user_id, name, base_url) VALUES ($1, 's', 'http://127.0.0.1:1') RETURNING id`,
    [user.rows[0].id],
  );
  const ep = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     VALUES ($1, $2, 'GET', '/p', 60, 5000, 5) RETURNING id`,
    [service.rows[0].id, user.rows[0].id],
  );
  const id = ep.rows[0].id;
  await pool.query(
    `INSERT INTO endpoint_runtime (endpoint_id, next_run_at, scheduled_at, scheduled_interval_s, leased_by, leased_until)
     VALUES ($1, now(), $2::timestamptz, 60, $3, now() + interval '1 minute')`,
    [id, SLOT, leasedBy],
  );
  return id;
}

async function runtime(id: string) {
  const { rows } = await pool.query<{ leased_by: string | null; last_probe_at: Date | null }>(
    `SELECT leased_by, last_probe_at FROM endpoint_runtime WHERE endpoint_id = $1`,
    [id],
  );
  return rows[0];
}

const fence = (endpointId: string) => ({ endpointId, workerId: 'w1', slot: SLOT });

beforeEach(async () => {
  await truncateAll(pool);
});

describe('schema (0008)', () => {
  it('has no default partition on any partitioned table -- a missing partition must be an error', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    );
    expect(rows[0].n).toBe('0');
  });

  it('reuses the 0001 failure_class enum: its labels are exactly the lowercased FailureClass union', async () => {
    const union: Record<FailureClass, true> = {
      DNS_NXDOMAIN: true,
      DNS_FAILURE: true,
      CONNECTION_REFUSED: true,
      CONNECTION_TIMEOUT: true,
      CONNECTION_RESET: true,
      TLS_EXPIRED: true,
      TLS_UNTRUSTED: true,
      TLS_HOSTNAME_MISMATCH: true,
      TLS_HANDSHAKE_FAILED: true,
      RESPONSE_TIMEOUT: true,
      BODY_TIMEOUT: true,
      STATUS_MISMATCH: true,
      ASSERTION_FAILED: true,
      TOO_MANY_REDIRECTS: true,
      BLOCKED_BY_POLICY: true,
      UNKNOWN_ERROR: true,
    };
    const { rows } = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'failure_class'`,
    );
    expect(rows.map((r) => r.enumlabel).sort()).toEqual(
      Object.keys(union)
        .map((k) => k.toLowerCase())
        .sort(),
    );
  });

  it('reuses the 0001 probe_outcome enum: its labels are the four the writer can produce', async () => {
    const { rows } = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'probe_outcome'`,
    );
    expect(rows.map((r) => r.enumlabel).sort()).toEqual(['degraded', 'down', 'unknown', 'up']);
  });

  it('rejects an insert with no partition rather than filing it somewhere', async () => {
    await expect(
      new ProbeResultRepository(dbLike).insert(
        toResultRow(outcome({ startedAt: Date.parse('2099-01-01T00:00:00Z') }), {
          endpointId: '00000000-0000-4000-8000-000000000001',
          slot: SLOT,
          intervalS: 60,
          workerId: 'w1',
          attemptId: '00000000-0000-4000-8000-0000000000a1',
        }),
      ),
    ).rejects.toThrow(/no partition of relation "probe_results"/);
  });
});

describe('ResultRecorderService (real transaction)', () => {
  it('stores the result and clears the lease in one commit, microseconds intact', async () => {
    const id = await leasedEndpoint();
    const row = toResultRow(outcome(), {
      endpointId: id,
      slot: SLOT,
      intervalS: 60,
      workerId: 'w1',
      attemptId: '00000000-0000-4000-8000-0000000000a1',
    });
    const res = await recorder().recordAndRelease(row, fence(id), () => 2000);
    expect(res).toEqual({ inserted: 1, released: 1 });

    const stored = await pool.query<{
      slot: string;
      outcome: string;
      total_ms: number;
      interval_s: number;
    }>(
      `SELECT scheduled_at::text AS slot, outcome::text AS outcome, total_ms, interval_s FROM probe_results WHERE endpoint_id = $1`,
      [id],
    );
    expect(stored.rows).toEqual([{ slot: SLOT, outcome: 'up', total_ms: 42, interval_s: 60 }]);
    const rt = await runtime(id);
    expect(rt.leased_by).toBeNull();
    expect(rt.last_probe_at).not.toBeNull();
  });

  it('still stores the result when the fence matches nothing (the lease was lost): the probe happened', async () => {
    const id = await leasedEndpoint('someone-else');
    const row = toResultRow(outcome(), {
      endpointId: id,
      slot: SLOT,
      intervalS: 60,
      workerId: 'w1',
      attemptId: '00000000-0000-4000-8000-0000000000a2',
    });
    const res = await recorder().recordAndRelease(row, fence(id), () => 2000);
    expect(res).toEqual({ inserted: 1, released: 0 });
    expect((await runtime(id)).leased_by).toBe('someone-else');
    const { rows } = await pool.query(`SELECT 1 FROM probe_results WHERE endpoint_id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('a retried write of the same attempt is idempotent', async () => {
    const id = await leasedEndpoint();
    const row = toResultRow(outcome(), {
      endpointId: id,
      slot: SLOT,
      intervalS: 60,
      workerId: 'w1',
      attemptId: '00000000-0000-4000-8000-0000000000a3',
    });
    const first = await recorder().recordAndRelease(row, fence(id), () => 2000);
    const second = await recorder().recordAndRelease(row, fence(id), () => 2000);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    const { rows } = await pool.query(`SELECT 1 FROM probe_results WHERE endpoint_id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('keeps two attempts in the same millisecond as two rows -- a duplicate slot is evidence, not a conflict', async () => {
    const id = await leasedEndpoint();
    const startedAt = Date.now();
    for (const attemptId of [
      '00000000-0000-4000-8000-0000000000b1',
      '00000000-0000-4000-8000-0000000000b2',
    ]) {
      await recorder().recordAndRelease(
        toResultRow(outcome({ startedAt }), {
          endpointId: id,
          slot: SLOT,
          intervalS: 60,
          workerId: 'w1',
          attemptId,
        }),
        fence(id),
        () => 2000,
      );
    }
    const { rows } = await pool.query(`SELECT 1 FROM probe_results WHERE endpoint_id = $1`, [id]);
    expect(rows).toHaveLength(2);
  });

  it('rolls the release back when the insert fails: no partition, lease still held, no row', async () => {
    const id = await leasedEndpoint();
    const row = toResultRow(outcome({ startedAt: Date.parse('2099-01-01T00:00:00Z') }), {
      endpointId: id,
      slot: SLOT,
      intervalS: 60,
      workerId: 'w1',
      attemptId: '00000000-0000-4000-8000-0000000000c1',
    });
    await expect(
      recorder({ RESULT_WRITE_ATTEMPTS: '2' }).recordAndRelease(row, fence(id), () => 2000),
    ).rejects.toThrow(/no partition/);
    const rt = await runtime(id);
    expect(rt.leased_by).toBe('w1');
    expect(rt.last_probe_at).toBeNull();
    const { rows } = await pool.query(`SELECT 1 FROM probe_results`);
    expect(rows).toHaveLength(0);
  });

  it('rolls the result back when the release cannot complete: no row without the lease clearing', async () => {
    const id = await leasedEndpoint();
    const row = toResultRow(outcome(), {
      endpointId: id,
      slot: SLOT,
      intervalS: 60,
      workerId: 'w1',
      attemptId: '00000000-0000-4000-8000-0000000000d1',
    });
    // A second connection holds the runtime row, so the release blocks until
    // statement_timeout fires. The lock is taken before the call: no sleep.
    const blocker = new Client({ connectionString: testDatabaseUrl() });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM endpoint_runtime WHERE endpoint_id = $1 FOR UPDATE`, [id]);
      await expect(
        recorder({ RESULT_WRITE_ATTEMPTS: '1' }).recordAndRelease(row, fence(id), () => 150),
      ).rejects.toThrow(/statement timeout/);
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    const { rows } = await pool.query(`SELECT 1 FROM probe_results WHERE endpoint_id = $1`, [id]);
    expect(rows).toHaveLength(0);
    expect((await runtime(id)).leased_by).toBe('w1');
  });

  it.each([
    ['DNS_NXDOMAIN', 'down'],
    ['DNS_FAILURE', 'down'],
    ['CONNECTION_REFUSED', 'down'],
    ['CONNECTION_TIMEOUT', 'down'],
    ['CONNECTION_RESET', 'down'],
    ['TLS_EXPIRED', 'down'],
    ['TLS_UNTRUSTED', 'down'],
    ['TLS_HOSTNAME_MISMATCH', 'down'],
    ['TLS_HANDSHAKE_FAILED', 'down'],
    ['RESPONSE_TIMEOUT', 'down'],
    ['BODY_TIMEOUT', 'down'],
    ['STATUS_MISMATCH', 'down'],
    ['ASSERTION_FAILED', 'down'],
    ['TOO_MANY_REDIRECTS', 'down'],
    ['BLOCKED_BY_POLICY', 'unknown'],
    ['UNKNOWN_ERROR', 'unknown'],
  ] as const)('round-trips %s as %s with its class and code intact', async (cls, label) => {
    const id = await leasedEndpoint();
    const row = toResultRow(outcome({ success: false, failureClass: cls, code: `CODE_${cls}` }), {
      endpointId: id,
      slot: SLOT,
      intervalS: 60,
      workerId: 'w1',
      attemptId: '00000000-0000-4000-8000-0000000000e1',
    });
    await recorder().recordAndRelease(row, fence(id), () => 2000);
    const { rows } = await pool.query<{
      outcome: string;
      failure_class: string;
      failure_code: string;
    }>(
      `SELECT outcome::text AS outcome, failure_class::text AS failure_class, failure_code FROM probe_results WHERE endpoint_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      { outcome: label, failure_class: cls.toLowerCase(), failure_code: `CODE_${cls}` },
    ]);
  });
});
