import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { movedForward, withProcessClockBehind } from '../../../testing/skewed-clock.js';
import { ServiceRepository } from './service.repository.js';
import { EndpointRepository } from './endpoint.repository.js';
import { TagRepository } from './tag.repository.js';

let ctx: TestDb;
let services: ServiceRepository;
let endpoints: EndpointRepository;
let tags: TagRepository;
let users: UserRepository;
let userId: string;
let otherUserId: string;
let serviceId: string;

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  services = new ServiceRepository(db);
  endpoints = new EndpointRepository(db);
  tags = new TagRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  const user = await users.create('alice@example.com', '$argon2id$hash');
  const other = await users.create('bob@example.com', '$argon2id$hash');
  userId = user!.id;
  otherUserId = other!.id;
  const service = await services.create({
    user_id: userId,
    name: 'API',
    base_url: 'https://api.example.com',
  });
  serviceId = service.id;
});

describe('create and findById', () => {
  it('creates an endpoint and reads it back, denormalized user_id included', async () => {
    const created = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    expect(created.user_id).toBe(userId);

    const found = await endpoints.findById(created.id, userId);
    expect(found?.path).toBe('/orders');
    expect(found?.enabled).toBe(true);
  });

  it("returns undefined for another user's endpoint", async () => {
    const created = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await expect(endpoints.findById(created.id, otherUserId)).resolves.toBeUndefined();
  });
});

describe('the config-owned columns have no database default', () => {
  it.each(['interval_s', 'timeout_ms', 'max_redirects'] as const)(
    'rejects an insert omitting %s -- restoring a hard-coded DEFAULT would silently let this through',
    async (omit) => {
      const full = { interval_s: 60, timeout_ms: 10000, max_redirects: 5 };
      const { [omit]: _omitted, ...rest } = full;
      const values = { service_id: serviceId, user_id: userId, ...rest };
      const db = ctx.db;
      // Bypasses Kysely's own type check on purpose: it already refuses this
      // object at compile time now that these columns are required, which is
      // itself evidence the fix holds. The cast reaches the same shape a raw
      // insert (or a caller working around the type) would produce, to prove
      // the database -- not just the type checker -- refuses it too.
      await expect(
        db
          .insertInto('endpoints')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .values(values as any)
          .execute(),
      ).rejects.toThrow();
    },
  );
});

describe('the (service_id, method, path) unique index', () => {
  it('rejects a duplicate method+path under the same service', async () => {
    await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await expect(
      endpoints.create({
        service_id: serviceId,
        user_id: userId,
        interval_s: 60,
        timeout_ms: 10000,
        max_redirects: 5,
        method: 'GET',
        path: '/orders',
      }),
    ).rejects.toThrow();
  });

  it('allows the same path under a different method', async () => {
    await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await expect(
      endpoints.create({
        service_id: serviceId,
        user_id: userId,
        interval_s: 60,
        timeout_ms: 10000,
        max_redirects: 5,
        method: 'POST',
        path: '/orders',
      }),
    ).resolves.toBeDefined();
  });
});

describe('the patch type excludes ownership columns', () => {
  it('user_id and service_id are not valid EndpointUpdate fields, so a caller cannot reassign ownership through update()', async () => {
    // Compile-time proof: EndpointUpdate is Omit<..., 'user_id' | 'service_id'>.
    // The call itself is a harmless no-op (no row with this id exists).
    await endpoints.update(
      '00000000-0000-0000-0000-000000000000',
      userId,
      // @ts-expect-error -- user_id/service_id are not valid EndpointUpdate fields
      { user_id: otherUserId, service_id: serviceId },
    );
  });
});

describe('updated_at', () => {
  it('is stamped from the database clock, the one the insert used (#71)', async () => {
    const created = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await withProcessClockBehind(() => endpoints.setEnabled(created.id, userId, false));

    expect(await movedForward(ctx.pool, 'endpoints', created.id)).toBe(true);
  });
});

describe('pause and resume', () => {
  it('setEnabled(false) pauses, and does not touch another user’s endpoint', async () => {
    const created = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await expect(endpoints.setEnabled(created.id, otherUserId, false)).resolves.toBeUndefined();
    await expect(endpoints.findById(created.id, userId).then((e) => e?.enabled)).resolves.toBe(
      true,
    );

    await endpoints.setEnabled(created.id, userId, false);
    await expect(endpoints.findById(created.id, userId).then((e) => e?.enabled)).resolves.toBe(
      false,
    );
  });
});

describe('delete', () => {
  it('does not delete another user’s endpoint, and reports false', async () => {
    const created = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await expect(endpoints.delete(created.id, otherUserId)).resolves.toBe(false);
    await expect(endpoints.findById(created.id, userId)).resolves.toMatchObject({
      id: created.id,
    });

    await expect(endpoints.delete(created.id, userId)).resolves.toBe(true);
    await expect(endpoints.findById(created.id, userId)).resolves.toBeUndefined();
  });
});

