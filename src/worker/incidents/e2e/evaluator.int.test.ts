import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import {
  createEndpoint,
  dropPartitionsOfYear,
  insertRaw,
  insertRawOn,
  type RawRow,
} from '../../../testing/storage-fixtures.js';
import { PartitionService } from '../../storage/services/partition.service.js';
import { EvaluatorRepository } from '../repositories/evaluator.repository.js';

/**
 * The evaluator against a real PostgreSQL (docs/m6-plan.md §7, §8). Results are
 * written in 2033 into partitions this file creates and drops, so the dates
 * are fixed and no other test's rows are in range.
 */
const { db, pool, close } = connectTestDb();
const dbLike = { kysely: db } as never;
const repo = new EvaluatorRepository(dbLike);
const DAY = '2033-03-10';
const t = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const GRACE_MS = 90_000;

const pass = () => repo.runOnce({ batchXids: 5000, unknownGraceMs: GRACE_MS });

afterAll(async () => {
  await dropPartitionsOfYear(pool, 2033);
  await close();
});

beforeEach(async () => {
  await truncateAll(pool);
  await dropPartitionsOfYear(pool, 2033);
  await new PartitionService(
    dbLike,
    loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    }),
  ).ensureRange(
    new Date(`${DAY}T00:00:00Z`),
    new Date('2033-03-12T00:00:00Z'),
    new Date('2033-03-12T00:00:00Z'),
    {
      wait: true,
    },
  );
});

/** One result per call, so each row has its own inserting transaction. */
async function results(endpointId: string, rows: [string, RawRow['outcome'], Partial<RawRow>?][]) {
  for (const [hhmm, outcome, over] of rows) {
    await insertRaw(pool, [{ endpointId, startedAt: t(hhmm), outcome, ...over }]);
  }
}

async function health(endpointId: string) {
  const { rows } = await pool.query(`SELECT * FROM endpoint_health WHERE endpoint_id = $1`, [
    endpointId,
  ]);
  return rows[0] as Record<string, unknown> | undefined;
}

