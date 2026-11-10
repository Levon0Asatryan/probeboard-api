import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, truncateAll } from '../../../testing/database.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';

/**
 * Incident history over HTTP (docs/m6-plan.md §3.10, D-5, FR-27), against a
 * real server and database.
 *
 * Incidents are seeded with SQL: the evaluator that writes them is the
 * worker's, which the api may not import (ADR-0006). The rows are exactly the
 * ones the worker's acceptance test produces at its step 4
 * (`worker/incidents/e2e/evaluator.int.test.ts`); the chain end to end -- a
 * real outage, the evaluator, this route -- is the verification run's
 * (docs/m6-verification.md).
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
  process.env.MAX_LIST_LIMIT = '2';

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

async function get(path: string, cookie?: string): Promise<Res> {
  const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
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

/** A service and one endpoint for `email`'s account, written directly. */
async function endpointOf(email: string, path = '/p') {
  const { rows } = await pool.query<{ endpoint_id: string; service_id: string; user_id: string }>(
    `WITH u AS (SELECT id FROM users WHERE email = $1),
          s AS (INSERT INTO services (user_id, name, base_url)
                SELECT id, 's', 'http://93.184.216.34' FROM u
                ON CONFLICT (user_id, base_url) DO UPDATE SET name = excluded.name
                RETURNING id, user_id)
     INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     SELECT id, user_id, 'GET', $2, 60, 5000, 5 FROM s
     RETURNING id AS endpoint_id, service_id, user_id`,
    [email, path],
  );
  return rows[0];
}

async function incident(
  ep: { endpoint_id: string; service_id: string; user_id: string },
  t: { opened: string; confirmed: string; closed?: string; closeConfirmed?: string },
  cause: { class?: string; code?: string; status?: number; detail?: unknown } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO incidents (endpoint_id, service_id, user_id, opened_at, confirmed_at,
                            failures_to_open, cause_class, cause_code, cause_status_code,
                            cause_detail, closed_at, close_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, 3, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      ep.endpoint_id,
      ep.service_id,
      ep.user_id,
      t.opened,
      t.confirmed,
      cause.class ?? 'connection_refused',
      cause.code ?? null,
      cause.status ?? null,
      cause.detail === undefined ? null : JSON.stringify(cause.detail),
      t.closed ?? null,
      t.closeConfirmed ?? null,
    ],
  );
  return rows[0].id;
}

let alice: string;
let bob: string;

beforeEach(async () => {
  await truncateAll(pool);
  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');
});

describe('acceptance step 5 (docs/m6-plan.md §8)', () => {
  it('returns the incident with durationMs 180000 and detectionLatencyMs 120000', async () => {
    const ep = await endpointOf('alice@example.com');
    // Step 4's incident: failures from 10:01, confirmed 10:03; successes from
    // 10:04, confirmed 10:05.
    const id = await incident(
      ep,
      {
        opened: '2033-03-10T10:01:00Z',
        confirmed: '2033-03-10T10:03:00Z',
        closed: '2033-03-10T10:04:00Z',
        closeConfirmed: '2033-03-10T10:05:00Z',
      },
      { class: 'dns_failure', code: 'ESERVFAIL' },
    );

    const res = await get(`/endpoints/${ep.endpoint_id}/incidents`, alice);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id,
        endpointId: ep.endpoint_id,
        serviceId: ep.service_id,
        status: 'closed',
        openedAt: '2033-03-10T10:01:00.000Z',
        confirmedAt: '2033-03-10T10:03:00.000Z',
        closedAt: '2033-03-10T10:04:00.000Z',
        closeConfirmedAt: '2033-03-10T10:05:00.000Z',
        durationMs: 180_000,
        detectionLatencyMs: 120_000,
        failuresToOpen: 3,
        cause: { class: 'dns_failure', code: 'ESERVFAIL', statusCode: null, assertion: null },
      },
    ]);
  });

  it('shows an open incident with no duration, and which assertion failed', async () => {
    const ep = await endpointOf('alice@example.com');
    const detail = {
      index: 1,
      code: 'value_mismatch',
      assertion: { type: 'json_path', path: '$.status', equals: 'ok' },
    };
    const id = await incident(
      ep,
      { opened: '2033-03-10T10:01:00Z', confirmed: '2033-03-10T10:03:00Z' },
      { class: 'assertion_failed', status: 200, detail },
    );
    const res = await get(`/incidents/${id}`, alice);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'open',
      closedAt: null,
      durationMs: null,
      detectionLatencyMs: 120_000,
      cause: { class: 'assertion_failed', statusCode: 200, assertion: detail },
    });
  });
});

