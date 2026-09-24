import type { PinoLogger } from 'nestjs-pino';
import { Client } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import {
  respond,
  startServer,
  type Handler,
  type TestServer,
} from '../../../testing/probe-server.js';
import { EndpointRuntimeRepository } from '../repositories/endpoint-runtime.repository.js';
import { SchedulerService } from '../scheduler.service.js';
import { MonitorLoaderService } from '../services/monitor-loader.service.js';
import { ProbePoolService } from '../services/probe-pool.service.js';
import { ResultRecorderService } from '../services/result-recorder.service.js';
import { ProbeResultRepository } from '../../storage/repositories/probe-result.repository.js';

/**
 * `SchedulerService` end to end: two live workers, real Postgres, real
 * sockets. This is where the milestone's exit test lives -- "two workers
 * probe nothing twice, and killing one mid-probe makes its claimed work
 * available to the other within a bounded time" -- driven through the
 * actual tick loop, not the repository directly (that is PR 2's job).
 *
 * Every scheduler timing is configured small and valid, not left at the
 * production defaults (§5's cross-field rules still apply, checked at
 * `loadConfig`), so the suite runs in seconds rather than the production
 * lease's 60s+.
 */

const HEADER_KEY = 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=';

function fakeLogger(): PinoLogger {
  const noop = () => undefined;
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  } as unknown as PinoLogger;
}

/** Small, valid scheduler timings (§5's inequalities), for a fast suite. */
function testConfig(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    HEADER_ENCRYPTION_KEY: HEADER_KEY,
    SSRF_GUARD_ENABLED: 'false', // targets 127.0.0.1 (D19 of M3's guard, out of scope here)
    SCHEDULER_TICK_MS: '100',
    SCHEDULER_LOAD_BUDGET_MS: '100',
    PROBE_MAX_TIMEOUT_MS: '1000',
    PROBE_DEFAULT_TIMEOUT_MS: '1000',
    SCHEDULER_LEASE_SLACK_MS: '1000',
    SCHEDULER_LEASE_MS: '2500', // >= 100 + 1000 + 1000
    SCHEDULER_SHUTDOWN_GRACE_MS: '1500', // >= 100 + 1000, and < lease
    PROBE_CONCURRENCY: '50',
    ...over,
  });
}

interface Worker {
  cfg: AppConfig;
  repo: EndpointRuntimeRepository;
  pool: ProbePoolService;
  scheduler: SchedulerService;
}

function makeWorker(kysely: unknown, workerId: string, over: Record<string, string> = {}): Worker {
  const cfg = testConfig({ WORKER_ID: workerId, ...over });
  const dbLike = { kysely } as never;
  const repo = new EndpointRuntimeRepository(dbLike);
  const pool = new ProbePoolService(cfg, fakeLogger());
  const loader = new MonitorLoaderService(dbLike, cfg);
  const recorder = new ResultRecorderService(dbLike, new ProbeResultRepository(dbLike), repo, cfg);
  const scheduler = new SchedulerService(cfg, repo, pool, loader, recorder, fakeLogger());
  return { cfg, repo, pool, scheduler };
}

const { db, pool: pg, close } = connectTestDb();
const servers: TestServer[] = [];

