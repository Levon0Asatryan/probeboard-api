import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { ServiceRepository } from './service.repository.js';
import { EndpointRepository } from './endpoint.repository.js';

let ctx: TestDb;
let services: ServiceRepository;
let endpoints: EndpointRepository;
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

    await expect(endpoints.listForService(serviceId, otherUserId)).resolves.toEqual([]);
    const mine = await endpoints.listForService(serviceId, userId);
    expect(mine.map((e) => e.path)).toEqual(['/mine']);
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