describe('listForService excludes another user’s endpoints', () => {
  it('does not return an endpoint belonging to another user, even under the same-looking service id', async () => {
    await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/mine',
    });

    // Another user's own service and endpoint -- a different service_id, so
    // this alone would not prove the user_id predicate does anything; the
    // real proof is calling listForService with *this* user's serviceId but
    // *the other user's* id and getting nothing back.
    const otherService = await services.create({
      user_id: otherUserId,
      name: 'Other API',
      base_url: 'https://other.example.com',
    });
    await endpoints.create({
      service_id: otherService.id,
      user_id: otherUserId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/theirs',
    });

    await expect(endpoints.listForService(serviceId, otherUserId, { limit: 50 })).resolves.toEqual(
      [],
    );
    const mine = await endpoints.listForService(serviceId, userId, { limit: 50 });
    expect(mine.map((e) => e.path)).toEqual(['/mine']);
  });
});

describe('listForService is paginated', () => {
  it('limits the page and advances by cursor', async () => {
    for (const path of ['/a', '/b', '/c']) {
      await endpoints.create({
        service_id: serviceId,
        user_id: userId,
        interval_s: 60,
        timeout_ms: 10000,
        max_redirects: 5,
        method: 'GET',
        path,
      });
    }

    const first = await endpoints.listForService(serviceId, userId, { limit: 2 });
    expect(first).toHaveLength(2);

    const second = await endpoints.listForService(serviceId, userId, {
      limit: 2,
      cursor: first[1].id,
    });
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(first[0].id);
    expect(second[0].id).not.toBe(first[1].id);
  });
});

describe('list excludes another user’s endpoints', () => {
  it('only returns endpoints owned by the requesting user', async () => {
    await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/mine',
    });
    const otherService = await services.create({
      user_id: otherUserId,
      name: 'Other API',
      base_url: 'https://other.example.com',
    });
    await endpoints.create({
      service_id: otherService.id,
      user_id: otherUserId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/theirs',
    });

    const mine = await endpoints.list(userId, { limit: 10 });
    expect(mine.map((e) => e.path)).toEqual(['/mine']);

    const theirs = await endpoints.list(otherUserId, { limit: 10 });
    expect(theirs.map((e) => e.path)).toEqual(['/theirs']);
  });
});

