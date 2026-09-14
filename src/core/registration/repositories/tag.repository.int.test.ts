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
let serviceId: string;

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
  const service = await services.create({
    user_id: userId,
    name: 'API',
    base_url: 'https://api.example.com',
  });
  serviceId = service.id;
});

describe('replaceForService', () => {
  it('sets and replaces key:value tags atomically', async () => {
    await tags.replaceForService(serviceId, [{ key: 'env', value: 'prod' }]);
    await tags.replaceForService(serviceId, [
      { key: 'env', value: 'staging' },
      { key: 'team', value: 'payments' },
    ]);

    const list = await tags.listForService(serviceId);
    expect(list.map((t) => [t.key, t.value]).sort()).toEqual([
      ['env', 'staging'],
      ['team', 'payments'],
    ]);
  });

  it('rejects two rows with the same key on the same owner', async () => {
    await expect(
      tags.replaceForService(serviceId, [
        { key: 'env', value: 'prod' },
        { key: 'env', value: 'staging' },
      ]),
    ).rejects.toThrow();
  });
});

describe('filterServiceIdsByTag', () => {
  it('finds only this user’s services carrying the tag', async () => {
    const otherService = await services.create({
      user_id: otherUserId,
      name: 'Other',
      base_url: 'https://other.example.com',
    });
    await tags.replaceForService(serviceId, [{ key: 'env', value: 'prod' }]);
    await tags.replaceForService(otherService.id, [{ key: 'env', value: 'prod' }]);

    const found = await tags.filterServiceIdsByTag(userId, 'env', 'prod');
    expect(found).toEqual([serviceId]);
  });

  it('does not match a different value for the same key', async () => {
    await tags.replaceForService(serviceId, [{ key: 'env', value: 'prod' }]);

    await expect(tags.filterServiceIdsByTag(userId, 'env', 'staging')).resolves.toEqual([]);
  });
});

describe('cascade delete', () => {
  it('deleting the service deletes its tags', async () => {
    await tags.replaceForService(serviceId, [{ key: 'env', value: 'prod' }]);

    await services.delete(serviceId, userId);

    await expect(tags.listForService(serviceId)).resolves.toEqual([]);
  });
});
