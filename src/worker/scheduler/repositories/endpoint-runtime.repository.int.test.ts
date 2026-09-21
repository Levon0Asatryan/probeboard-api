import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { EndpointRuntimeRepository } from './endpoint-runtime.repository.js';

/**
 * The claim against a real PostgreSQL.
 *
 * None of this is testable against a mock: `FOR UPDATE SKIP LOCKED`,
 * EvalPlanQual re-checking, transactional visibility and `now()`'s
 * transaction-start semantics are the behaviour under test, and a duplicate
 * that needs genuine concurrent transactions will not appear against a fake.
 *
 * Every race here is forced with a barrier — a competing statement committed,
 * or left deliberately uncommitted, on a second connection — never with a
 * sleep and never with a hopeful `Promise.all`.
 */
const { db, pool, close } = connectTestDb();
const repo = new EndpointRuntimeRepository({ kysely: db } as never);

const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';
const LEASE_MS = 60_000;

let userId: string;
let serviceId: string;

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(pool);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('s@example.com', 'x') RETURNING id`,
  );
  userId = user.rows[0].id;
  const service = await pool.query<{ id: string }>(
    `INSERT INTO services (user_id, name, base_url) VALUES ($1, 'svc', 'https://example.com')
     RETURNING id`,
    [userId],
  );
  serviceId = service.rows[0].id;
});

/** An endpoint plus, unless `adopt` is false, its runtime row at a chosen slot. */
async function makeEndpoint(opts: {
  intervalS?: number;
  enabled?: boolean;
  path?: string;
  /** Seconds relative to now: negative is overdue. Omit to leave unadopted. */
  dueInS?: number;
  scheduledIntervalS?: number;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (service_id, user_id, path, interval_s, timeout_ms, max_redirects, enabled)
     VALUES ($1, $2, $3, $4, 10000, 5, $5) RETURNING id`,
    [
      serviceId,
      userId,
      opts.path ?? `/p${String(Math.random()).slice(2)}`,
      opts.intervalS ?? 60,
      opts.enabled ?? true,
    ],
  );
  const id = rows[0].id;
  if (opts.dueInS !== undefined) {
    await pool.query(
      `INSERT INTO endpoint_runtime (endpoint_id, next_run_at, scheduled_interval_s)
       VALUES ($1, now() + make_interval(secs => $2::float8), $3)`,
      [id, opts.dueInS, opts.scheduledIntervalS ?? opts.intervalS ?? 60],
    );
  }
  return id;
}

interface RuntimeRow {
  next_run_at: Date;
  scheduled_at: Date | null;
  scheduled_interval_s: number | null;
  leased_until: Date | null;
  leased_by: string | null;
  last_probe_at: Date | null;
}

async function runtimeRow(endpointId: string): Promise<RuntimeRow> {
  const { rows } = await pool.query<RuntimeRow>(
    `SELECT next_run_at, scheduled_at, scheduled_interval_s, leased_until, leased_by, last_probe_at
     FROM endpoint_runtime WHERE endpoint_id = $1`,
    [endpointId],
  );
  return rows[0];
}

/**
 * A second connection holding an uncommitted claim.
 *
 * The barrier is the statement itself: once `query` has returned, the row
 * locks are held and the transaction is still open. Nothing here waits on a
 * clock.
 */
async function holdUncommittedClaim(batch: number): Promise<{
  ids: string[];
  client: Client;
  commit: () => Promise<void>;
}> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  await client.query('BEGIN');
  const compiled = repo.claimQuery(WORKER_B, LEASE_MS, batch).compile(db);
  const { rows } = await client.query<{ endpoint_id: string }>(compiled.sql, [
    ...compiled.parameters,
  ]);
  return {
    ids: rows.map((r) => r.endpoint_id),
    client,
    commit: async () => {
      await client.query('COMMIT');
      await client.end();
    },
  };
}

/**
 * Blocks until some other backend is waiting on a lock.
 *
 * `pg_stat_activity`, not `pg_locks` joined to `pg_class`: a statement blocked
 * on a row or index tuple waits on the holding transaction's `transactionid`,
 * whose `pg_locks.relation` is NULL, so a relation-name join never fires and
 * the barrier times out instead of releasing. That mistake turned an M3 suite
 * into a 606-second one.
 */
