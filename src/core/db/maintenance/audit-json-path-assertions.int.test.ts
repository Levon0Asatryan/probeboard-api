import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

    const removed = await auditJsonPathAssertions(ctx.db);

    expect(await readAssertions(endpointId)).toEqual([SUPPORTED, BODY]);
    expect(removed).toEqual([{ endpointId, removed: UNSUPPORTED }]);
  });

  it('leaves an endpoint whose assertions are all supported completely alone', async () => {
    await setAssertions(endpointId, [SUPPORTED, BODY]);
    const before = await ctx.db
      .selectFrom('endpoints')
      .select('updated_at')
      .where('id', '=', endpointId)
      .executeTakeFirstOrThrow();

    const removed = await auditJsonPathAssertions(ctx.db);

    expect(removed).toEqual([]);
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

    expect(second).toEqual([]);
    expect(await readAssertions(endpointId)).toEqual([BODY]);
  });

  it('touches only the endpoints that need it', async () => {
    const clean = await endpoints.create({
      service_id: (
        await ctx.db
          .selectFrom('endpoints')
          .select('service_id')
          .where('id', '=', endpointId)
          .executeTakeFirstOrThrow()
      ).service_id,
      user_id: (
        await ctx.db
          .selectFrom('endpoints')
          .select('user_id')
          .where('id', '=', endpointId)
          .executeTakeFirstOrThrow()
      ).user_id,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/clean',
    });
    await setAssertions(endpointId, [UNSUPPORTED]);
    await setAssertions(clean.id, [SUPPORTED]);

    const removed = await auditJsonPathAssertions(ctx.db);

    expect(removed.map((r) => r.endpointId)).toEqual([endpointId]);
    expect(await readAssertions(clean.id)).toEqual([SUPPORTED]);
  });

  it('does not lose an assertion edit committed while the audit holds the row', async () => {
    // The barrier this exists for: the audit is a read-modify-write on a
    // live table while the API keeps serving. Without the FOR UPDATE and the
    // re-read inside it, the competing PATCH below commits between the
    // audit's read and its write, and the audit's stale filtered copy
    // silently overwrites it (docs/m3-plan.md D54).
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);

    const other = connectTestDb();
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
          // Long enough for that statement to reach the lock (or, with the
          // lock removed, to commit) before the audit writes.
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
      });
      await competing;

      // The competing edit applied after the audit committed, so it is the
      // final state. With the lock removed the audit's stale copy wins here
      // instead, and this assertion is what catches it.
      expect(await readAssertions(endpointId)).toEqual(competingValue);
    } finally {
      await other.close();
    }
  });

  it('repairs rows that fall beyond the first scan page', async () => {
    // The scan is paged, so the rows it has not read yet must still be
    // repaired. A single unbounded read would pass this trivially; a scan
    // that reads only its first page silently leaves every later endpoint
    // reporting permanent false downtime, which is D48's whole problem
    // reintroduced on large databases.
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);
    for (const n of [1, 2, 3, 4]) {
      const extra = await endpoints.create({
        service_id: serviceId,
        user_id: userId,
        interval_s: 60,
        timeout_ms: 10000,
        max_redirects: 5,
        method: 'GET',
        path: `/paged-${String(n)}`,
      });
      await setAssertions(extra.id, [UNSUPPORTED, BODY]);
    }

    // Five endpoints, two per page: three pages, the last one short.
    const removed = await auditJsonPathAssertions(ctx.db, { scanPageSize: 2 });

    expect(removed).toHaveLength(5);
    const repaired = await ctx.db.selectFrom('endpoints').select(['id', 'assertions']).execute();
    expect(repaired).toHaveLength(5);
    for (const row of repaired) expect(row.assertions).toEqual([BODY]);
  });

  it('has already emitted a record for every removal it committed when a run dies partway', async () => {
    // Each removal is permanent the moment its own per-row transaction
    // commits. A record emitted only once the whole scan returns therefore
    // does not exist for any row already rewritten, so a crash, a SIGTERM or
    // a failing stdout midway would leave those assertions deleted with
    // nothing to reconstruct them from -- the recovery guarantee the printed
    // record exists to provide.
    const second = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/second',
    });
    await setAssertions(endpointId, [UNSUPPORTED, BODY]);
    await setAssertions(second.id, [UNSUPPORTED, BODY]);

    const emitted: RemovedAssertion[] = [];
    let rowsSeen = 0;

    await expect(
      auditJsonPathAssertions(ctx.db, {
        onRemoved: (entry) => emitted.push(entry),
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
    expect(emitted).toHaveLength(1);
    expect(emitted[0].removed).toEqual(UNSUPPORTED);

    // And it names the row that really was rewritten.
    expect(await readAssertions(emitted[0].endpointId)).toEqual([BODY]);

    // The interrupted row kept its assertions: its transaction rolled back.
    const untouched = emitted[0].endpointId === endpointId ? second.id : endpointId;
    expect(await readAssertions(untouched)).toEqual([UNSUPPORTED, BODY]);
  });
});
