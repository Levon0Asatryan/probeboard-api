import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, truncateAll } from '../../../testing/database.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';
import { EndpointHealthRepository } from '../repositories/endpoint-health.repository.js';

/**
 * `health` on `GET /v1/endpoints/:id` (docs/m6-plan.md §3.10): the evaluator's
 * stored state, overridden on read by configuration -- paused, then a window
 * covering now. The evaluator's rows are seeded with SQL (the api may not
 * import the worker).
 */
let app: NestExpressApplication;
let base: string;
const { db, pool, close } = connectTestDb();

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
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/v1`;
});

afterAll(async () => {
  await app.close();
  await close();
});

async function signUp(email: string): Promise<string> {
  const json = { 'content-type': 'application/json' };
  const body = JSON.stringify({ email, password: 'correct horse battery' });
  await fetch(`${base}/auth/register`, { method: 'POST', headers: json, body });
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: json, body });
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function health(endpointId: string, cookie: string) {
  const res = await fetch(`${base}/endpoints/${endpointId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { health: Record<string, unknown> }).health;
}

let alice: string;
let ep: { endpoint_id: string; service_id: string; user_id: string };

beforeEach(async () => {
  await truncateAll(pool);
  alice = await signUp('alice@example.com');
  const { rows } = await pool.query<typeof ep>(
    `WITH s AS (INSERT INTO services (user_id, name, base_url)
                SELECT id, 's', 'http://93.184.216.34' FROM users WHERE email = 'alice@example.com'
                RETURNING id, user_id)
     INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     SELECT id, user_id, 'GET', '/p', 60, 5000, 5 FROM s
     RETURNING id AS endpoint_id, service_id, user_id`,
  );
  ep = rows[0];
});

describe('health on the endpoint (docs/m6-plan.md §3.10)', () => {
  it('is unknown, 0 of 3, for an endpoint the evaluator has never seen', async () => {
    expect(await health(ep.endpoint_id, alice)).toEqual({
      state: 'unknown',
      stateSince: null,
      consecutiveFailures: 0,
      failureThreshold: 3,
      openIncidentId: null,
      lastSuccessAt: null,
    });
  });

  it('says "failing, 2 of 3" from the stored state', async () => {
    await pool.query(
      `INSERT INTO endpoint_health (endpoint_id, state, state_since, consecutive_failures,
                                    run_started_at, run_failure_class, last_success_at)
       VALUES ($1, 'pending', '2033-03-10T10:01:00Z', 2, '2033-03-10T10:01:00Z',
               'connection_refused', '2033-03-10T10:00:00Z')`,
      [ep.endpoint_id],
    );
    expect(await health(ep.endpoint_id, alice)).toEqual({
      state: 'pending',
      stateSince: '2033-03-10T10:01:00.000Z',
      consecutiveFailures: 2,
      failureThreshold: 3,
      openIncidentId: null,
      lastSuccessAt: '2033-03-10T10:00:00.000Z',
    });
  });

  it('is maintenance while a window on its service covers now, and the stored state once it ends', async () => {
    await pool.query(
      `INSERT INTO endpoint_health (endpoint_id, state, state_since) VALUES ($1, 'up', now())`,
      [ep.endpoint_id],
    );
    const { rows } = await pool.query<{ id: string; starts_at: Date }>(
      `INSERT INTO maintenance_windows (user_id, service_id, starts_at, ends_at)
       VALUES ($1, $2, now() - interval '10 minutes', now() + interval '1 hour')
       RETURNING id, starts_at`,
      [ep.user_id, ep.service_id],
    );
    expect(await health(ep.endpoint_id, alice)).toMatchObject({
      state: 'maintenance',
      stateSince: rows[0].starts_at.toISOString(),
    });

    await pool.query(
      `UPDATE maintenance_windows SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 second'`,
    );
    expect(await health(ep.endpoint_id, alice)).toMatchObject({ state: 'up' });
  });

  it('is paused when disabled, over a window and a stored state alike', async () => {
    await pool.query(
      `INSERT INTO endpoint_health (endpoint_id, state, state_since) VALUES ($1, 'down', now())`,
      [ep.endpoint_id],
    );
    await pool.query(
      `INSERT INTO maintenance_windows (user_id, endpoint_id, starts_at, ends_at)
       VALUES ($1, $2, now() - interval '1 minute', now() + interval '1 hour')`,
      [ep.user_id, ep.endpoint_id],
    );
    await fetch(`${base}/endpoints/${ep.endpoint_id}/pause`, {
      method: 'POST',
      headers: { cookie: alice },
    });
    expect(await health(ep.endpoint_id, alice)).toMatchObject({
      state: 'paused',
      stateSince: null,
    });
  });

  it('names the open incident', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO incidents (endpoint_id, service_id, user_id, opened_at, confirmed_at,
                              failures_to_open, cause_class)
       VALUES ($1, $2, $3, '2033-03-10T10:01:00Z', '2033-03-10T10:03:00Z', 3, 'connection_refused')
       RETURNING id`,
      [ep.endpoint_id, ep.service_id, ep.user_id],
    );
    await pool.query(
      `INSERT INTO endpoint_health (endpoint_id, state, state_since, consecutive_failures,
                                    run_started_at, run_failure_class, open_incident_id)
       VALUES ($1, 'down', '2033-03-10T10:03:00Z', 3, '2033-03-10T10:01:00Z',
               'connection_refused', $2)`,
      [ep.endpoint_id, rows[0].id],
    );
    expect(await health(ep.endpoint_id, alice)).toMatchObject({
      state: 'down',
      consecutiveFailures: 3,
      openIncidentId: rows[0].id,
    });
  });
});

describe('the repository re-derives the owner itself (AGENTS.md, child-resource rule)', () => {
  it("returns nothing for another user's endpoint, even when asked by its id", async () => {
    // Behind the HTTP route the endpoint is found under its owner first, so
    // only a direct call can show this query does not rely on that.
    await pool.query(
      `INSERT INTO endpoint_health (endpoint_id, state, state_since) VALUES ($1, 'down', now())`,
      [ep.endpoint_id],
    );
    await signUp('bob@example.com');
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'bob@example.com'`,
    );
    const repo = new EndpointHealthRepository({ kysely: db } as never);
    expect(await repo.stored(ep.endpoint_id, rows[0].id)).toBeUndefined();
    expect(await repo.stored(ep.endpoint_id, ep.user_id)).toMatchObject({ state: 'down' });
  });
});