async function waitForBlockedBackend(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('no backend ever blocked: the barrier did not engage');
}

describe('claim: disjointness and non-blocking', () => {
  it('returns a disjoint batch while the other claim is still uncommitted', async () => {
    // The row-lock half of NFR-3. A committed-first ordering would only
    // exercise the leased_until predicate -- B would be reading a lease that
    // is already durably written, never entering the concurrent window.
    for (let i = 0; i < 6; i += 1) await makeEndpoint({ dueInS: -10 - i });

    const held = await holdUncommittedClaim(3);
    expect(held.ids).toHaveLength(3);

    const mine = await repo.claim(WORKER_A, LEASE_MS, 3);
    expect(mine).toHaveLength(3);
    expect(mine.map((r) => r.endpoint_id).filter((id) => held.ids.includes(id))).toEqual([]);

    await held.commit();
  });

  it('returns promptly while another claim holds its rows, rather than blocking', async () => {
    // This is what SKIP LOCKED actually buys. Removing it does NOT produce
    // duplicates -- EvalPlanQual re-checks the locking node's qualifiers, so
    // the second worker skips the leased rows once unblocked -- it produces
    // *blocking*. Measured on this schema at 2.182ms versus 11,984ms.
    //
    // statement_timeout is the bound that makes the blocked case a fast,
    // deterministic failure instead of a suite-length hang. It is not a sleep:
    // nothing waits on it when the clause is present.
    for (let i = 0; i < 6; i += 1) await makeEndpoint({ dueInS: -10 - i });
    const held = await holdUncommittedClaim(3);

    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query(`SET statement_timeout = '2s'`);
      const compiled = repo.claimQuery(WORKER_A, LEASE_MS, 3).compile(db);
      const { rows } = await client.query<{ endpoint_id: string }>(compiled.sql, [
        ...compiled.parameters,
      ]);
      expect(rows).toHaveLength(3);
    } finally {
      await client.end();
      await held.commit();
    }
  });

  it('never returns the same slot to two workers', async () => {
    await makeEndpoint({ dueInS: -5 });
    const first = await repo.claim(WORKER_A, LEASE_MS, 10);
    const second = await repo.claim(WORKER_B, LEASE_MS, 10);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});

describe('claim: what it selects', () => {
  it('skips a disabled endpoint', async () => {
    await makeEndpoint({ dueInS: -5, enabled: false });
    expect(await repo.claim(WORKER_A, LEASE_MS, 10)).toEqual([]);
  });

  it('skips an endpoint that is not due yet', async () => {
    await makeEndpoint({ dueInS: 300 });
    expect(await repo.claim(WORKER_A, LEASE_MS, 10)).toEqual([]);
  });

  it('skips a row whose probe is still in flight', async () => {
    const id = await makeEndpoint({ dueInS: -5 });
    await pool.query(
      `UPDATE endpoint_runtime SET leased_until = now() + interval '30 s', leased_by = $2
       WHERE endpoint_id = $1`,
      [id, WORKER_B],
    );
    expect(await repo.claim(WORKER_A, LEASE_MS, 10)).toEqual([]);
  });

  it('does not take a row whose lease lapsed but whose next slot is still ahead', async () => {
    // NFR-4's bound is max(next_run_at, lease expiry) -- both predicates, not
    // either. At a 300s interval and a 60s lease the *interval* governs, and
    // nothing in the suite covered that regime: mutating the due predicate to
    // `next_run_at <= now() OR leased_until < now()` -- a 300s monitor probed
    // early every time a lease lapses, exactly the bug §3.11 names -- left all
    // 29 tests green.
    //
    // "not due yet" does not cover it either: that row has leased_until NULL,
    // so an OR-shaped bug short-circuits on NULL and the row is skipped anyway.
    const id = await makeEndpoint({ intervalS: 300, dueInS: 250 });
    await pool.query(
      `UPDATE endpoint_runtime SET leased_until = now() - interval '1 s', leased_by = $2
       WHERE endpoint_id = $1`,
      [id, WORKER_B],
    );
    expect(await repo.claim(WORKER_A, LEASE_MS, 10)).toEqual([]);
  });

  it('takes a row whose lease has lapsed', async () => {
    const id = await makeEndpoint({ dueInS: -5 });
    await pool.query(
      `UPDATE endpoint_runtime SET leased_until = now() - interval '1 s', leased_by = $2
       WHERE endpoint_id = $1`,
      [id, WORKER_B],
    );
    const claimed = await repo.claim(WORKER_A, LEASE_MS, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].endpoint_id).toBe(id);
  });

  it('takes the oldest slots first and never more than the batch', async () => {
    const oldest = await makeEndpoint({ dueInS: -300 });
    const middle = await makeEndpoint({ dueInS: -200 });
    await makeEndpoint({ dueInS: -100 });
    const claimed = await repo.claim(WORKER_A, LEASE_MS, 2);
    expect(claimed.map((r) => r.endpoint_id)).toEqual([oldest, middle]);
  });
});