afterAll(async () => {
  await close();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

let userId: string;

beforeEach(async () => {
  await truncateAll(pg);
  serviceIdByOrigin.clear();
  const user = await pg.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('e2e@example.com', 'x') RETURNING id`,
  );
  userId = user.rows[0].id;
});

/**
 * One service per origin, reused across endpoints that share a test server.
 * Caches the *promise*, not the resolved id: several endpoints for the same
 * origin are often created concurrently (`Promise.all`), and caching only
 * the resolved value lets two calls both see "not yet cached" and both
 * insert, tripping `services_user_base_url_key`.
 */
const serviceIdByOrigin = new Map<string, Promise<string>>();

function serviceFor(origin: string): Promise<string> {
  const existing = serviceIdByOrigin.get(origin);
  if (existing) return existing;
  const created = pg
    .query<{ id: string }>(
      `INSERT INTO services (user_id, name, base_url) VALUES ($1, 's', $2) RETURNING id`,
      [userId, origin],
    )
    .then((r) => r.rows[0].id);
  serviceIdByOrigin.set(origin, created);
  return created;
}

async function serve(handler: Handler): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

/** One endpoint, due now, pointed at `origin`. */
async function makeDueEndpoint(
  origin: string,
  opts: { intervalS?: number; dueInS?: number } = {},
): Promise<string> {
  const serviceId = await serviceFor(origin);
  const path = `/p${String(Math.random()).slice(2)}`;
  const endpoint = await pg.query<{ id: string }>(
    `INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     VALUES ($1, $2, 'GET', $3, $4, 5000, 5) RETURNING id`,
    [serviceId, userId, path, opts.intervalS ?? 60],
  );
  const id = endpoint.rows[0].id;
  await pg.query(
    `INSERT INTO endpoint_runtime (endpoint_id, next_run_at, scheduled_interval_s)
     VALUES ($1, now() + make_interval(secs => $2::float8), $3)`,
    [id, opts.dueInS ?? -1, opts.intervalS ?? 60],
  );
  return id;
}

interface RuntimeRow {
  leased_by: string | null;
  leased_until: Date | null;
  last_probe_at: Date | null;
  scheduled_at: Date | null;
}

async function runtimeRow(endpointId: string): Promise<RuntimeRow> {
  const { rows } = await pg.query<RuntimeRow>(
    `SELECT leased_by, leased_until, last_probe_at, scheduled_at FROM endpoint_runtime WHERE endpoint_id = $1`,
    [endpointId],
  );
  return rows[0];
}

async function claimLogRows(
  endpointId: string,
): Promise<{ worker_id: string; scheduled_at: Date }[]> {
  const { rows } = await pg.query<{ worker_id: string; scheduled_at: Date }>(
    `SELECT worker_id, scheduled_at FROM claim_log WHERE endpoint_id = $1 ORDER BY claimed_at`,
    [endpointId],
  );
  return rows;
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('two workers: disjointness (NFR-3)', () => {
  it('probes each of 10 due endpoints exactly once between them, and every last_probe_at advances', async () => {
    const server = await serve(respond('ok'));
    const ids = await Promise.all(Array.from({ length: 10 }, () => makeDueEndpoint(server.origin)));

    const a = makeWorker(db, 'e2e-worker-a');
    const b = makeWorker(db, 'e2e-worker-b');
    a.scheduler.start();
    b.scheduler.start();

    try {
      await waitUntil(
        async () => {
          const rows = await Promise.all(ids.map((id) => runtimeRow(id)));
          return rows.every((r) => r.last_probe_at !== null);
        },
        5000,
        'every endpoint probed once',
      );
    } finally {
      await Promise.all([a.scheduler.stop(), b.scheduler.stop()]);
    }

    // The plan's own disjointness evidence (§9): no (endpoint_id,
    // scheduled_at) was ever claimed twice, whichever worker made the claim.
    const { rows: dupes } = await pg.query(
      `SELECT endpoint_id, scheduled_at, count(*) FROM claim_log
       WHERE endpoint_id = ANY($1) GROUP BY 1, 2 HAVING count(*) > 1`,
      [ids],
    );
    expect(dupes).toEqual([]);

    expect(server.received.length).toBe(10);
  }, 10_000);
});

describe('results (M5): every claimed slot yields one stored result', () => {
  it('stores exactly one probe_results row per claim, keyed to the claimed slot, with the lease cleared in the same commit', async () => {
    const server = await serve(respond('ok'));
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => makeDueEndpoint(server.origin, { intervalS: 60 })),
    );
    const a = makeWorker(db, 'e2e-worker-a');
    const b = makeWorker(db, 'e2e-worker-b');
    a.scheduler.start();
    b.scheduler.start();
    try {
      await waitUntil(
        async () => {
          const rows = await Promise.all(ids.map((id) => runtimeRow(id)));
          return rows.every((r) => r.last_probe_at !== null);
        },
        5000,
        'every endpoint probed and released',
      );
    } finally {
      await Promise.all([a.scheduler.stop(), b.scheduler.stop()]);
    }

    // The claim <-> result join the plan's verification relies on, at
    // microsecond fidelity: scheduled_at is compared as text, so a value
    // round-tripped through a JS Date would not match.
    const { rows } = await pg.query<{ endpoint_id: string; n: string; outcome: string }>(
      `SELECT c.endpoint_id, count(r.*) AS n, min(r.outcome::text) AS outcome
         FROM claim_log c
         LEFT JOIN probe_results r
                ON r.endpoint_id = c.endpoint_id AND r.scheduled_at = c.scheduled_at
        WHERE c.endpoint_id = ANY($1)
        GROUP BY c.endpoint_id, c.scheduled_at`,
      [ids],
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.n).toBe('1');
      expect(r.outcome).toBe('up');
    }

    const stored = await pg.query<{
      interval_s: number;
      status_code: number;
      worker_id: string;
      ttfb_ms: number | null;
    }>(
      `SELECT interval_s, status_code, worker_id, ttfb_ms FROM probe_results WHERE endpoint_id = $1`,
      [ids[0]],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].interval_s).toBe(60);
    expect(stored.rows[0].status_code).toBe(200);
    expect(stored.rows[0].ttfb_ms).not.toBeNull();
    // Cleared by the same transaction that stored the result.
    const rt = await runtimeRow(ids[0]);
    expect(rt.leased_by).toBeNull();
    expect(rt.leased_until).toBeNull();
  }, 10_000);
});

describe('results (M5): a stale slot still lands in a current partition (D20)', () => {
  it('stores the result of a monitor resumed after days paused: the slot is old, started_at is now', async () => {
    const server = await serve(respond('ok'));
    // Paused for five days: its next_run_at is five days in the past, so the
    // claim's scheduled_at is that stale slot. Partitioned on scheduled_at this
    // would target a partition that does not exist; started_at is what files it.
    const id = await makeDueEndpoint(server.origin, { dueInS: -5 * 86_400 });
    const w = makeWorker(db, 'e2e-worker-resume');
    w.scheduler.start();
    try {
      await waitUntil(
        async () => (await runtimeRow(id)).last_probe_at !== null,
        5000,
        'resumed endpoint probed',
      );
    } finally {
      await w.scheduler.stop();
    }
    const { rows } = await pg.query<{ stale_days: number; fresh: boolean }>(
      `SELECT extract(day from now() - scheduled_at)::int AS stale_days,
              started_at > now() - interval '1 minute' AS fresh
         FROM probe_results WHERE endpoint_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stale_days).toBeGreaterThanOrEqual(4);
    expect(rows[0].fresh).toBe(true);
  }, 10_000);
});

