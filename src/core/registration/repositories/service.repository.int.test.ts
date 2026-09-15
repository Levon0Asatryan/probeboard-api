import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { ServiceRepository } from './service.repository.js';
import { TagRepository } from './tag.repository.js';

let ctx: TestDb;
let services: ServiceRepository;
let tags: TagRepository;
let users: UserRepository;
let userId: string;
let otherUserId: string;

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  services = new ServiceRepository(db);
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
});

describe('create and findById', () => {
  it('creates a service and reads it back', async () => {
    const created = await services.create({
      user_id: userId,
      name: 'Payments API',
      base_url: 'https://api.example.com',
    });

    const found = await services.findById(created.id, userId);
    expect(found?.name).toBe('Payments API');
    expect(found?.base_url).toBe('https://api.example.com');
  });

  it("returns undefined for another user's service -- the 404-not-403 guard", async () => {
    const created = await services.create({
      user_id: userId,
      name: 'Payments API',
      base_url: 'https://api.example.com',
    });

    await expect(services.findById(created.id, otherUserId)).resolves.toBeUndefined();
  });
});

describe('findByBaseUrl', () => {
  it('finds an existing service at this origin for this user, per B-3', async () => {
    await services.create({ user_id: userId, name: 'API', base_url: 'https://api.example.com' });

    const found = await services.findByBaseUrl(userId, 'https://api.example.com');
    expect(found?.name).toBe('API');
  });

  it('does not find another user’s service at the same origin', async () => {
    await services.create({ user_id: userId, name: 'API', base_url: 'https://api.example.com' });

    await expect(
      services.findByBaseUrl(otherUserId, 'https://api.example.com'),
    ).resolves.toBeUndefined();
  });
});

describe('the (user_id, base_url) unique index', () => {
  it('rejects a second service at the same origin for the same user', async () => {
    await services.create({ user_id: userId, name: 'API', base_url: 'https://api.example.com' });

    await expect(
      services.create({ user_id: userId, name: 'API again', base_url: 'https://api.example.com' }),
    ).rejects.toThrow();
  });

  it('allows two different users to register the same origin', async () => {
    await services.create({ user_id: userId, name: 'API', base_url: 'https://api.example.com' });

    await expect(
      services.create({
        user_id: otherUserId,
        name: 'API',
        base_url: 'https://api.example.com',
      }),
    ).resolves.toBeDefined();
  });
});

