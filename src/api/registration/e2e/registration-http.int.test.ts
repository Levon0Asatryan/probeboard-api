import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../../../core/db/db.service.js';
import { truncateAll } from '../../../testing/database.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';

/**
 * The registration HTTP surface (docs/m2-plan.md PR4) against a real server
 * and a real database: real cookies, real SSRF/quota/header-validation
 * wiring, real status codes -- the unit-level tests on each service already
 * cover the logic branches; only this proves the pieces are actually wired
 * together behind HTTP.
 */

let app: NestExpressApplication;
let base: string;
let db: DbService;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.HEADER_ENCRYPTION_KEY = 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';
  process.env.COOKIE_SECURE = 'false';
  process.env.LOG_LEVEL = 'fatal';
  process.env.ENDPOINT_QUOTA_PER_USER = '2';
  process.env.MAX_LIST_LIMIT = '2';
  process.env.MAX_ENDPOINT_PATH_BYTES = '16';

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app, (await import('../../../core/config/index.js')).loadConfig());
  await registerNotFoundFallback(app);
  await app.listen(0, '127.0.0.1');

  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/v1`;
  db = app.get(DbService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll((db as unknown as { pool: import('pg').Pool }).pool);
});

interface Res {
  status: number;
  body: unknown;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

async function signUp(email: string): Promise<string> {
  await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  const raw = res.headers.get('set-cookie')!;
  return raw.split(';')[0];
}

let alice: string;
let bob: string;

beforeEach(async () => {
  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');
});

describe('services: create, read, list, update, delete', () => {
  it('creates an explicit service and reads it back', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'My API', baseUrl: 'http://93.184.216.34' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      service: { name: 'My API', baseUrl: 'http://93.184.216.34', headers: [], tags: [] },
    });

    const id = (created.body as { service: { id: string } }).service.id;
    const got = await call(`/services/${id}`, { method: 'GET', cookie: alice });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, name: 'My API' });
  });

  it("404s, not 403s, for another user's service", async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'My API', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    const asBob = await call(`/services/${id}`, { method: 'GET', cookie: bob });
    expect(asBob.status).toBe(404);
    expect(asBob.body).toMatchObject({ code: 'NOT_FOUND' });

    const patch = await call(`/services/${id}`, {
      method: 'PATCH',
      cookie: bob,
      body: { name: 'renamed' },
    });
    expect(patch.status).toBe(404);

    const del = await call(`/services/${id}`, { method: 'DELETE', cookie: bob });
    expect(del.status).toBe(404);
  });

  it("lists only the caller's own services", async () => {
    await call('/services', {
      cookie: alice,
      body: { name: 'Alice API', baseUrl: 'http://93.184.216.34' },
    });
    await call('/services', {
      cookie: bob,
      body: { name: 'Bob API', baseUrl: 'http://93.184.216.35' },
    });

    const list = await call('/services', { method: 'GET', cookie: alice });
    expect(list.status).toBe(200);
    const names = (list.body as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(['Alice API']);
  });

  it('clamps ?limit to the configured MAX_LIST_LIMIT (2 for this test file)', async () => {
    for (const ip of ['93.184.216.34', '93.184.216.35', '93.184.216.36']) {
      await call('/services', { cookie: alice, body: { name: ip, baseUrl: `http://${ip}` } });
    }

    const list = await call('/services?limit=50', { method: 'GET', cookie: alice });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
  });

  it('GET /services/:id/endpoints is paginated, not an unbounded fan-out', async () => {
    // ENDPOINT_QUOTA_PER_USER=2 for this test file, so two is the most
    // this user can ever have -- ?limit=1 is what proves pagination is
    // actually applied here (this route previously loaded every row with
    // no cursor or limit at all).
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;
    for (const path of ['/a', '/b']) {
      await call(`/services/${id}/endpoints`, { cookie: alice, body: { path } });
    }

    const list = await call(`/services/${id}/endpoints?limit=1`, {
      method: 'GET',
      cookie: alice,
    });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  it('deletes a service, cascading to its endpoints', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'My API', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;
    await call(`/services/${id}/endpoints`, { cookie: alice, body: { path: '/orders' } });

    expect((await call(`/services/${id}`, { method: 'DELETE', cookie: alice })).status).toBe(204);
    expect((await call(`/services/${id}`, { method: 'GET', cookie: alice })).status).toBe(404);
  });
});

