import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';

/**
 * Maintenance windows over HTTP (docs/m6-plan.md §3.7, §3.10) against a real
 * server and database. The quota is 2 and the maximum length 2 days in this
 * file, so both limits are reachable in a test.
 */
let app: NestExpressApplication;
let base: string;
const { pool, close } = connectTestDb();

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.HEADER_ENCRYPTION_KEY = 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';
  process.env.COOKIE_SECURE = 'false';
  process.env.LOG_LEVEL = 'fatal';
  process.env.MAINTENANCE_WINDOW_QUOTA_PER_USER = '2';
  process.env.MAINTENANCE_MAX_DURATION_DAYS = '2';

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app, (await import('../../../core/config/index.js')).loadConfig());
  await registerNotFoundFallback(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/v1`;
});

afterAll(async () => {
  await app.close();
  await close();
});

interface Res {
  status: number;
  text: string;
  body: unknown;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as unknown) : undefined };
}

async function signUp(email: string): Promise<string> {
  const json = { 'content-type': 'application/json' };
  const body = JSON.stringify({ email, password: 'correct horse battery' });
  await fetch(`${base}/auth/register`, { method: 'POST', headers: json, body });
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: json, body });
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function endpointOf(email: string, path = '/p') {
  const { rows } = await pool.query<{ endpoint_id: string; service_id: string }>(
    `WITH u AS (SELECT id FROM users WHERE email = $1),
          s AS (INSERT INTO services (user_id, name, base_url)
                SELECT id, 's', 'http://93.184.216.34' FROM u
                ON CONFLICT (user_id, base_url) DO UPDATE SET name = excluded.name
                RETURNING id, user_id)
     INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     SELECT id, user_id, 'GET', $2, 60, 5000, 5 FROM s
     RETURNING id AS endpoint_id, service_id`,
    [email, path],
  );
  return rows[0];
}

const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

let alice: string;
let bob: string;

beforeEach(async () => {
  await truncateAll(pool);
  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');
});

describe('create, read, update, delete', () => {
  it('declares a window on an endpoint and one on a service, and reads them back', async () => {
    const ep = await endpointOf('alice@example.com');
    const onEndpoint = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { endpointId: ep.endpoint_id, startsAt: at(-HOUR), endsAt: at(HOUR), reason: 'deploy' },
    });
    expect(onEndpoint.status).toBe(201);
    expect(onEndpoint.body).toMatchObject({
      endpointId: ep.endpoint_id,
      serviceId: null,
      reason: 'deploy',
      // A start in the past is accepted: it applies from now (§3.7).
      active: true,
    });

    const onService = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { serviceId: ep.service_id, startsAt: at(HOUR), endsAt: at(2 * HOUR) },
    });
    expect(onService.status).toBe(201);
    expect(onService.body).toMatchObject({ serviceId: ep.service_id, active: false, reason: null });

    const id = (onEndpoint.body as { id: string }).id;
    expect((await call(`/maintenance-windows/${id}`, { cookie: alice })).body).toMatchObject({
      id,
    });
    const active = await call('/maintenance-windows?active=true', { cookie: alice });
    expect((active.body as { id: string }[]).map((w) => w.id)).toEqual([id]);
    const forService = await call(`/maintenance-windows?serviceId=${ep.service_id}`, {
      cookie: alice,
    });
    expect(forService.body).toHaveLength(1);
  });

  it('edits the times and clears the reason, and deletes', async () => {
    const ep = await endpointOf('alice@example.com');
    const created = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { endpointId: ep.endpoint_id, startsAt: at(HOUR), endsAt: at(2 * HOUR), reason: 'x' },
    });
    const id = (created.body as { id: string }).id;
    const endsAt = at(3 * HOUR);
    const patched = await call(`/maintenance-windows/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { endsAt, reason: null },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ endsAt, reason: null });

    expect(
      (await call(`/maintenance-windows/${id}`, { method: 'DELETE', cookie: alice })).status,
    ).toBe(204);
    expect((await call(`/maintenance-windows/${id}`, { cookie: alice })).status).toBe(404);
  });
});