describe('the tag filter (B-5)', () => {
  it('listForService: matches only this user’s endpoints carrying the key:value tag', async () => {
    const matching = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/mine',
    });
    await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/untagged',
    });
    const otherService = await services.create({
      user_id: otherUserId,
      name: 'Other API',
      base_url: 'https://other.example.com',
    });
    const otherMatching = await endpoints.create({
      service_id: otherService.id,
      user_id: otherUserId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/theirs',
    });
    await tags.replaceForEndpoint(matching.id, userId, [{ key: 'critical', value: 'true' }]);
    await tags.replaceForEndpoint(otherMatching.id, otherUserId, [
      { key: 'critical', value: 'true' },
    ]);

    const found = await endpoints.listForService(serviceId, userId, {
      limit: 50,
      tag: { key: 'critical', value: 'true' },
    });
    expect(found.map((e) => e.id)).toEqual([matching.id]);
  });

  it('list: matches only this user’s endpoints carrying the key:value tag', async () => {
    const matching = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/mine',
    });
    await tags.replaceForEndpoint(matching.id, userId, [{ key: 'critical', value: 'true' }]);

    const wrongValue = await endpoints.list(userId, {
      limit: 50,
      tag: { key: 'critical', value: 'false' },
    });
    expect(wrongValue).toEqual([]);

    const found = await endpoints.list(userId, {
      limit: 50,
      tag: { key: 'critical', value: 'true' },
    });
    expect(found.map((e) => e.id)).toEqual([matching.id]);
  });

  it('combines the tag filter with cursor pagination', async () => {
    const matches: string[] = [];
    for (const path of ['/a', '/b', '/c']) {
      const e = await endpoints.create({
        service_id: serviceId,
        user_id: userId,
        interval_s: 60,
        timeout_ms: 10000,
        max_redirects: 5,
        method: 'GET',
        path,
      });
      await tags.replaceForEndpoint(e.id, userId, [{ key: 'env', value: 'prod' }]);
      matches.push(e.id);
    }

    const page1 = await endpoints.list(userId, { limit: 2, tag: { key: 'env', value: 'prod' } });
    expect(page1).toHaveLength(2);

    const page2 = await endpoints.list(userId, {
      limit: 2,
      cursor: page1[1].id,
      tag: { key: 'env', value: 'prod' },
    });
    expect(page2).toHaveLength(1);
    expect(new Set([...page1, ...page2].map((e) => e.id))).toEqual(new Set(matches));
  });

  it('still returns a page when the match set is larger than Postgres can bind as one IN list', async () => {
    // Behavioral, not just structural: endpoint.repository.test.ts's
    // compiled-query check proves the query never binds one parameter per
    // matching row, but it cannot prove the query actually succeeds
    // against real Postgres, or that .list() still calls that query
    // builder at all -- only this, run for real, closes that gap.
    //
    // autovacuum is disabled for these two tables for the duration of this
    // test, not left to race: production sees exactly this "just
    // bulk-inserted, not yet autoanalyzed" window on every write, and a
    // plan that only holds once ANALYZE has run is not a fix for it (see
    // docs/m2-verification.md). Disabling autovacuum here makes that
    // worst case the *only* case, deterministically, instead of an
    // intermittent race the test wins or loses depending on runner speed --
    // which is what made this test's ServiceRepository twin hang for 80s+
    // on CI before the LATERAL join + composite index fix
    // (m2-verification.md defect #12). With the fix, the plan does not
    // depend on statistics at all, so this passes well inside the default
    // 20s timeout regardless.
    //
    // ANALYZE on the still-empty tables, not just autovacuum off: `TRUNCATE`
    // resets `pg_class.reltuples`/`relpages` but does not clear
    // `pg_statistic` -- a database that has ever analyzed these tables
    // before (a reused container, or an earlier test run in the same
    // container) keeps old-but-present column statistics across
    // `truncateAll`, which can be accurate enough to dodge the bad plan and
    // let this test pass even with the production fix reverted. Explicitly
    // analyzing the empty table overwrites that with a definitive
    // "zero rows, no histogram" snapshot regardless of history, matching
    // Codex review on PR #38.
    await ctx.pool.query(`ALTER TABLE endpoints SET (autovacuum_enabled = false)`);
    await ctx.pool.query(`ALTER TABLE tags SET (autovacuum_enabled = false)`);
    await ctx.pool.query(`ANALYZE endpoints`);
    await ctx.pool.query(`ANALYZE tags`);
    try {
      const rowCount = 70_000;
      await ctx.pool.query(
        `INSERT INTO endpoints
             (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
           SELECT $1, $2, 'GET', '/bulk-' || gs, 60, 10000, 5
           FROM generate_series(1, $3) AS gs`,
        [serviceId, userId, rowCount],
      );
      await ctx.pool.query(
        `INSERT INTO tags (endpoint_id, key, value)
           SELECT id, 'load', 'test' FROM endpoints
           WHERE service_id = $1 AND path LIKE '/bulk-%'`,
        [serviceId],
      );

      const page = await endpoints.list(userId, {
        limit: 10,
        tag: { key: 'load', value: 'test' },
      });
      expect(page).toHaveLength(10);

      // MAX_LIST_LIMIT permits up to 1,000, not just this suite's usual 10:
      // at 10, the LATERAL's per-iteration tag lookup runs few enough times
      // that a wrong per-iteration index choice stayed cheap by accident.
      // At 1,000 it doesn't -- tags_key_value_idx let the planner rescan
      // this tag's ~35,000 non-matching-endpoint rows on every one of the
      // outer loop's iterations instead of using the unique (owner, key)
      // index, reproducing the same class of hang this test already guards
      // at a limit production actually allows. Fixed by dropping that index
      // (migration 0006_drop_tags_key_value_idx); docs/m2-verification.md,
      // defect #12.
      const largePage = await endpoints.list(userId, {
        limit: 1000,
        tag: { key: 'load', value: 'test' },
      });
      expect(largePage).toHaveLength(1000);
    } finally {
      await ctx.pool.query(`ALTER TABLE endpoints RESET (autovacuum_enabled)`);
      await ctx.pool.query(`ALTER TABLE tags RESET (autovacuum_enabled)`);
    }
  });
});

describe('countForUser', () => {
  it('counts only endpoints belonging to this user, across services', async () => {
    const service2 = await services.create({
      user_id: userId,
      name: 'API 2',
      base_url: 'https://api2.example.com',
    });
    const otherService = await services.create({
      user_id: otherUserId,
      name: 'Other API',
      base_url: 'https://other.example.com',
    });
    await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/a',
    });
    await endpoints.create({
      service_id: service2.id,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/b',
    });
    await endpoints.create({
      service_id: otherService.id,
      user_id: otherUserId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/c',
    });

    await expect(endpoints.countForUser(userId)).resolves.toBe(2);
    await expect(endpoints.countForUser(otherUserId)).resolves.toBe(1);
  });
});

describe('the endpoints_service_owner_fkey composite constraint', () => {
  it("rejects an endpoint whose user_id disagrees with its service's owner", async () => {
    await expect(
      endpoints.create({
        service_id: serviceId,
        user_id: otherUserId,
        interval_s: 60,
        timeout_ms: 10000,
        max_redirects: 5,
        method: 'GET',
        path: '/z',
      }),
    ).rejects.toThrow();
  });
});

describe('cascade delete via service', () => {
  it('deleting a service deletes its endpoints', async () => {
    const created = await endpoints.create({
      service_id: serviceId,
      user_id: userId,
      interval_s: 60,
      timeout_ms: 10000,
      max_redirects: 5,
      method: 'GET',
      path: '/orders',
    });

    await services.delete(serviceId, userId);

    await expect(endpoints.findById(created.id, userId)).resolves.toBeUndefined();
  });
});