describe('B-3: implicit service creation from a URL', () => {
  it('creates a service and one endpoint for a new origin', async () => {
    const res = await call('/services', {
      cookie: alice,
      body: { url: 'http://93.184.216.34/orders' },
    });
    expect(res.status).toBe(201);
    const body = res.body as { service: { id: string }; endpointId: string };
    expect(body.endpointId).toBeTruthy();

    const endpoints = await call(`/services/${body.service.id}/endpoints`, {
      method: 'GET',
      cookie: alice,
    });
    expect(endpoints.body).toHaveLength(1);
    expect((endpoints.body as { path: string }[])[0].path).toBe('/orders');
  });

  it('attaches to an existing service at the same origin rather than duplicating it', async () => {
    const first = await call('/services', {
      cookie: alice,
      body: { url: 'http://93.184.216.34/orders' },
    });
    const second = await call('/services', {
      cookie: alice,
      body: { url: 'http://93.184.216.34/users' },
    });

    const firstId = (first.body as { service: { id: string } }).service.id;
    const secondId = (second.body as { service: { id: string } }).service.id;
    expect(secondId).toBe(firstId);

    const services = await call('/services', { method: 'GET', cookie: alice });
    expect(services.body).toHaveLength(1);

    const endpoints = await call(`/services/${firstId}/endpoints`, {
      method: 'GET',
      cookie: alice,
    });
    expect(endpoints.body).toHaveLength(2);
  });
});

