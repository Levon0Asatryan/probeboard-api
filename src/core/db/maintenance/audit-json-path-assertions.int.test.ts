import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { EndpointAssertion } from '../types.js';
import type { DbService } from '../db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { ServiceRepository } from '../../registration/repositories/service.repository.js';
import { EndpointRepository } from '../../registration/repositories/endpoint.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { auditJsonPathAssertions, type RemovedAssertion } from './audit-json-path-assertions.js';

/**
 * Against a real PostgreSQL, because the behaviour under test is the row
 * lock: a mock would only assert that we called the mock.
 *
 * Every fixture writes its assertions straight through Kysely rather than
 * through the DTO -- an unsupported path is exactly what the DTO now
 * rejects, so the only way to produce the legacy row this script exists for
 * is to bypass it, which is also how the real rows got there.
 */

let ctx: TestDb;
let users: UserRepository;
let services: ServiceRepository;
let endpoints: EndpointRepository;
let endpointId: string;
let serviceId: string;
let userId: string;

const UNSUPPORTED: EndpointAssertion = { type: 'json_path', path: '$.items[*].id', equals: 1 };
const SUPPORTED: EndpointAssertion = { type: 'json_path', path: '$.data.status', equals: 'ok' };
const BODY: EndpointAssertion = { type: 'body_contains', value: 'ok' };

async function setAssertions(id: string, assertions: EndpointAssertion[]): Promise<void> {
  await ctx.db
    .updateTable('endpoints')
    .set({ assertions: JSON.stringify(assertions) })
    .where('id', '=', id)
    .execute();
}

async function readAssertions(id: string): Promise<EndpointAssertion[]> {
  const row = await ctx.db
    .selectFrom('endpoints')
    .select('assertions')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.assertions;
}

/**
 * The records the audit emits. It returns only a count (D61), so a test that
 * cares what was removed collects it here, exactly as the CLI does.
 */
function collector(): {
  records: RemovedAssertion[];
  onRemoved: (entry: RemovedAssertion) => Promise<void>;
} {
  const records: RemovedAssertion[] = [];
  return {
    records,
    onRemoved: (entry) => {
      records.push(entry);
      return Promise.resolve();
    },
  };
}

/**
 * Resolves once some statement is genuinely parked waiting for a lock on
 * `endpoints`, polling `pg_locks` on a connection of its own.
 *
 * A fixed sleep cannot stand in for this. On a loaded runner the competing
 * UPDATE may not have reached PostgreSQL before the sleep elapses, and the
 * test then passes having exercised nothing -- so with the FOR UPDATE
 * removed it would still pass, which CLAUDE.md rules out as evidence.
 * `granted = false` is the state the proof actually depends on, so the test
 * waits for that state and fails loudly if it never arrives.
 */
async function waitForBlockedWriter(db: TestDb['db'], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `pg_stat_activity`, not a join from `pg_locks` to `pg_class`: a
    // statement waiting for a *row* lock does not wait on the relation. It
    // blocks on the holding transaction's `transactionid` lock, whose
    // `pg_locks.relation` is NULL, so joining to `pg_class` drops precisely
    // the waiter this barrier is looking for. `wait_event_type = 'Lock'` on
    // a backend other than this one, running a statement against
    // `endpoints`, states the condition directly.
    const result = await sql<{ waiting: number }>`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND state = 'active'
        AND query ILIKE '%endpoints%'
    `.execute(db);
    const [row] = result.rows;
    if (row.waiting > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        'no statement ever blocked on an endpoints lock: the audit is not holding one',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function seedEndpoint(path: string, assertions: EndpointAssertion[]): Promise<string> {
  const created = await endpoints.create({
    service_id: serviceId,
    user_id: userId,
    interval_s: 60,
    timeout_ms: 10000,
    max_redirects: 5,
    method: 'GET',
    path,
  });
  await setAssertions(created.id, assertions);
  return created.id;
}

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  services = new ServiceRepository(db);
  endpoints = new EndpointRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  const user = await users.create('alice@example.com', '$argon2id$hash');
  const service = await services.create({
    user_id: user!.id,
    name: 'API',
    base_url: 'https://api.example.com',
  });
  const endpoint = await endpoints.create({
    service_id: service.id,
    user_id: user!.id,
    interval_s: 60,
    timeout_ms: 10000,
    max_redirects: 5,
    method: 'GET',
    path: '/orders',
  });
  endpointId = endpoint.id;
  serviceId = service.id;
  userId = user!.id;
});

