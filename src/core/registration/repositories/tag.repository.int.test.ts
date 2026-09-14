import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
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
let endpointId: string;

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
  const endpoint = await endpoints.create({
    service_id: serviceId,
    user_id: userId,
    interval_s: 60,
    timeout_ms: 10000,
    max_redirects: 5,
    method: 'GET',
    path: '/orders',
  });
  endpointId = endpoint.id;
});

describe('ownership scoping -- a foreign parent id behaves as absent', () => {
  it('replaceForService returns undefined, and writes nothing, for a service owned by someone else', async () => {
    const result = await tags.replaceForService(serviceId, otherUserId, [
      { key: 'attacker', value: 'v' },
    ]);
    expect(result).toBeUndefined();
    await expect(tags.listForService(serviceId, userId)).resolves.toEqual([]);
  });

  it('replaceForEndpoint returns undefined, and writes nothing, for an endpoint owned by someone else', async () => {
    const result = await tags.replaceForEndpoint(endpointId, otherUserId, [
      { key: 'attacker', value: 'v' },
    ]);
    expect(result).toBeUndefined();
    await expect(tags.listForEndpoint(endpointId, userId)).resolves.toEqual([]);
  });

  it('listForService returns empty, not the real owner’s tags, for a foreign caller', async () => {
    await tags.replaceForService(serviceId, userId, [{ key: 'real', value: 'v' }]);
    await expect(tags.listForService(serviceId, otherUserId)).resolves.toEqual([]);
  });

  it('listForEndpoint returns empty, not the real owner’s tags, for a foreign caller', async () => {
    await tags.replaceForEndpoint(endpointId, userId, [{ key: 'real', value: 'v' }]);
    await expect(tags.listForEndpoint(endpointId, otherUserId)).resolves.toEqual([]);
  });
});

describe('the tags_one_owner CHECK', () => {
  it('rejects a row with neither owner', async () => {
    await expect(
      ctx.db.insertInto('tags').values({ key: 'env', value: 'prod' }).execute(),
    ).rejects.toThrow();
  });

  it('rejects a row with both owners -- the XOR, not just "at least one"', async () => {
    await expect(
      ctx.db
        .insertInto('tags')
        .values({ service_id: serviceId, endpoint_id: endpointId, key: 'env', value: 'prod' })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('replaceForService', () => {
  it('sets and replaces key:value tags atomically', async () => {
    await tags.replaceForService(serviceId, userId, [{ key: 'env', value: 'prod' }]);
    await tags.replaceForService(serviceId, userId, [
      { key: 'env', value: 'staging' },
      { key: 'team', value: 'payments' },
    ]);

    const list = await tags.listForService(serviceId, userId);
    expect(list.map((t) => [t.key, t.value]).sort()).toEqual([
      ['env', 'staging'],
      ['team', 'payments'],
    ]);
  });

  it('rejects two rows with the same key on the same owner', async () => {
    await expect(
      tags.replaceForService(serviceId, userId, [
        { key: 'env', value: 'prod' },
        { key: 'env', value: 'staging' },
      ]),
    ).rejects.toThrow();
  });

  it('rejects two rows with the same key on the same endpoint', async () => {
    // tags_endpoint_key_key is a separate index from tags_service_key_key --
    // this row alone proves it exists.
    await expect(
      tags.replaceForEndpoint(endpointId, userId, [
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
    await tags.replaceForService(serviceId, userId, [{ key: 'env', value: 'prod' }]);
    await tags.replaceForService(otherService.id, otherUserId, [{ key: 'env', value: 'prod' }]);

    const found = await tags.filterServiceIdsByTag(userId, 'env', 'prod');
    expect(found).toEqual([serviceId]);
  });

  it('does not match a different value for the same key', async () => {
    await tags.replaceForService(serviceId, userId, [{ key: 'env', value: 'prod' }]);

    await expect(tags.filterServiceIdsByTag(userId, 'env', 'staging')).resolves.toEqual([]);
  });
});

describe('cascade delete', () => {
  it('deleting the service deletes its tags', async () => {
    await tags.replaceForService(serviceId, userId, [{ key: 'env', value: 'prod' }]);

    await services.delete(serviceId, userId);

    await expect(tags.listForService(serviceId, userId)).resolves.toEqual([]);
  });
});

/**
 * Same technique as HeaderRepository's own version of this helper -- see its
 * comment for why FOR SHARE, and why a raw-SQL competing write rather than a
 * second Promise.all call.
 */
async function raceAgainstCompetingReplacement<T>(
  ownerTable: 'services' | 'endpoints',
  ownerId: string,
  competingWrite: (client: PoolClient) => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const client = await ctx.pool.connect();
  await client.query('BEGIN');
  await client.query(`SELECT id FROM ${ownerTable} WHERE id = $1 FOR SHARE`, [ownerId]);

  let settled = false;
  const result = run().then((r) => {
    settled = true;
    return r;
  });

  await new Promise((r) => setTimeout(r, 150));
  expect(settled).toBe(false);

  await competingWrite(client);
  await client.query('COMMIT');
  client.release();

  const awaited = await result;
  expect(settled).toBe(true);
  return awaited;
}

describe('replaceForService and replaceForEndpoint serialize against a concurrent replacement', () => {
  it('replaceForService: the final set is exactly the later call’s, never a union', async () => {
    await raceAgainstCompetingReplacement(
      'services',
      serviceId,
      async (client) => {
        await client.query('DELETE FROM tags WHERE service_id = $1', [serviceId]);
        await client.query(
          "INSERT INTO tags (service_id, key, value) VALUES ($1, 'env', 'earlier')",
          [serviceId],
        );
      },
      () => tags.replaceForService(serviceId, userId, [{ key: 'env', value: 'later' }]),
    );

    const list = await tags.listForService(serviceId, userId);
    expect(list.map((t) => [t.key, t.value])).toEqual([['env', 'later']]);
  });

  it('replaceForEndpoint: the final set is exactly the later call’s, never a union', async () => {
    await raceAgainstCompetingReplacement(
      'endpoints',
      endpointId,
      async (client) => {
        await client.query('DELETE FROM tags WHERE endpoint_id = $1', [endpointId]);
        await client.query(
          "INSERT INTO tags (endpoint_id, key, value) VALUES ($1, 'env', 'earlier')",
          [endpointId],
        );
      },
      () => tags.replaceForEndpoint(endpointId, userId, [{ key: 'env', value: 'later' }]),
    );

    const list = await tags.listForEndpoint(endpointId, userId);
    expect(list.map((t) => [t.key, t.value])).toEqual([['env', 'later']]);
  });
});