describe('the rules a window must keep (§3.7)', () => {
  it('refuses a window ending now or earlier, on create and on edit', async () => {
    const ep = await endpointOf('alice@example.com');
    const past = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { endpointId: ep.endpoint_id, startsAt: at(-2 * HOUR), endsAt: at(-HOUR) },
    });
    expect(past.status).toBe(400);
    expect(past.body).toMatchObject({ code: 'MAINTENANCE_WINDOW_IN_PAST' });

    const ok = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { endpointId: ep.endpoint_id, startsAt: at(-HOUR), endsAt: at(HOUR) },
    });
    const id = (ok.body as { id: string }).id;
    const edit = await call(`/maintenance-windows/${id}`, {
      method: 'PATCH',
      cookie: alice,
      body: { endsAt: at(-1000) },
    });
    expect(edit.status).toBe(400);
    expect(edit.body).toMatchObject({ code: 'MAINTENANCE_WINDOW_IN_PAST' });
  });

  it('refuses an edit that inverts the window, either end, and leaves it as stored', async () => {
    // The update body checks each time alone, so the merged-window check is
    // the only thing ordering them on PATCH (Codex on #98).
    const ep = await endpointOf('alice@example.com');
    const created = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { endpointId: ep.endpoint_id, startsAt: at(HOUR), endsAt: at(2 * HOUR) },
    });
    const stored = created.body as { id: string; startsAt: string; endsAt: string };

    for (const body of [{ startsAt: at(3 * HOUR) }, { endsAt: at(HOUR / 2) }]) {
      const res = await call(`/maintenance-windows/${stored.id}`, {
        method: 'PATCH',
        cookie: alice,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'endsAt', message: 'must be after startsAt' }],
      });
    }
    expect((await call(`/maintenance-windows/${stored.id}`, { cookie: alice })).body).toMatchObject(
      { startsAt: stored.startsAt, endsAt: stored.endsAt },
    );
  });

  it('refuses one longer than MAINTENANCE_MAX_DURATION_DAYS, and accepts exactly that', async () => {
    const ep = await endpointOf('alice@example.com');
    const startsAt = new Date(Date.now() + HOUR);
    const plus = (ms: number) => new Date(startsAt.getTime() + ms).toISOString();
    const tooLong = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: {
        endpointId: ep.endpoint_id,
        startsAt: startsAt.toISOString(),
        endsAt: plus(2 * 24 * HOUR + 1),
      },
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({ code: 'MAINTENANCE_WINDOW_TOO_LONG' });

    const exact = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: {
        endpointId: ep.endpoint_id,
        startsAt: startsAt.toISOString(),
        endsAt: plus(2 * 24 * HOUR),
      },
    });
    expect(exact.status).toBe(201);
  });

  it('refuses both targets, no target, an inverted window and an offset-less time', async () => {
    const ep = await endpointOf('alice@example.com');
    for (const body of [
      { serviceId: ep.service_id, endpointId: ep.endpoint_id, startsAt: at(0), endsAt: at(HOUR) },
      { startsAt: at(0), endsAt: at(HOUR) },
      { endpointId: ep.endpoint_id, startsAt: at(2 * HOUR), endsAt: at(HOUR) },
      { endpointId: ep.endpoint_id, startsAt: '2033-01-01T10:00:00', endsAt: at(HOUR) },
    ]) {
      const res = await call('/maintenance-windows', { method: 'POST', cookie: alice, body });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('counts every stored window against the quota, ended ones included', async () => {
    const ep = await endpointOf('alice@example.com');
    const body = { endpointId: ep.endpoint_id, startsAt: at(-HOUR), endsAt: at(HOUR) };
    for (let i = 0; i < 2; i += 1) {
      expect(
        (await call('/maintenance-windows', { method: 'POST', cookie: alice, body })).status,
      ).toBe(201);
    }
    // One of them ends: it still counts (§3.7).
    await pool.query(
      `UPDATE maintenance_windows SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
        WHERE id = (SELECT id FROM maintenance_windows LIMIT 1)`,
    );
    const third = await call('/maintenance-windows', { method: 'POST', cookie: alice, body });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({
      code: 'MAINTENANCE_WINDOW_QUOTA_EXCEEDED',
      details: { limit: 2, count: 2 },
    });
    // Per user: bob's quota is his own.
    const bobs = await endpointOf('bob@example.com');
    const forBob = await call('/maintenance-windows', {
      method: 'POST',
      cookie: bob,
      body: { endpointId: bobs.endpoint_id, startsAt: at(-HOUR), endsAt: at(HOUR) },
    });
    expect(forBob.status).toBe(201);
  });

  it('admits one of two concurrent creates at the last free slot: the count is under the user row lock', async () => {
    const ep = await endpointOf('alice@example.com');
    const body = { endpointId: ep.endpoint_id, startsAt: at(-HOUR), endsAt: at(HOUR) };
    expect(
      (await call('/maintenance-windows', { method: 'POST', cookie: alice, body })).status,
    ).toBe(201);

    // Inserts block on the table lock, reads do not: both creates count before
    // either can insert -- unless the user row lock makes the second wait
    // before counting. Released once both are seen waiting (rule #12).
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE maintenance_windows IN SHARE ROW EXCLUSIVE MODE');
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;

      const racing = [1, 2].map(() =>
        call('/maintenance-windows', { method: 'POST', cookie: alice, body }),
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND pid <> $1 AND datname = current_database()`,
          [holderPid],
        );
        if (Number(rows[0].n) >= 2) break;
        if (Date.now() > deadline) throw new Error('the two creates never both waited');
        await new Promise((r) => setTimeout(r, 10));
      }
      await holder.query('COMMIT');

      const statuses = (await Promise.all(racing)).map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
    } finally {
      await holder.end();
    }
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM maintenance_windows`,
    );
    expect(rows[0].n).toBe('2');
  });
});

describe('tenant scope', () => {
  it("answers bob on alice's window exactly like a random UUID, and on her targets with 404", async () => {
    const ep = await endpointOf('alice@example.com');
    const created = await call('/maintenance-windows', {
      method: 'POST',
      cookie: alice,
      body: { endpointId: ep.endpoint_id, startsAt: at(-HOUR), endsAt: at(HOUR) },
    });
    const id = (created.body as { id: string }).id;
    const random = randomUUID();

    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { reason: 'mine now' } : undefined;
      const hers = await call(`/maintenance-windows/${id}`, { method, cookie: bob, body });
      const nobody = await call(`/maintenance-windows/${random}`, { method, cookie: bob, body });
      expect(hers.status).toBe(404);
      expect(hers.text).toBe(nobody.text);
    }
    expect((await call('/maintenance-windows', { cookie: bob })).body).toEqual([]);

    // Creating one on her endpoint or service is the same 404 as on nothing.
    for (const target of [{ endpointId: ep.endpoint_id }, { serviceId: ep.service_id }]) {
      const res = await call('/maintenance-windows', {
        method: 'POST',
        cookie: bob,
        body: { ...target, startsAt: at(-HOUR), endsAt: at(HOUR) },
      });
      expect(res.status).toBe(404);
    }
    expect((await call(`/maintenance-windows/${id}`, { cookie: alice })).body).toMatchObject({
      reason: null,
    });
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await call('/maintenance-windows')).status).toBe(401);
  });
});
