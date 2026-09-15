import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService } from '../../../core/db/db.service.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { truncateAll } from '../../../testing/database.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';

/**
 * `assertSaveableUrl` does real DNS resolution against a user-controlled
 * hostname. Gated behind `gate.active` so only this file's own calls stall --
 * every other caller (service/endpoint setup in this file's own beforeEach)
 * passes straight through to the real implementation.
 */
const gate = vi.hoisted(() => ({
  active: false,
  entered: false,
  release: undefined as (() => void) | undefined,
}));

vi.mock('../../../core/ssrf/host-validator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/ssrf/host-validator.js')>();
  return {
    ...actual,
    assertSaveableUrl: (rawUrl: string, cfg: Parameters<typeof actual.assertSaveableUrl>[1]) => {
      if (!gate.active) return actual.assertSaveableUrl(rawUrl, cfg);
      gate.entered = true;
      return new Promise((resolve, reject) => {
        gate.release = () => {
          actual.assertSaveableUrl(rawUrl, cfg).then(resolve, reject);
        };
      });
    },
  };
});

let app: NestExpressApplication;
let base: string;
let db: DbService;
let users: UserRepository;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.HEADER_ENCRYPTION_KEY = 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';
  process.env.COOKIE_SECURE = 'false';
  process.env.LOG_LEVEL = 'fatal';

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app, (await import('../../../core/config/index.js')).loadConfig());
  await registerNotFoundFallback(app);
  await app.listen(0, '127.0.0.1');

  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/v1`;
  db = app.get(DbService);
  users = app.get(UserRepository);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll((db as unknown as { pool: import('pg').Pool }).pool);
  gate.active = false;
  gate.entered = false;
  gate.release = undefined;
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

async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
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
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const me = await call('/auth/me', { method: 'GET', cookie });
  return { cookie, userId: (me.body as { id: string }).id };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('DNS-before-lock: SSRF validation does not hold the user row lock', () => {
  it('lets a concurrent lock on the same user proceed while assertSaveableUrl is still pending', async () => {
    const alice = await signUp('alice@example.com');
    const created = await call('/services', {
      cookie: alice.cookie,
      body: { name: 'svc', baseUrl: 'http://93.184.216.34' },
    });
    const serviceId = (created.body as { service: { id: string } }).service.id;

    gate.active = true;
    const createPromise = call(`/services/${serviceId}/endpoints`, {
      cookie: alice.cookie,
      body: { method: 'GET', path: '/orders' },
    });

    // The stalled assertSaveableUrl call above is the create's own -- wait
    // for it to actually be in flight before racing the second lock.
    await waitUntil(() => gate.entered);

    const start = Date.now();
    await db.kysely.transaction().execute(async (trx) => {
      await users.lockForUpdate(alice.userId, trx);
    });
    const elapsed = Date.now() - start;

    // The fix moves assertSaveableUrl before the transaction opens, so this
    // second lock on the same user is uncontended and returns quickly --
    // long before the gate below is ever released. Reverting the fix (the
    // lock acquired first, assertSaveableUrl awaited while holding it) makes
    // this second lock block until the gate releases, which this bound
    // would then fail to observe.
    expect(elapsed).toBeLessThan(500);

    gate.release!();
    const res = await createPromise;
    expect(res.status).toBe(201);
  });

  it('lets a concurrent lock on the same endpoint proceed while a PATCH revalidation is pending', async () => {
    const alice = await signUp('alice@example.com');
    const created = await call('/services', {
      cookie: alice.cookie,
      body: { name: 'svc', baseUrl: 'http://93.184.216.34' },
    });
    const serviceId = (created.body as { service: { id: string } }).service.id;
    const createdEndpoint = await call(`/services/${serviceId}/endpoints`, {
      cookie: alice.cookie,
      body: { method: 'GET', path: '/orders' },
    });
    const endpointId = (createdEndpoint.body as { id: string }).id;

    gate.active = true;
    const patchPromise = call(`/endpoints/${endpointId}`, {
      method: 'PATCH',
      cookie: alice.cookie,
      body: { path: '/other' },
    });

    await waitUntil(() => gate.entered);

    const start = Date.now();
    await db.kysely.transaction().execute(async (trx) => {
      await trx
        .selectFrom('endpoints')
        .select('id')
        .where('id', '=', endpointId)
        .forUpdate()
        .executeTakeFirst();
    });
    const elapsed = Date.now() - start;

    // Same property as createForService, on update's endpoint-row lock: the
    // fix runs assertSaveableUrl before the transaction opens, so a second
    // lock on the same endpoint row is uncontended here. Reverting the fix
    // (lock first, revalidate while holding it) blocks this second lock
    // until the gate below is released, which this bound would then fail.
    expect(elapsed).toBeLessThan(500);

    gate.release!();
    const res = await patchPromise;
    expect(res.status).toBe(200);
  });
});