describe('auditJsonPathAssertions', () => {
  it('removes an unsupported json_path and keeps every other assertion', async () => {
    await setAssertions(endpointId, [UNSUPPORTED, SUPPORTED, BODY]);
    const sink = collector();

    const removed = await auditJsonPathAssertions(ctx.db, sink);

    expect(await readAssertions(endpointId)).toEqual([SUPPORTED, BODY]);
    expect(removed).toBe(1);
    expect(sink.records).toEqual([{ endpointId, removed: UNSUPPORTED }]);
  });

  it('leaves an endpoint whose assertions are all supported completely alone', async () => {
    await setAssertions(endpointId, [SUPPORTED, BODY]);
    const before = await ctx.db
      .selectFrom('endpoints')
      .select('updated_at')
      .where('id', '=', endpointId)
      .executeTakeFirstOrThrow();

    const removed = await auditJsonPathAssertions(ctx.db);

    expect(removed).toBe(0);
    expect(await readAssertions(endpointId)).toEqual([SUPPORTED, BODY]);
    const after = await ctx.db
      .selectFrom('endpoints')
      .select('updated_at')
      .where('id', '=', endpointId)
      .executeTakeFirstOrThrow();
    // Not rewritten at all, so not even the timestamp moves.
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it('is idempotent: a second run finds nothing left to remove', async () => {
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);

    await auditJsonPathAssertions(ctx.db);
    const second = await auditJsonPathAssertions(ctx.db);

    expect(second).toBe(0);
    expect(await readAssertions(endpointId)).toEqual([BODY]);
  });

  it('touches only the endpoints that need it', async () => {
    const cleanId = await seedEndpoint('/clean', [SUPPORTED]);
    await setAssertions(endpointId, [UNSUPPORTED]);
    const sink = collector();

    await auditJsonPathAssertions(ctx.db, sink);

    expect(sink.records.map((r) => r.endpointId)).toEqual([endpointId]);
    expect(await readAssertions(cleanId)).toEqual([SUPPORTED]);
  });

  it('does not lose an assertion edit committed while the audit holds the row', async () => {
    // The barrier this exists for: the audit is a read-modify-write on a
    // live table while the API keeps serving. Without the FOR UPDATE and the
    // re-read inside it, the competing PATCH below commits between the
    // audit's read and its write, and the audit's stale filtered copy
    // silently overwrites it (docs/m3-plan.md D54).
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);

    const other = connectTestDb();
    const watcher = connectTestDb();
    const competingValue: EndpointAssertion[] = [
      { type: 'body_contains', value: 'added-concurrently' },
    ];
    let competing: Promise<unknown> | undefined;

    try {
      await auditJsonPathAssertions(ctx.db, {
        onRowLocked: async () => {
          // Started, deliberately not awaited: while the audit holds the
          // lock this statement blocks until the audit commits, so awaiting
          // it here would deadlock the test rather than prove anything.
          competing = other.db
            .updateTable('endpoints')
            .set({ assertions: JSON.stringify(competingValue), updated_at: new Date() })
            .where('id', '=', endpointId)
            .execute();
          // Proceed only once that UPDATE is observably parked on this row's
          // lock -- not after an interval that merely tends to be long
          // enough (docs/m3-plan.md D62). With the FOR UPDATE removed it
          // never parks, so this throws and the proof fails every time
          // rather than occasionally.
          await waitForBlockedWriter(watcher.db);
        },
      });
      await competing;

      // The competing edit applied after the audit committed, so it is the
      // final state. With the lock removed the audit's stale copy wins here
      // instead, and this assertion is what catches it.
      expect(await readAssertions(endpointId)).toEqual(competingValue);
    } finally {
      await competing?.catch(() => undefined);
      await watcher.close();
      await other.close();
    }
  });

  it('keeps the assertion when its recovery record cannot be written', async () => {
    // The record is the only trace of a deleted assertion, so it has to be
    // durable before the deletion is. The sink runs inside the removal's own
    // transaction: a rejection -- a broken pipe, a full buffer -- must roll
    // the rewrite back rather than leave the assertion gone and unrecorded
    // (docs/m3-plan.md D60).
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);

    await expect(
      auditJsonPathAssertions(ctx.db, {
        onRemoved: () => Promise.reject(new Error('EPIPE: broken pipe')),
      }),
    ).rejects.toThrow('EPIPE');

    expect(await readAssertions(endpointId)).toEqual([UNSUPPORTED, BODY]);
  });

  it('repairs rows that fall beyond the first scan page', async () => {
    // The scan is paged, so the rows it has not read yet must still be
    // repaired. A single unbounded read would pass this trivially; a scan
    // that reads only its first page silently leaves every later endpoint
    // reporting permanent false downtime, which is D48's whole problem
    // reintroduced on large databases.
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);
    for (const n of [1, 2, 3, 4]) {
      await seedEndpoint(`/paged-${String(n)}`, [UNSUPPORTED, BODY]);
    }

    // Five endpoints, two per page: three pages, the last one short.
    const removed = await auditJsonPathAssertions(ctx.db, { scanPageSize: 2 });

    expect(removed).toBe(5);
    const repaired = await ctx.db.selectFrom('endpoints').select(['id', 'assertions']).execute();
    expect(repaired).toHaveLength(5);
    for (const row of repaired) expect(row.assertions).toEqual([BODY]);
  });

  it('returns only a count over many pages, never every removal it made', async () => {
    // Paging bounded the rows read at once but not the records kept: every
    // {endpointId, removed} object was retained until the run finished, so
    // the high-volume deployment paging exists for could still exhaust
    // memory. Records now leave through the sink as they are made and the
    // audit keeps only a number (docs/m3-plan.md D61).
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);
    for (const n of [1, 2, 3, 4, 5]) {
      await seedEndpoint(`/many-${String(n)}`, [UNSUPPORTED, BODY]);
    }

    const emittedByPage: number[] = [];
    const sink = collector();

    // Six endpoints, two per page: three full pages.
    const removed = await auditJsonPathAssertions(ctx.db, {
      scanPageSize: 2,
      onRemoved: async (entry) => {
        await sink.onRemoved(entry);
        emittedByPage.push(sink.records.length);
      },
    });

    // A number, not an array of six records. Restoring the accumulator makes
    // this fail: the resolved value becomes the records themselves.
    expect(typeof removed).toBe('number');
    expect(removed).toBe(6);

    // Every record reached the sink, one at a time, as its row was repaired
    // -- so nothing had to be held for the caller.
    expect(emittedByPage).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.records).toHaveLength(6);
  });

  it('has already emitted a record for every removal it committed when a run dies partway', async () => {
    // Each removal is permanent the moment its own per-row transaction
    // commits. A record emitted only once the whole scan returns therefore
    // does not exist for any row already rewritten, so a crash, a SIGTERM or
    // a failing stdout midway would leave those assertions deleted with
    // nothing to reconstruct them from -- the recovery guarantee the printed
    // record exists to provide.
    const second = await seedEndpoint('/second', [UNSUPPORTED, BODY]);
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);

    const sink = collector();
    let rowsSeen = 0;

    await expect(
      auditJsonPathAssertions(ctx.db, {
        onRemoved: sink.onRemoved,
        // Kills the run while the second row is locked, after the first has
        // already committed its removal.
        onRowLocked: async () => {
          rowsSeen += 1;
          if (rowsSeen === 2) throw new Error('interrupted');
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow('interrupted');

    // Exactly the committed removal, reported before the run died. Collecting
    // records and printing them after the scan returns yields [] here.
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].removed).toEqual(UNSUPPORTED);

    // And it names the row that really was rewritten.
    expect(await readAssertions(sink.records[0].endpointId)).toEqual([BODY]);

    // The interrupted row kept its assertions: its transaction rolled back.
    const untouched = sink.records[0].endpointId === endpointId ? second : endpointId;
    expect(await readAssertions(untouched)).toEqual([UNSUPPORTED, BODY]);
  });
});