async function incidents(endpointId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM incidents WHERE endpoint_id = $1 ORDER BY opened_at`,
    [endpointId],
  );
  return rows as Record<string, unknown>[];
}

async function outbox() {
  const { rows } = await pool.query<{ kind: string; incident_id: string }>(
    `SELECT kind, incident_id FROM notification_outbox ORDER BY created_at, kind`,
  );
  return rows;
}

describe('acceptance: down, an incident after three failures timed from the first, closed after two', () => {
  it('opens at 10:03 an incident that began at 10:01, and closes it from the first success', async () => {
    const { endpointId } = await createEndpoint(pool, 'acc@example.com');

    // 1. Two failures: pending, "failing, 2 of 3", no incident.
    await results(endpointId, [
      ['10:00', 'up'],
      ['10:01', 'down', { failureClass: 'dns_failure' }],
      ['10:02', 'down'],
    ]);
    await pass();
    expect(await health(endpointId)).toMatchObject({ state: 'pending', consecutive_failures: 2 });
    expect(await incidents(endpointId)).toEqual([]);

    // 2. The third: one incident, timed from the first failure, caused by it.
    await results(endpointId, [['10:03', 'down']]);
    const opened = await pass();
    const [incident] = await incidents(endpointId);
    expect(incident).toMatchObject({
      opened_at: new Date(t('10:01')),
      confirmed_at: new Date(t('10:03')),
      failures_to_open: 3,
      cause_class: 'dns_failure',
      closed_at: null,
    });
    expect(opened.opened).toEqual([{ endpointId, incidentId: incident.id }]);
    expect(await health(endpointId)).toMatchObject({
      state: 'down',
      open_incident_id: incident.id,
    });
    expect(await outbox()).toEqual([{ kind: 'incident_open', incident_id: incident.id }]);

    // 3. One success: still open. And the pass reports only what it did --
    // not the incident an earlier pass opened (the real run caught every
    // later pass re-reporting it).
    await results(endpointId, [['10:04', 'up']]);
    expect(await pass()).toMatchObject({ opened: [], closed: [] });
    expect((await incidents(endpointId))[0].closed_at).toBeNull();
    expect(await health(endpointId)).toMatchObject({ state: 'down' });

    // 4. The second: closed at the first success of the recovery.
    await results(endpointId, [['10:05', 'up']]);
    await pass();
    expect((await incidents(endpointId))[0]).toMatchObject({
      closed_at: new Date(t('10:04')),
      close_confirmed_at: new Date(t('10:05')),
    });
    expect(await health(endpointId)).toMatchObject({ state: 'up', open_incident_id: null });
    expect((await outbox()).map((o) => o.kind)).toEqual(['incident_open', 'incident_close']);
  });

  it('reads the thresholds from the endpoint when it evaluates (D17)', async () => {
    const { endpointId } = await createEndpoint(pool, 'n1@example.com');
    await pool.query(`UPDATE endpoints SET failure_threshold = 1 WHERE id = $1`, [endpointId]);
    await results(endpointId, [['10:01', 'down']]);
    await pass();
    expect(await incidents(endpointId)).toHaveLength(1);
  });

  it('shows a slow success as degraded', async () => {
    const { endpointId } = await createEndpoint(pool, 'slow@example.com');
    await results(endpointId, [['10:01', 'degraded']]);
    await pass();
    expect(await health(endpointId)).toMatchObject({ state: 'degraded' });
  });
});

describe('exactly once (plan §3.3)', () => {
  it('rolls back the incident with a failed outbox write, and applies it once on the retry (ADR-0008)', async () => {
    const { endpointId } = await createEndpoint(pool, 'crash@example.com');
    await results(endpointId, [
      ['10:01', 'down'],
      ['10:02', 'down'],
      ['10:03', 'down'],
    ]);
    const watermark = async () =>
      (
        await pool.query(
          `SELECT last_xid::text AS x FROM rollup_state WHERE name = 'incident_evaluator'`,
        )
      ).rows[0].x as string;
    const before = await watermark();

    // Fails the pass after the incident insert, inside the same transaction.
    await pool.query(`
      CREATE FUNCTION pg_temp_fail() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$`);
    await pool.query(`
      CREATE TRIGGER outbox_fails BEFORE INSERT ON notification_outbox
        FOR EACH ROW EXECUTE FUNCTION pg_temp_fail()`);
    try {
      await expect(pass()).rejects.toThrow(/injected outbox failure/);
    } finally {
      await pool.query(`DROP TRIGGER outbox_fails ON notification_outbox`);
      await pool.query(`DROP FUNCTION pg_temp_fail()`);
    }
    expect(await incidents(endpointId)).toEqual([]);
    expect(await health(endpointId)).toBeUndefined();
    expect(await watermark()).toBe(before);

    await pass();
    await pass();
    expect(await incidents(endpointId)).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    expect(await health(endpointId)).toMatchObject({ consecutive_failures: 3 });
  });

  it('refuses a close the incidents table disagrees with, rather than skipping it (rule #21)', async () => {
    const { endpointId } = await createEndpoint(pool, 'fence@example.com');
    await results(endpointId, [
      ['10:01', 'down'],
      ['10:02', 'down'],
      ['10:03', 'down'],
    ]);
    await pass();
    // Something outside the evaluator closed it: the state and the table disagree.
    await pool.query(
      `UPDATE incidents SET closed_at = $1, close_confirmed_at = $1 WHERE endpoint_id = $2`,
      [t('10:04'), endpointId],
    );
    await results(endpointId, [
      ['10:05', 'up'],
      ['10:06', 'up'],
    ]);
    await expect(pass()).rejects.toThrow(/is not open/);
  });
});

describe('no result lost to commit order (M5 C3)', () => {
  it('holds back later results while an earlier write is open, then applies all in order', async () => {
    const { endpointId } = await createEndpoint(pool, 'order@example.com');
    const open = new Client({ connectionString: testDatabaseUrl() });
    await open.connect();
    try {
      // The first failure's write takes a lower xid and stays open -- the slow
      // probe's commit arriving after its successors'.
      await open.query('BEGIN');
      await open.query('SELECT pg_current_xact_id()');
      await insertRawOn(open, { endpointId, startedAt: t('10:01'), outcome: 'down' });
      await results(endpointId, [
        ['10:02', 'down'],
        ['10:03', 'down'],
      ]);

      const held = await pass();
      expect(held.evaluated).toBe(0);
      expect(await health(endpointId)).toBeUndefined();

      await open.query('COMMIT');
    } finally {
      await open.end();
    }
    const done = await pass();
    expect(done).toMatchObject({ evaluated: 3, late: 0 });
    expect((await incidents(endpointId))[0]).toMatchObject({ opened_at: new Date(t('10:01')) });
  });

  it('does not let a zombie result rewind the state (D3)', async () => {
    const { endpointId } = await createEndpoint(pool, 'zombie@example.com');
    await results(endpointId, [['10:05', 'up']]);
    await pass();
    // A lapsed lease's probe for an earlier slot, committing afterwards.
    await results(endpointId, [['10:04', 'down']]);
    const p = await pass();
    expect(p).toMatchObject({ evaluated: 0, late: 1 });
    expect(await health(endpointId)).toMatchObject({ state: 'up', consecutive_failures: 0 });
  });
});

describe('single flight', () => {
  it('returns at once, reading nothing, while another worker holds the watermark row', async () => {
    const { endpointId } = await createEndpoint(pool, 'flight@example.com');
    await results(endpointId, [['10:01', 'down']]);
    const other = new Client({ connectionString: testDatabaseUrl() });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM rollup_state WHERE name = 'incident_evaluator' FOR UPDATE`);
      // Promptness is the property: without SKIP LOCKED this pass would block
      // on the held row until the other transaction ends (rule #13).
      const outcome = await Promise.race([
        pass(),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
      ]);
      expect(outcome).toMatchObject({ skipped: true, evaluated: 0 });
      await other.query('ROLLBACK');
    } finally {
      await other.end();
    }
    expect(await health(endpointId)).toBeUndefined();
  });
});