describe('capacity (NFR-1), live', () => {
  it('never runs more than PROBE_CONCURRENCY probes at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const server = await serve((_req, res) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200);
        res.end('ok');
      }, 150);
    });
    const ids = await Promise.all(Array.from({ length: 4 }, () => makeDueEndpoint(server.origin)));

    const worker = makeWorker(db, 'e2e-worker-solo', { PROBE_CONCURRENCY: '1' });
    worker.scheduler.start();
    try {
      await waitUntil(
        async () => {
          const rows = await Promise.all(ids.map((id) => runtimeRow(id)));
          return rows.every((r) => r.last_probe_at !== null);
        },
        8000,
        'all four endpoints probed with concurrency 1',
      );
    } finally {
      await worker.scheduler.stop();
    }
    expect(peak).toBe(1);
  }, 10_000);
});

describe('reclaim (D6, D5): a slot a worker claimed and never returned to', () => {
  it('is not claimable before the bound, and is claimed (once) after it -- below-lease regime', async () => {
    const server = await serve(respond('ok'));
    // interval (1s) < lease (2.5s): the lease is the binding term (D6).
    const id = await makeDueEndpoint(server.origin, { intervalS: 1, dueInS: -1 });

    const dead = makeWorker(db, 'e2e-worker-dead');
    const before = await dead.repo.claim('e2e-worker-dead', dead.cfg.SCHEDULER_LEASE_MS, 10);
    expect(before.map((r) => r.endpoint_id)).toEqual([id]); // the "dead" worker's claim commits...
    // ...and nothing more ever runs for it: no loader, no probe, no release.
    // That is the simulated kill -- the row is left leased exactly as a
    // killed process would leave it.

    const survivor = makeWorker(db, 'e2e-worker-survivor');
    survivor.scheduler.start();
    try {
      // Not claimable while the lease still holds.
      await new Promise((r) => setTimeout(r, 500));
      let row = await runtimeRow(id);
      expect(row.leased_by).toBe('e2e-worker-dead');

      // Claimable once the lease lapses (~2.5s), bounded by one more tick.
      await waitUntil(
        async () => (await runtimeRow(id)).last_probe_at !== null,
        5000,
        'reclaimed and probed',
      );
      row = await runtimeRow(id);
      expect(row.leased_by).toBeNull(); // released by the survivor after probing
    } finally {
      await survivor.scheduler.stop();
    }

    const log = await claimLogRows(id);
    expect(log.map((r) => r.worker_id)).toEqual(['e2e-worker-dead', 'e2e-worker-survivor']);
    // Same slot claimed twice on paper (the dead worker's claim and the
    // reclaim), but D5 means it is a *different* slot -- next_run_at moved
    // on at claim time, so the reclaim is for the slot after the one the
    // dead worker held, not a second attempt at the same one.
    expect(log[0].scheduled_at).not.toEqual(log[1].scheduled_at);
  }, 10_000);

  it('is claimed only once the interval elapses, not at the lease -- above-lease regime', async () => {
    const server = await serve(respond('ok'));
    // interval (4s) > lease (2.5s): the interval is the binding term (D6).
    const id = await makeDueEndpoint(server.origin, { intervalS: 4, dueInS: -1 });

    const dead = makeWorker(db, 'e2e-worker-dead2');
    await dead.repo.claim('e2e-worker-dead2', dead.cfg.SCHEDULER_LEASE_MS, 10);

    const survivor = makeWorker(db, 'e2e-worker-survivor2');
    survivor.scheduler.start();
    try {
      // Still not claimable well past the lease (2.5s) -- the interval governs.
      await new Promise((r) => setTimeout(r, 3000));
      const stillLeased = await runtimeRow(id);
      expect(stillLeased.last_probe_at).toBeNull();

      await waitUntil(
        async () => (await runtimeRow(id)).last_probe_at !== null,
        4000,
        'reclaimed at the interval',
      );
    } finally {
      await survivor.scheduler.stop();
    }

    const log = await claimLogRows(id);
    expect(log.map((r) => r.worker_id)).toEqual(['e2e-worker-dead2', 'e2e-worker-survivor2']);
  }, 12_000);
});

