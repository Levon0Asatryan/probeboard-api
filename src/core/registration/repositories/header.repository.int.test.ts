import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { ServiceRepository } from './service.repository.js';
import { EndpointRepository } from './endpoint.repository.js';
import { HeaderRepository } from './header.repository.js';

let ctx: TestDb;
let services: ServiceRepository;
let endpoints: EndpointRepository;
let headers: HeaderRepository;
let users: UserRepository;
let userId: string;
let serviceId: string;
let endpointId: string;

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  services = new ServiceRepository(db);
  endpoints = new EndpointRepository(db);
  headers = new HeaderRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  const user = await users.create('alice@example.com', '$argon2id$hash');
  userId = user!.id;
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
    method: 'GET',
    path: '/orders',
  });
  endpointId = endpoint.id;
});

describe('the headers_secret_shape CHECK', () => {
  it('rejects a non-secret row with no value', async () => {
    await expect(
      headers.replaceForService(serviceId, [{ name: 'X-Foo', is_secret: false, value: null }]),
    ).rejects.toThrow();
  });

  it('rejects a secret row with a plaintext value', async () => {
    await expect(
      headers.replaceForService(serviceId, [
        { name: 'Authorization', is_secret: true, value: 'leaked' },
      ]),
    ).rejects.toThrow();
  });

  it('accepts a secret row with ciphertext and no plaintext value', async () => {
    const result = await headers.replaceForService(serviceId, [
      {
        name: 'Authorization',
        is_secret: true,
        value: null,
        secret_ciphertext: Buffer.from('ct'),
        secret_iv: Buffer.from('iv12'),
        secret_auth_tag: Buffer.from('tag'),
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBeNull();
  });
});

describe('the headers_one_owner CHECK', () => {
  it('rejects a row with neither owner', async () => {
    const db = ctx.db;
    await expect(
      db.insertInto('headers').values({ name: 'X-Foo', is_secret: false, value: 'v' }).execute(),
    ).rejects.toThrow();
  });

  it('rejects a row with both owners -- the XOR, not just "at least one"', async () => {
    const db = ctx.db;
    await expect(
      db
        .insertInto('headers')
        .values({
          service_id: serviceId,
          endpoint_id: endpointId,
          name: 'X-Foo',
          is_secret: false,
          value: 'v',
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('replaceForService', () => {
  it('replaces the full set atomically -- old rows gone, new rows present', async () => {
    await headers.replaceForService(serviceId, [{ name: 'X-A', is_secret: false, value: '1' }]);
    await headers.replaceForService(serviceId, [{ name: 'X-B', is_secret: false, value: '2' }]);

    const list = await headers.listForService(serviceId);
    expect(list.map((h) => h.name)).toEqual(['X-B']);
  });

  it('clears every header when given an empty list', async () => {
    await headers.replaceForService(serviceId, [{ name: 'X-A', is_secret: false, value: '1' }]);
    await headers.replaceForService(serviceId, []);

    await expect(headers.listForService(serviceId)).resolves.toEqual([]);
  });
});

describe('replaceForEndpoint', () => {
  it('is independent of the service’s own headers', async () => {
    await headers.replaceForService(serviceId, [
      { name: 'X-Service', is_secret: false, value: 's' },
    ]);
    await headers.replaceForEndpoint(endpointId, [
      { name: 'X-Endpoint', is_secret: false, value: 'e' },
    ]);

    await expect(
      headers.listForService(serviceId).then((l) => l.map((h) => h.name)),
    ).resolves.toEqual(['X-Service']);
    await expect(
      headers.listForEndpoint(endpointId).then((l) => l.map((h) => h.name)),
    ).resolves.toEqual(['X-Endpoint']);
  });
});

describe('case-insensitive uniqueness per owner', () => {
  it('rejects two headers differing only in case, under the same service', async () => {
    await expect(
      headers.replaceForService(serviceId, [
        { name: 'X-Api-Key', is_secret: false, value: '1' },
        { name: 'x-api-key', is_secret: false, value: '2' },
      ]),
    ).rejects.toThrow();
  });
});

/**
 * Forces a genuine two-writer race on `ownerTable`'s row and proves the
 * result behaviorally: not merely that `run` blocks, but that after a real
 * competing full replacement lands, `run`'s own full set is what survives --
 * never a union of both, never a rejection.
 *
 * FOR SHARE, not FOR UPDATE, for the barrier itself: inserting a header or
 * tag row already takes an incidental FOR KEY SHARE lock on the service or
 * endpoint it references (Postgres's own foreign-key check), and FOR KEY
 * SHARE does not conflict with another FOR KEY SHARE -- so a FOR UPDATE
 * barrier would make every test below pass even with a method's own
 * `.forUpdate()` removed, by relying on the FK check's incidental lock
 * instead of the one under test. FOR SHARE conflicts only with FOR UPDATE /
 * FOR NO KEY UPDATE, so it isolates each method's own explicit lock and
 * nothing else. Confirmed per-call by removing that method's `.forUpdate()`
 * and re-running: the assertion after `settled` then fails, because the
 * call proceeds immediately instead of blocking.
 *
 * `competingWrite` runs the *other* full replacement directly as SQL, using
 * the same barrier connection, standing in for a second concurrent call to
 * the same repository method -- deterministic, where two real JS calls
 * racing via Promise.all would only sometimes interleave into the bug.
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
        await client.query('DELETE FROM headers WHERE service_id = $1', [serviceId]);
        await client.query(
          "INSERT INTO headers (service_id, name, is_secret, value) VALUES ($1, 'X-Earlier', false, '1')",
          [serviceId],
        );
      },
      () =>
        headers.replaceForService(serviceId, [{ name: 'X-Later', is_secret: false, value: '2' }]),
    );

    const list = await headers.listForService(serviceId);
    expect(list.map((h) => h.name)).toEqual(['X-Later']);
  });

  it('replaceForEndpoint: the final set is exactly the later call’s, never a union', async () => {
    await raceAgainstCompetingReplacement(
      'endpoints',
      endpointId,
      async (client) => {
        await client.query('DELETE FROM headers WHERE endpoint_id = $1', [endpointId]);
        await client.query(
          "INSERT INTO headers (endpoint_id, name, is_secret, value) VALUES ($1, 'X-Earlier', false, '1')",
          [endpointId],
        );
      },
      () =>
        headers.replaceForEndpoint(endpointId, [{ name: 'X-Later', is_secret: false, value: '2' }]),
    );

    const list = await headers.listForEndpoint(endpointId);
    expect(list.map((h) => h.name)).toEqual(['X-Later']);
  });
});

describe('cascade delete', () => {
  it('deleting the endpoint deletes its headers', async () => {
    await headers.replaceForEndpoint(endpointId, [{ name: 'X-A', is_secret: false, value: '1' }]);

    await endpoints.delete(endpointId, userId);

    await expect(headers.listForEndpoint(endpointId)).resolves.toEqual([]);
  });

  it('deleting the service deletes its own headers, not the endpoint’s', async () => {
    await headers.replaceForService(serviceId, [{ name: 'X-S', is_secret: false, value: '1' }]);
    await headers.replaceForEndpoint(endpointId, [{ name: 'X-E', is_secret: false, value: '2' }]);

    await services.delete(serviceId, userId);

    await expect(headers.listForService(serviceId)).resolves.toEqual([]);
    await expect(headers.listForEndpoint(endpointId)).resolves.toEqual([]);
  });
});