describe('maintenance (D-6)', () => {
  it('opens nothing and queues nothing for failures inside a window', async () => {
    const { endpointId } = await createEndpoint(pool, 'maint@example.com');
    await results(
      endpointId,
      ['10:01', '10:02', '10:03', '10:04', '10:05'].map(
        (m) => [m, 'down', { inMaintenance: true }] as [string, 'down', Partial<RawRow>],
      ),
    );
    await pass();
    expect(await incidents(endpointId)).toEqual([]);
    expect(await outbox()).toEqual([]);
    expect(await health(endpointId)).toMatchObject({ consecutive_failures: 0, state: 'pending' });
  });

  it('keeps an incident open before a window as the same incident after it (Kuma #2846)', async () => {
    const { endpointId } = await createEndpoint(pool, 'kuma@example.com');
    await results(endpointId, [
      ['10:01', 'down'],
      ['10:02', 'down'],
      ['10:03', 'down'],
      ['10:04', 'down', { inMaintenance: true }],
      ['10:05', 'down', { inMaintenance: true }],
      ['10:06', 'down'],
      ['10:07', 'down'],
      ['10:08', 'down'],
    ]);
    await pass();
    expect(await incidents(endpointId)).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });
});

describe('unknown (D-7)', () => {
  it('never opens an incident for results probeboard refused', async () => {
    const { endpointId } = await createEndpoint(pool, 'policy@example.com');
    await results(
      endpointId,
      ['10:01', '10:02', '10:03', '10:04'].map(
        (m) => [m, 'unknown'] as [string, 'unknown', Partial<RawRow>?],
      ),
    );
    await pass();
    expect(await incidents(endpointId)).toEqual([]);
    expect(await health(endpointId)).toMatchObject({ state: 'unknown', consecutive_failures: 0 });
  });
});