describe('SSRF guard on save', () => {
  it('rejects a non-http(s) scheme without touching the network', async () => {
    const res = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'ftp://example.com' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'SCHEME_NOT_ALLOWED' });
  });

  it('rejects credentials embedded in the URL', async () => {
    const res = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://user:pass@example.com' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CREDENTIALS_IN_URL' });
  });

  it('rejects a loopback address literal', async () => {
    const res = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://127.0.0.1' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });

  it('re-validates baseUrl on PATCH even if only the name changes', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    const res = await call(`/services/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { baseUrl: 'http://127.0.0.1' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });
});

describe('header value validation', () => {
  it('rejects a value with a character above U+00FF', async () => {
    const res = await call('/services', {
      cookie: alice,
      body: {
        name: 'x',
        baseUrl: 'http://93.184.216.34',
        headers: [{ name: 'X-Foo', value: '\u{1F600}', isSecret: false }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'HEADER_INVALID' });
  });
});

describe('secret headers: write-only', () => {
  it('never returns a secret value, on create or on read', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: {
        name: 'x',
        baseUrl: 'http://93.184.216.34',
        headers: [{ name: 'X-Api-Key', value: 'super-secret', isSecret: true }],
      },
    });
    expect(created.status).toBe(201);
    const body = JSON.stringify(created.body);
    expect(body).not.toContain('super-secret');
    expect((created.body as { service: { headers: unknown[] } }).service.headers).toEqual([
      { name: 'X-Api-Key', isSecret: true },
    ]);

    const id = (created.body as { service: { id: string } }).service.id;
    const got = await call(`/services/${id}`, { method: 'GET', cookie: alice });
    expect(JSON.stringify(got.body)).not.toContain('super-secret');
  });

  it('PATCH "keep" (no value) leaves the secret usable without ever exposing it', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: {
        name: 'x',
        baseUrl: 'http://93.184.216.34',
        headers: [{ name: 'X-Api-Key', value: 'super-secret', isSecret: true }],
      },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    const patched = await call(`/services/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { name: 'renamed', headers: [{ name: 'X-Api-Key', isSecret: true }] },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { headers: unknown[] }).headers).toEqual([
      { name: 'X-Api-Key', isSecret: true },
    ]);
  });

  it('rejects a "keep" for a secret that was never set', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    const patched = await call(`/services/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { headers: [{ name: 'X-Never-Set', isSecret: true }] },
    });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ code: 'HEADER_INVALID' });
  });
});

describe('B-4: header override by name, case-insensitive', () => {
  it("endpoint's own header value wins over the service's", async () => {
    const created = await call('/services', {
      cookie: alice,
      body: {
        name: 'x',
        baseUrl: 'http://93.184.216.34',
        headers: [{ name: 'X-Api-Key', value: 'service-value', isSecret: false }],
      },
    });
    const serviceId = (created.body as { service: { id: string } }).service.id;

    const endpoint = await call(`/services/${serviceId}/endpoints`, {
      cookie: alice,
      body: {
        path: '/orders',
        headers: [{ name: 'x-api-key', value: 'endpoint-value', isSecret: false }],
      },
    });
    expect(endpoint.status).toBe(201);
    const effective = (endpoint.body as { effectiveHeaders: { name: string; value: string }[] })
      .effectiveHeaders;
    expect(effective).toEqual([{ name: 'x-api-key', isSecret: false, value: 'endpoint-value' }]);
  });
});

describe('the endpoint quota (B-8)', () => {
  it('rejects the Nth+1 endpoint with QUOTA_EXCEEDED', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    // ENDPOINT_QUOTA_PER_USER=2 for this test file.
    expect(
      (await call(`/services/${id}/endpoints`, { cookie: alice, body: { path: '/a' } })).status,
    ).toBe(201);
    expect(
      (await call(`/services/${id}/endpoints`, { cookie: alice, body: { path: '/b' } })).status,
    ).toBe(201);

    const third = await call(`/services/${id}/endpoints`, { cookie: alice, body: { path: '/c' } });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { limit: 2, count: 2 } });
  });
});

describe('duplicate method+path', () => {
  it('rejects a second endpoint with the same method and path', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    await call(`/services/${id}/endpoints`, { cookie: alice, body: { path: '/orders' } });
    const dup = await call(`/services/${id}/endpoints`, {
      cookie: alice,
      body: { path: '/orders' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('B-3: submitting the same implicit URL twice conflicts, not 500s', async () => {
    await call('/services', { cookie: alice, body: { url: 'http://93.184.216.34/orders' } });
    const dup = await call('/services', {
      cookie: alice,
      body: { url: 'http://93.184.216.34/orders' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'CONFLICT' });
  });
});

describe('malformed ids', () => {
  it('400s rather than 500ing on a non-UUID :id', async () => {
    for (const path of [
      '/services/not-a-uuid',
      '/endpoints/not-a-uuid',
      '/services/not-a-uuid/endpoints',
    ]) {
      const res = await call(path, { method: 'GET', cookie: alice });
      expect(res.status).toBe(400);
    }
  });

  it('400s rather than 500ing on a non-UUID ?cursor', async () => {
    const res = await call('/services?cursor=not-a-uuid', { method: 'GET', cookie: alice });
    expect(res.status).toBe(400);
  });
});

describe('endpoint path canonicalization', () => {
  it('treats "orders" and "/orders" as the same duplicate target', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    const first = await call(`/services/${id}/endpoints`, {
      cookie: alice,
      body: { path: 'orders' },
    });
    expect(first.status).toBe(201);
    expect((first.body as { path: string }).path).toBe('/orders');

    const dup = await call(`/services/${id}/endpoints`, {
      cookie: alice,
      body: { path: '/orders' },
    });
    expect(dup.status).toBe(409);
  });

  it('resolves dot-segments to the same canonical target', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    await call(`/services/${id}/endpoints`, { cookie: alice, body: { path: '/orders' } });
    const dup = await call(`/services/${id}/endpoints`, {
      cookie: alice,
      body: { path: '/a/../orders' },
    });
    expect(dup.status).toBe(409);
  });

  it('enforces the configured path byte cap (16 for this test file) in bytes, not JS string length', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    // 8 é characters: 8 UTF-16 code units (under the DTO's own structural
    // bound and under 16 by JS .length), but each is 2 UTF-8 bytes --
    // 17 bytes total with the leading slash, over the configured cap.
    const res = await call(`/services/${id}/endpoints`, {
      cookie: alice,
      body: { path: `/${'é'.repeat(8)}` },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('also enforces the path byte cap on B-3 implicit creation', async () => {
    const res = await call('/services', {
      cookie: alice,
      body: { url: `http://93.184.216.34/${'é'.repeat(8)}` },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('atomicity: a failed PATCH changes nothing', () => {
  it('does not rename the service when the header replacement fails', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'original', baseUrl: 'http://93.184.216.34' },
    });
    const id = (created.body as { service: { id: string } }).service.id;

    const patch = await call(`/services/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { name: 'renamed', headers: [{ name: 'X-Never-Set', isSecret: true }] },
    });
    expect(patch.status).toBe(400);

    const got = await call(`/services/${id}`, { method: 'GET', cookie: alice });
    expect((got.body as { name: string }).name).toBe('original');
  });

  it('does not change the endpoint path when the header replacement fails', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const serviceId = (created.body as { service: { id: string } }).service.id;
    const endpoint = await call(`/services/${serviceId}/endpoints`, {
      cookie: alice,
      body: { path: '/orders' },
    });
    const id = (endpoint.body as { id: string }).id;

    const patch = await call(`/endpoints/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { path: '/changed', headers: [{ name: 'X-Never-Set', isSecret: true }] },
    });
    expect(patch.status).toBe(400);

    const got = await call(`/endpoints/${id}`, { method: 'GET', cookie: alice });
    expect((got.body as { path: string }).path).toBe('/orders');
  });
});

describe('pause and resume', () => {
  it('toggles enabled', async () => {
    const created = await call('/services', {
      cookie: alice,
      body: { name: 'x', baseUrl: 'http://93.184.216.34' },
    });
    const serviceId = (created.body as { service: { id: string } }).service.id;
    const endpoint = await call(`/services/${serviceId}/endpoints`, {
      cookie: alice,
      body: { path: '/orders' },
    });
    const id = (endpoint.body as { id: string }).id;

    const paused = await call(`/endpoints/${id}/pause`, { cookie: alice });
    expect(paused.status).toBe(200);
    expect((paused.body as { enabled: boolean }).enabled).toBe(false);

    const resumed = await call(`/endpoints/${id}/resume`, { cookie: alice });
    expect((resumed.body as { enabled: boolean }).enabled).toBe(true);
  });
});