describe('tenant scope: every read joins endpoints on id and user_id', () => {
  it("answers bob's reads of alice's incident, endpoint and service exactly like a random UUID", async () => {
    const ep = await endpointOf('alice@example.com');
    const id = await incident(ep, {
      opened: '2033-03-10T10:01:00Z',
      confirmed: '2033-03-10T10:03:00Z',
    });
    const random = randomUUID();

    for (const [hers, nobody] of [
      [`/incidents/${id}`, `/incidents/${random}`],
      [`/endpoints/${ep.endpoint_id}/incidents`, `/endpoints/${random}/incidents`],
      [`/services/${ep.service_id}/incidents`, `/services/${random}/incidents`],
    ]) {
      const asBob = await get(hers, bob);
      const missing = await get(nobody, bob);
      expect(asBob.status).toBe(404);
      expect(asBob.text).toBe(missing.text);
    }
    expect((await get(`/incidents/${id}`, alice)).status).toBe(200);
  });

  it("leaves alice's incidents out of bob's list, and gives bob nothing for her id as a cursor", async () => {
    const ep = await endpointOf('alice@example.com');
    const id = await incident(ep, {
      opened: '2033-03-10T10:01:00Z',
      confirmed: '2033-03-10T10:03:00Z',
    });
    // Bob has an older one of his own: resolved without the owner scope, her
    // id would page him from her incident's position and return it.
    const bobs = await incident(await endpointOf('bob@example.com'), {
      opened: '2033-03-10T07:00:00Z',
      confirmed: '2033-03-10T07:02:00Z',
    });
    expect((await get('/incidents', bob)).body).toMatchObject([{ id: bobs }]);
    expect((await get(`/incidents?cursor=${id}`, bob)).body).toEqual([]);
    expect((await get('/incidents', alice)).body).toMatchObject([{ id }]);
  });

  it("hides a deleted endpoint's incidents at once, before the evaluator sweeps them (plan §3.12)", async () => {
    const ep = await endpointOf('alice@example.com');
    const id = await incident(ep, {
      opened: '2033-03-10T10:01:00Z',
      confirmed: '2033-03-10T10:03:00Z',
    });
    await pool.query(`DELETE FROM endpoints WHERE id = $1`, [ep.endpoint_id]);
    // No foreign key (D13): the row is still there, and still unreachable.
    expect((await pool.query(`SELECT 1 FROM incidents WHERE id = $1`, [id])).rowCount).toBe(1);
    expect((await get(`/incidents/${id}`, alice)).status).toBe(404);
    expect((await get('/incidents', alice)).body).toEqual([]);
  });
});

describe('listing', () => {
  async function three() {
    const ep = await endpointOf('alice@example.com');
    const other = await endpointOf('alice@example.com', '/other');
    const oldest = await incident(ep, {
      opened: '2033-03-10T08:00:00Z',
      confirmed: '2033-03-10T08:02:00Z',
      closed: '2033-03-10T08:10:00Z',
      closeConfirmed: '2033-03-10T08:11:00Z',
    });
    const middle = await incident(other, {
      opened: '2033-03-10T09:00:00Z',
      confirmed: '2033-03-10T09:02:00Z',
    });
    const newest = await incident(ep, {
      opened: '2033-03-10T10:00:00Z',
      confirmed: '2033-03-10T10:02:00Z',
    });
    return { ep, other, oldest, middle, newest };
  }

  const ids = (r: Res) => (r.body as { id: string }[]).map((i) => i.id);

  it('pages newest first, MAX_LIST_LIMIT at most, with the last id as the cursor', async () => {
    const { oldest, middle, newest } = await three();
    const first = await get('/incidents?limit=50', alice);
    expect(ids(first)).toEqual([newest, middle]);
    expect(ids(await get(`/incidents?cursor=${middle}`, alice))).toEqual([oldest]);
  });

  it('filters by status', async () => {
    const { oldest, middle, newest } = await three();
    expect(ids(await get('/incidents?status=closed', alice))).toEqual([oldest]);
    expect(ids(await get('/incidents?status=open', alice))).toEqual([newest, middle]);
  });

  it('scopes to one endpoint and to one service', async () => {
    const { ep, oldest, middle, newest } = await three();
    expect(ids(await get(`/endpoints/${ep.endpoint_id}/incidents`, alice))).toEqual([
      newest,
      oldest,
    ]);
    const service = await get(`/services/${ep.service_id}/incidents?status=open`, alice);
    expect(ids(service)).toEqual([newest, middle]);
  });

  it('refuses a malformed status, cursor or limit, and an unauthenticated caller', async () => {
    for (const q of ['status=broken', 'cursor=nope', 'limit=0', 'extra=1']) {
      const res = await get(`/incidents?${q}`, alice);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect((await get('/incidents/not-a-uuid', alice)).status).toBe(400);
    expect((await get('/incidents')).status).toBe(401);
  });
});
