import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { ServiceRepository } from './service.repository.js';

let ctx: TestDb;
let services: ServiceRepository;
let users: UserRepository;
let userId: string;
let otherUserId: string;

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  services = new ServiceRepository(db);
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