describe('the UNKNOWN sweep (plan §3.6)', () => {
  async function runtime(endpointId: string, lastProbeAgo: string | null, updatedAgo: string) {
    await pool.query(
      `INSERT INTO endpoint_runtime (endpoint_id, next_run_at, last_probe_at)
       VALUES ($1, now(), CASE WHEN $2::text IS NULL THEN NULL ELSE now() - $2::interval END)`,
      [endpointId, lastProbeAgo],
    );
    await pool.query(`UPDATE endpoints SET updated_at = now() - $2::interval WHERE id = $1`, [
      endpointId,
      updatedAgo,
    ]);
  }

  it('marks an enabled endpoint with no result for 2 x interval + grace unknown', async () => {
    const { endpointId } = await createEndpoint(pool, 'silent@example.com', 60);
    await runtime(endpointId, '10 minutes', '1 hour');
    expect((await pass()).markedUnknown).toBe(1);
    expect(await health(endpointId)).toMatchObject({ state: 'unknown' });
    // Once: a second pass changes nothing.
    expect((await pass()).markedUnknown).toBe(0);
  });

  it('leaves one inside its window alone', async () => {
    // 2 x 60 s + 90 s = 210 s.
    const { endpointId } = await createEndpoint(pool, 'recent@example.com', 60);
    await runtime(endpointId, '200 seconds', '1 hour');
    await pass();
    expect(await health(endpointId)).toBeUndefined();
  });

  it('gives a new endpoint its full window before its first result (C6)', async () => {
    const { endpointId } = await createEndpoint(pool, 'new@example.com', 60);
    await runtime(endpointId, null, '5 seconds');
    await pass();
    expect(await health(endpointId)).toBeUndefined();
  });

  it('does not call a paused endpoint unknown (C7)', async () => {
    const { endpointId } = await createEndpoint(pool, 'paused@example.com', 60);
    await runtime(endpointId, '1 hour', '1 hour');
    await pool.query(`UPDATE endpoints SET enabled = false WHERE id = $1`, [endpointId]);
    await pool.query(`UPDATE endpoints SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
      endpointId,
    ]);
    await pass();
    expect(await health(endpointId)).toBeUndefined();
  });

  it('leaves an open incident open: silence is no evidence of recovery', async () => {
    const { endpointId } = await createEndpoint(pool, 'stuck@example.com', 60);
    await results(endpointId, [
      ['10:01', 'down'],
      ['10:02', 'down'],
      ['10:03', 'down'],
    ]);
    await pass();
    await runtime(endpointId, '1 hour', '1 hour');
    await pass();
    expect(await health(endpointId)).toMatchObject({ state: 'unknown', consecutive_failures: 3 });
    expect((await incidents(endpointId))[0].closed_at).toBeNull();
  });
});

describe('deletion (plan §3.12, D13)', () => {
  it("removes a deleted endpoint's state, incidents and outbox rows, and ignores its late results", async () => {
    const { endpointId } = await createEndpoint(pool, 'gone@example.com');
    await results(endpointId, [
      ['10:01', 'down'],
      ['10:02', 'down'],
      ['10:03', 'down'],
    ]);
    await pass();
    expect(await outbox()).toHaveLength(1);

    await pool.query(`DELETE FROM endpoints WHERE id = $1`, [endpointId]);
    await results(endpointId, [['10:04', 'up']]);
    const p = await pass();
    expect(p.evaluated).toBe(0);
    expect(p.orphansRemoved).toBe(2);
    expect(await health(endpointId)).toBeUndefined();
    expect(await incidents(endpointId)).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('has no foreign key from its tables to endpoints: one deadlocks a cascading delete (plan §2.4.1)', async () => {
    // Measured 20/20 deadlocks with the key and 0/20 without. A structural
    // check, because the race needs an interleaving no test can force here.
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'endpoints'::regclass
          AND conrelid IN ('endpoint_health'::regclass, 'incidents'::regclass)`,
    );
    expect(rows).toEqual([]);
  });
});