describe('list', () => {
  it('only lists this user’s services, paginated by cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await services.create({
        user_id: userId,
        name: `S${i}`,
        base_url: `https://s${i}.example.com`,
      });
    }
    await services.create({
      user_id: otherUserId,
      name: 'Other',
      base_url: 'https://other.example.com',
    });

    const page1 = await services.list(userId, { limit: 2 });
    expect(page1).toHaveLength(2);

    const page2 = await services.list(userId, { limit: 2, cursor: page1[1].id });
    expect(page2).toHaveLength(1);
    expect(page2[0].id).not.toBe(page1[0].id);
    expect(page2[0].id).not.toBe(page1[1].id);
  });

  it('filters to only this user’s services carrying the key:value tag (B-5)', async () => {
    const matching = await services.create({
      user_id: userId,
      name: 'API',
      base_url: 'https://api.example.com',
    });
    await services.create({
      user_id: userId,
      name: 'Other',
      base_url: 'https://other.example.com',
    });
    const otherUsersMatching = await services.create({
      user_id: otherUserId,
      name: 'Other user API',
      base_url: 'https://other-user.example.com',
    });
    await tags.replaceForService(matching.id, userId, [{ key: 'env', value: 'prod' }]);
    await tags.replaceForService(otherUsersMatching.id, otherUserId, [
      { key: 'env', value: 'prod' },
    ]);

    const found = await services.list(userId, { limit: 50, tag: { key: 'env', value: 'prod' } });
    expect(found.map((s) => s.id)).toEqual([matching.id]);
  });

  it('does not match a different value for the same key', async () => {
    const service = await services.create({
      user_id: userId,
      name: 'API',
      base_url: 'https://api.example.com',
    });
    await tags.replaceForService(service.id, userId, [{ key: 'env', value: 'prod' }]);

    const found = await services.list(userId, {
      limit: 50,
      tag: { key: 'env', value: 'staging' },
    });
    expect(found).toEqual([]);
  });

  it('combines the tag filter with cursor pagination', async () => {
    const matches: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await services.create({
        user_id: userId,
        name: `S${i}`,
        base_url: `https://s${i}.example.com`,
      });
      await tags.replaceForService(s.id, userId, [{ key: 'env', value: 'prod' }]);
      matches.push(s.id);
    }

    const page1 = await services.list(userId, {
      limit: 2,
      tag: { key: 'env', value: 'prod' },
    });
    expect(page1).toHaveLength(2);

    const page2 = await services.list(userId, {
      limit: 2,
      cursor: page1[1].id,
      tag: { key: 'env', value: 'prod' },
    });
    expect(page2).toHaveLength(1);
    expect(new Set([...page1, ...page2].map((s) => s.id))).toEqual(new Set(matches));
  });

  it('still returns a page when the match set is larger than Postgres can bind as one IN list', async () => {
    // Behavioral, not just structural: service.repository.test.ts's
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
    // which is what made this test hang for 80s+ on CI before the LATERAL
    // join + composite index fix (m2-verification.md defect #12). With the
    // fix, the plan does not depend on statistics at all, so this passes
    // well inside the default 20s timeout regardless.
    await ctx.pool.query(`ALTER TABLE services SET (autovacuum_enabled = false)`);
    await ctx.pool.query(`ALTER TABLE tags SET (autovacuum_enabled = false)`);
    try {
      const rowCount = 70_000;
      await ctx.pool.query(
        `INSERT INTO services (user_id, name, base_url)
           SELECT $1, 'bulk ' || gs, 'https://bulk-' || gs || '.example.com'
           FROM generate_series(1, $2) AS gs`,
        [userId, rowCount],
      );
      await ctx.pool.query(
        `INSERT INTO tags (service_id, key, value)
           SELECT id, 'load', 'test' FROM services
           WHERE user_id = $1 AND name LIKE 'bulk %'`,
        [userId],
      );

      const page = await services.list(userId, {
        limit: 10,
        tag: { key: 'load', value: 'test' },
      });
      expect(page).toHaveLength(10);

      // MAX_LIST_LIMIT permits up to 1,000, not just this suite's usual 10:
      // at 10, the LATERAL's per-iteration tag lookup runs few enough times
      // that a wrong per-iteration index choice stayed cheap by accident.
      // At 1,000 it doesn't -- tags_key_value_idx let the planner rescan
      // this tag's ~35,000 non-matching-service rows on every one of the
      // outer loop's iterations instead of using the unique (owner, key)
      // index, reproducing the same class of hang this test already guards
      // (81s locally, 24.9M buffer hits) at a limit production actually
      // allows. Fixed by dropping that index (migration
      // 0006_drop_tags_key_value_idx); docs/m2-verification.md, defect #12.
      const largePage = await services.list(userId, {
        limit: 1000,
        tag: { key: 'load', value: 'test' },
      });
      expect(largePage).toHaveLength(1000);
    } finally {
      await ctx.pool.query(`ALTER TABLE services RESET (autovacuum_enabled)`);
      await ctx.pool.query(`ALTER TABLE tags RESET (autovacuum_enabled)`);
    }
  });
});

describe('update', () => {
  it("does not update another user's service", async () => {
    const created = await services.create({
      user_id: userId,
      name: 'API',
      base_url: 'https://api.example.com',
    });

    const result = await services.update(created.id, otherUserId, { name: 'Hijacked' });
    expect(result).toBeUndefined();

    const still = await services.findById(created.id, userId);
    expect(still?.name).toBe('API');
  });

  it('the patch type excludes user_id, so a caller cannot reassign ownership through it', async () => {
    // Compile-time proof: ServiceUpdate is Omit<..., 'user_id'>, so this
    // would only type-check if the exclusion were ever removed. The call
    // itself is a harmless no-op (no row with id 'no-such-id' exists).
    await services.update(
      '00000000-0000-0000-0000-000000000000',
      userId,
      // @ts-expect-error -- user_id is not a valid ServiceUpdate field
      { user_id: otherUserId },
    );
  });
});

describe('delete', () => {
  it("does not delete another user's service, and reports it", async () => {
    const created = await services.create({
      user_id: userId,
      name: 'API',
      base_url: 'https://api.example.com',
    });

    await expect(services.delete(created.id, otherUserId)).resolves.toBe(false);
    await expect(services.findById(created.id, userId)).resolves.toBeDefined();
  });

  it('deletes the owner’s own service', async () => {
    const created = await services.create({
      user_id: userId,
      name: 'API',
      base_url: 'https://api.example.com',
    });

    await expect(services.delete(created.id, userId)).resolves.toBe(true);
    await expect(services.findById(created.id, userId)).resolves.toBeUndefined();
  });
});
