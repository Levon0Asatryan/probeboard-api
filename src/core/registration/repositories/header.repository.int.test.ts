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