describe('shutdown (§3.9)', () => {
  it('releases a probe that settles within the grace, so the row is available immediately', async () => {
    const server = await serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 300); // well within the 1500ms grace
    });
    const id = await makeDueEndpoint(server.origin);

    const worker = makeWorker(db, 'e2e-worker-graceful');
    worker.scheduler.start();
    await waitUntil(() => Promise.resolve(worker.pool.size > 0), 2000, 'probe started');
    await worker.scheduler.stop();

    const row = await runtimeRow(id);
    expect(row.leased_by).toBeNull();
    expect(row.last_probe_at).not.toBeNull();
  }, 8000);

  it('leaves the lease in place when its release write is still blocked when the grace expires', async () => {
    // §5's boot-time inequality (SCHEDULER_SHUTDOWN_GRACE_MS >=
    // SCHEDULER_LOAD_BUDGET_MS + PROBE_MAX_TIMEOUT_MS) means the probe's own
    // network timeout can never outlive the grace -- that is what the
    // inequality is *for*. The term that can still outlive it is the release
    // round trip itself (§3.5's "teardown + release round trip"), so that is
    // what this test blocks: a competing row lock, held on a second
    // connection, delays the release `UPDATE` past the grace.
    const server = await serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 300); // settles well inside the grace; only the release write is blocked
    });
    const id = await makeDueEndpoint(server.origin);

    const worker = makeWorker(db, 'e2e-worker-abrupt');
    worker.scheduler.start();
    await waitUntil(() => Promise.resolve(worker.pool.size > 0), 2000, 'probe started');

    const blocker = new Client({ connectionString: testDatabaseUrl() });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM endpoint_runtime WHERE endpoint_id = $1 FOR UPDATE', [id]);

    await worker.scheduler.stop(); // 1500ms grace; the release stays blocked throughout

    const row = await runtimeRow(id);
    expect(row.leased_by).toBe('e2e-worker-abrupt'); // kept, not cleared
    expect(row.last_probe_at).toBeNull(); // the release UPDATE never committed

    await blocker.query('ROLLBACK');
    await blocker.end();
  }, 8000);
});