describe('the catch-up guard', () => {
  it('fires once for a monitor forty intervals behind, and lands on the next future slot', async () => {
    const id = await makeEndpoint({ intervalS: 60, dueInS: -60 * 40 });
    const claimed = await repo.claim(WORKER_A, LEASE_MS, 10);
    expect(claimed).toHaveLength(1);

    const row = await runtimeRow(id);
    // misses + 1 = 41 intervals on from the claimed slot, and strictly future.
    const jumped = (row.next_run_at.getTime() - new Date(claimed[0].scheduled_at).getTime()) / 1000;
    expect(jumped).toBe(60 * 41);
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());

    // A second claim finds nothing: one probe for the whole backlog, no burst.
    expect(await repo.claim(WORKER_A, LEASE_MS, 10)).toEqual([]);
  });

  it('is strictly future even when the row is due at exactly now()', async () => {
    // The boundary floor()+1 exists for, and the only case where it differs
    // from ceil(): at an exact multiple, ceil() returns now(), so the row is
    // immediately due again and the tick spins.
    //
    // Wall-clock timing never lands on that boundary -- by the time a claim
    // runs, now() is milliseconds past the slot, where ceil() also gives 1.
    // A row merely inserted "due now" therefore proves nothing; confirmed by
    // swapping floor()+1 for ceil() and watching such a test stay green.
    // now() is transaction-start time, so doing the setup and the claim in
    // one transaction makes the difference exactly zero.
    const id = await makeEndpoint({ intervalS: 60, dueInS: -5 });
    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query('BEGIN');
      const { rows: t } = await client.query<{ now: Date }>('SELECT now() AS now');
      await client.query(`UPDATE endpoint_runtime SET next_run_at = now() WHERE endpoint_id = $1`, [
        id,
      ]);
      const compiled = repo.claimQuery(WORKER_A, LEASE_MS, 10).compile(db);
      const { rows: claimed } = await client.query<{ next_run_at: Date }>(compiled.sql, [
        ...compiled.parameters,
      ]);
      expect(claimed).toHaveLength(1);
      // Strictly after the transaction's own now(), not equal to it.
      expect(claimed[0].next_run_at.getTime()).toBeGreaterThan(t[0].now.getTime());
      expect(claimed[0].next_run_at.getTime() - t[0].now.getTime()).toBe(60_000);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('derives the next slot from the schedule, never from the clock', async () => {
    // NFR-2's real content. A row 95s late at a 30s interval: misses = 3, so
    // the next slot is P + 120s, which is 25s from now. The wrong formula --
    // now() + interval -- would give 30s from now, and would put the endpoint
    // permanently off its original phase.
    const id = await makeEndpoint({ intervalS: 30, dueInS: -95 });
    const before = await runtimeRow(id);
    const slotP = before.next_run_at.getTime();

    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    expect(new Date(claimed.scheduled_at).getTime()).toBe(slotP);

    const row = await runtimeRow(id);
    const next = row.next_run_at.getTime();
    // Still on the original phase, whatever the lateness.
    expect(Math.abs((next - slotP) % 30_000)).toBe(0);
    expect(next).toBeGreaterThan(Date.now());
    // And it is the slot-derived value, not the clock-derived one.
    expect(next - slotP).toBe(120_000);
  });

  it('keeps the phase across several late cycles', async () => {
    // Each cycle is pushed back by whole intervals, which is what elapsed
    // time does to a schedule; the phase must survive all of them.
    const id = await makeEndpoint({ intervalS: 30, dueInS: -10 });
    const origin = (await runtimeRow(id)).next_run_at.getTime();

    // Ten, as §7's NFR-2 row specifies.
    for (let i = 0; i < 10; i += 1) {
      const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
      // Math.abs: a negative multiple yields -0, which Object.is
      // distinguishes from +0.
      expect(Math.abs((new Date(claimed.scheduled_at).getTime() - origin) % 30_000)).toBe(0);
      await repo.release(id, WORKER_A, claimed.scheduled_at);
      await pool.query(
        `UPDATE endpoint_runtime SET next_run_at = next_run_at - make_interval(secs => 60)
         WHERE endpoint_id = $1`,
        [id],
      );
    }
  });
});

describe('the lease', () => {
  it('release frees the next slot inside the previous lease', async () => {
    // Mandatory, not an optimisation: the shortest interval is 30s and the
    // lease is 60s, so without the release a 30s monitor would be probed
    // every 60s -- a 100% drift caused by the lease that protects NFR-3.
    const id = await makeEndpoint({ intervalS: 30, dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    const leaseEnds = (await runtimeRow(id)).leased_until!;

    expect(await repo.release(id, WORKER_A, claimed.scheduled_at)).toBe(1);

    // The 30s slot arrives, still well inside the 60s lease.
    await pool.query(`UPDATE endpoint_runtime SET next_run_at = now() WHERE endpoint_id = $1`, [
      id,
    ]);
    const again = await repo.claim(WORKER_A, LEASE_MS, 10);
    expect(again).toHaveLength(1);
    expect(Date.now()).toBeLessThan(leaseEnds.getTime());
  });

  it('release advances last_probe_at, abandon leaves it alone', async () => {
    const released = await makeEndpoint({ dueInS: -1 });
    const abandoned = await makeEndpoint({ dueInS: -1 });
    const claimed = await repo.claim(WORKER_A, LEASE_MS, 10);
    const bySlot = new Map(claimed.map((c) => [c.endpoint_id, c.scheduled_at]));

    await repo.release(released, WORKER_A, bySlot.get(released)!);
    await repo.abandon(abandoned, WORKER_A, bySlot.get(abandoned)!);

    expect((await runtimeRow(released)).last_probe_at).not.toBeNull();
    // M6 reads this for the UNKNOWN sweep: a slot nothing probed must not
    // look freshly observed, or the gap is never recorded.
    expect((await runtimeRow(abandoned)).last_probe_at).toBeNull();
    expect((await runtimeRow(abandoned)).leased_by).toBeNull();
  });

  it('a straggler cannot release a lease a later claim now holds', async () => {
    const id = await makeEndpoint({ intervalS: 30, dueInS: -1 });
    const [first] = await repo.claim(WORKER_A, LEASE_MS, 10);

    // The same worker re-claims the same endpoint for a later slot.
    await pool.query(
      `UPDATE endpoint_runtime SET leased_until = NULL, leased_by = NULL, next_run_at = now()
       WHERE endpoint_id = $1`,
      [id],
    );
    const [second] = await repo.claim(WORKER_A, LEASE_MS, 10);
    expect(second.scheduled_at).not.toEqual(first.scheduled_at);

    // The straggler from the first slot now tries to release.
    expect(await repo.release(id, WORKER_A, first.scheduled_at)).toBe(0);
    const row = await runtimeRow(id);
    expect(row.leased_by).toBe(WORKER_A);
    expect(row.leased_until).not.toBeNull();
  });

  it('a different worker cannot release what it does not hold', async () => {
    const id = await makeEndpoint({ dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    expect(await repo.release(id, WORKER_B, claimed.scheduled_at)).toBe(0);
    expect((await runtimeRow(id)).leased_by).toBe(WORKER_A);
  });
});

describe('adopt', () => {
  it('creates one row per endpoint and is idempotent', async () => {
    await makeEndpoint({});
    await makeEndpoint({});
    expect(await repo.adopt(60)).toBe(2);
    expect(await repo.adopt(60)).toBe(0);
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) n FROM endpoint_runtime`);
    expect(rows[0].n).toBe('2');
  });

  it('survives losing the insert race, rather than raising a unique violation', async () => {
    // ON CONFLICT DO NOTHING only matters when two adopts both pass the
    // NOT EXISTS check and both reach the insert. Promise.all does not force
    // that -- the anti-join alone carries the test whenever the statements do
    // not genuinely interleave, and deleting ON CONFLICT left it green 5 runs
    // out of 5.
    //
    // The barrier: another transaction inserts the row and holds it
    // uncommitted. Our adopt still sees no row, tries to insert, and blocks on
    // the primary key. Releasing the holder is what puts the conflict in front
    // of ON CONFLICT.
    const id = await makeEndpoint({});
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO endpoint_runtime (endpoint_id, next_run_at, scheduled_interval_s)
         VALUES ($1, now(), 60)`,
        [id],
      );

      const adopting = repo.adopt(60);
      await waitForBlockedBackend();
      await holder.query('COMMIT');

      // Without ON CONFLICT DO NOTHING this rejects with 23505.
      await expect(adopting).resolves.toBe(0);
    } finally {
      await holder.end();
    }
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) n FROM endpoint_runtime`);
    expect(rows[0].n).toBe('1');
  });

  it('spreads first slots when jitter is on, and does not when it is off', async () => {
    for (let i = 0; i < 40; i += 1) await makeEndpoint({ intervalS: 300 });
    await repo.adopt(60);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT date_trunc('second', next_run_at)) n FROM endpoint_runtime`,
    );
    expect(Number(rows[0].n)).toBeGreaterThan(5);

    await pool.query(`DELETE FROM endpoint_runtime`);
    await repo.adopt(0);
    const { rows: none } = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT date_trunc('second', next_run_at)) n FROM endpoint_runtime`,
    );
    expect(Number(none[0].n)).toBe(1);
  });

  it('bounds a long interval\u2019s first slot by the jitter', async () => {
    await makeEndpoint({ intervalS: 3600 });
    await repo.adopt(60);
    const { rows } = await pool.query<{ ahead: number }>(
      `SELECT extract(epoch from (next_run_at - now())) ahead FROM endpoint_runtime`,
    );
    expect(Number(rows[0].ahead)).toBeLessThanOrEqual(60);
  });

  it('bounds a short interval\u2019s first slot by the interval, not the jitter', async () => {
    // This is the branch least() actually guards, and the case above cannot
    // reach: with interval 3600 and jitter 60, least() *is* 60, so the bare
    // jitter term satisfies it and dropping least() changes nothing.
    //
    // Here the interval is the smaller of the two by a factor of 360. Without
    // least(), each slot would spread over an hour; every one of 40 rows
    // landing inside 10s by chance is (10/3600)^40, which is not a number that
    // happens.
    for (let i = 0; i < 40; i += 1) await makeEndpoint({ intervalS: 10 });
    await repo.adopt(3600);
    const { rows } = await pool.query<{ worst: number }>(
      `SELECT max(extract(epoch from (next_run_at - now()))) worst FROM endpoint_runtime`,
    );
    expect(Number(rows[0].worst)).toBeLessThanOrEqual(10);
  });
});

describe('reconcile', () => {
  it('pulls a shortened interval forward', async () => {
    const id = await makeEndpoint({ intervalS: 3600, dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    await repo.release(id, WORKER_A, claimed.scheduled_at);
    await pool.query(`UPDATE endpoints SET interval_s = 30 WHERE id = $1`, [id]);

    expect(await repo.reconcile()).toBe(1);
    const row = await runtimeRow(id);
    expect((row.next_run_at.getTime() - row.scheduled_at!.getTime()) / 1000).toBe(30);
    expect(row.scheduled_interval_s).toBe(30);
  });

  it('pushes a lengthened interval back', async () => {
    const id = await makeEndpoint({ intervalS: 30, dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    await repo.release(id, WORKER_A, claimed.scheduled_at);
    await pool.query(`UPDATE endpoints SET interval_s = 3600 WHERE id = $1`, [id]);

    expect(await repo.reconcile()).toBe(1);
    const row = await runtimeRow(id);
    expect((row.next_run_at.getTime() - row.scheduled_at!.getTime()) / 1000).toBe(3600);
  });

  it('leaves an overdue, caught-up row alone', async () => {
    // The defect the provenance predicate exists for. After a catch-up,
    // scheduled_at is the old slot and next_run_at has jumped misses+1
    // intervals, so the slot arithmetic legitimately disagrees -- keying on it
    // would rewind this row into the past and replay its backlog one probe
    // per tick, recreating the burst the guard prevents.
    const id = await makeEndpoint({ intervalS: 60, dueInS: -60 * 40 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    await repo.release(id, WORKER_A, claimed.scheduled_at);
    const before = await runtimeRow(id);

    expect(await repo.reconcile()).toBe(0);
    expect((await runtimeRow(id)).next_run_at).toEqual(before.next_run_at);
  });

  it('never touches a row whose probe is in flight', async () => {
    const id = await makeEndpoint({ intervalS: 60, dueInS: -1 });
    await repo.claim(WORKER_A, LEASE_MS, 10);
    await pool.query(`UPDATE endpoints SET interval_s = 30 WHERE id = $1`, [id]);
    expect(await repo.reconcile()).toBe(0);
  });

  it('never touches a row that has not been claimed yet', async () => {
    const id = await makeEndpoint({ intervalS: 30 });
    await repo.adopt(60);
    await pool.query(`UPDATE endpoints SET interval_s = 3600 WHERE id = $1`, [id]);
    // scheduled_at is NULL: the expression would be NULL and violate NOT NULL,
    // and the adoption jitter is already independent of the interval.
    expect(await repo.reconcile()).toBe(0);
  });

  it('is a no-op once the row agrees with its endpoint', async () => {
    const id = await makeEndpoint({ intervalS: 60, dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    await repo.release(id, WORKER_A, claimed.scheduled_at);
    await pool.query(`UPDATE endpoints SET interval_s = 30 WHERE id = $1`, [id]);
    expect(await repo.reconcile()).toBe(1);
    expect(await repo.reconcile()).toBe(0);
  });
});

describe('claim_log', () => {
  it('records the slot inside the claim, before any probe could run', async () => {
    const id = await makeEndpoint({ dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    const { rows } = await pool.query<{
      endpoint_id: string;
      worker_id: string;
      scheduled_at: Date;
    }>(`SELECT endpoint_id, worker_id, scheduled_at FROM claim_log`);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_id).toBe(id);
    expect(rows[0].worker_id).toBe(WORKER_A);
    expect(new Date(rows[0].scheduled_at).toISOString()).toBe(
      new Date(claimed.scheduled_at).toISOString(),
    );
  });

  it('answers the exit test’s NFR-3 question', async () => {
    for (let i = 0; i < 5; i += 1) await makeEndpoint({ dueInS: -10 - i });
    await repo.claim(WORKER_A, LEASE_MS, 3);
    await repo.claim(WORKER_B, LEASE_MS, 3);
    const { rows } = await pool.query(
      `SELECT endpoint_id, scheduled_at FROM claim_log
       GROUP BY 1, 2 HAVING count(*) > 1`,
    );
    expect(rows).toEqual([]);
  });

  it('would show a duplicate if one ever happened', async () => {
    // The check has to be able to fail, or it proves nothing. Two rows for one
    // slot is exactly what a regression advancing next_run_at on release
    // rather than on claim would produce.
    const id = await makeEndpoint({ dueInS: -1 });
    const [claimed] = await repo.claim(WORKER_A, LEASE_MS, 10);
    await pool.query(
      `INSERT INTO claim_log (endpoint_id, scheduled_at, worker_id) VALUES ($1, $2, $3)`,
      [id, claimed.scheduled_at, WORKER_B],
    );
    const { rows } = await pool.query(
      `SELECT endpoint_id FROM claim_log GROUP BY endpoint_id, scheduled_at HAVING count(*) > 1`,
    );
    expect(rows).toHaveLength(1);
  });
});
