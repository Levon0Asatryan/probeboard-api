import { promises as dns } from 'node:dns';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { startDnsServer } from '../../../testing/dns-server.js';
import { EndpointRuntimeRepository } from '../../scheduler/repositories/endpoint-runtime.repository.js';
import { SchedulerService } from '../../scheduler/scheduler.service.js';
import { MonitorLoaderService } from '../../scheduler/services/monitor-loader.service.js';
import { ProbePoolService } from '../../scheduler/services/probe-pool.service.js';
import { ResultRecorderService } from '../../scheduler/services/result-recorder.service.js';
import { ProbeResultRepository } from '../../storage/repositories/probe-result.repository.js';
import { EvaluatorRepository } from '../repositories/evaluator.repository.js';

/**
 * **A DNS outage opens an incident** (docs/m6-plan.md §7, a bold row), proved
 * the way CLAUDE.md asks of a mapping from external signals: through the real
 * transport. The guard is on, the production resolver (`createProbeDeps`, the
 * process-wide c-ares one) is pointed at a name server answering `SERVFAIL`,
 * and three slots run through the real scheduler -- claim, load, `probe()`,
 * classify, write, release -- before the real evaluator pass reads them.
 *
 * Before #74 a SERVFAIL stored `unknown / unknown_error`, which the state
 * machine rightly never counts: every DNS outage would have been invisible.
 */
const { db, pool: pg, close } = connectTestDb();
const dbLike = { kysely: db } as never;
const originalServers = dns.getServers();

const noop = () => undefined;
const logger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
} as unknown as PinoLogger;

afterAll(async () => {
  dns.setServers(originalServers);
  await close();
});

beforeEach(async () => {
  await truncateAll(pg);
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('a DNS outage, through the real resolver, scheduler and writer', () => {
  it('stores down / dns_failure / ESERVFAIL for each slot, and opens one incident timed from the first', async () => {
    const nameServer = await startDnsServer('servfail');
    dns.setServers([`127.0.0.1:${String(nameServer.port)}`]);

    const cfg = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
      // On: resolution happens in the guard, which is where #74 classified it.
      SSRF_GUARD_ENABLED: 'true',
      SCHEDULER_TICK_MS: '100',
      SCHEDULER_LOAD_BUDGET_MS: '100',
      PROBE_MAX_TIMEOUT_MS: '1000',
      PROBE_DEFAULT_TIMEOUT_MS: '1000',
      SCHEDULER_LEASE_SLACK_MS: '1000',
      SCHEDULER_LEASE_MS: '2500',
      SCHEDULER_SHUTDOWN_GRACE_MS: '1500',
    });
    const runtime = new EndpointRuntimeRepository(dbLike);
    const scheduler = new SchedulerService(
      cfg,
      runtime,
      new ProbePoolService(cfg, logger),
      new MonitorLoaderService(dbLike, cfg),
      new ResultRecorderService(dbLike, new ProbeResultRepository(dbLike), runtime, cfg),
      logger,
    );

    const user = await pg.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('dns@example.com', 'x') RETURNING id`,
    );
    const service = await pg.query<{ id: string }>(
      `INSERT INTO services (user_id, name, base_url) VALUES ($1, 's', 'http://outage.test:8080') RETURNING id`,
      [user.rows[0].id],
    );
    const endpoint = await pg.query<{ id: string }>(
      `INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
       VALUES ($1, $2, 'GET', '/', 60, 1000, 5) RETURNING id`,
      [service.rows[0].id, user.rows[0].id],
    );
    const endpointId = endpoint.rows[0].id;
    await pg.query(
      `INSERT INTO endpoint_runtime (endpoint_id, next_run_at, scheduled_interval_s)
       VALUES ($1, now() - interval '1 second', 60)`,
      [endpointId],
    );

    const stored = async () =>
      (
        await pg.query<{
          started_at: Date;
          outcome: string;
          failure_class: string;
          failure_code: string;
        }>(
          `SELECT started_at, outcome, failure_class, failure_code
             FROM probe_results WHERE endpoint_id = $1 ORDER BY started_at`,
          [endpointId],
        )
      ).rows;

    scheduler.start();
    try {
      for (let slot = 1; slot <= 3; slot += 1) {
        await waitUntil(async () => (await stored()).length === slot, 5000, `slot ${slot} stored`);
        if (slot < 3) {
          // The next slot, now rather than in 60 s: due again once released.
          await waitUntil(
            async () =>
              (
                await pg.query(
                  `UPDATE endpoint_runtime SET next_run_at = now() - interval '1 second'
                    WHERE endpoint_id = $1 AND leased_by IS NULL`,
                  [endpointId],
                )
              ).rowCount === 1,
            5000,
            `slot ${slot} released`,
          );
        }
      }
    } finally {
      await scheduler.stop();
      dns.setServers(originalServers);
      await nameServer.close();
    }

    const rows = await stored();
    expect(rows.map((r) => [r.outcome, r.failure_class, r.failure_code])).toEqual([
      ['down', 'dns_failure', 'ESERVFAIL'],
      ['down', 'dns_failure', 'ESERVFAIL'],
      ['down', 'dns_failure', 'ESERVFAIL'],
    ]);
    // The resolver really asked, so the class came from c-ares, not a stub.
    expect(nameServer.queries()).toBeGreaterThanOrEqual(3);

    // The evaluator's watermark starts at the migration's horizon; these
    // results committed after it, so one pass reads all three.
    const pass = await new EvaluatorRepository(dbLike).runOnce({
      batchXids: 5000,
      unknownGraceMs: 90_000,
    });
    expect(pass.opened).toHaveLength(1);
    const { rows: incidents } = await pg.query<{
      opened_at: Date;
      confirmed_at: Date;
      cause_class: string;
      cause_code: string;
    }>(
      `SELECT opened_at, confirmed_at, cause_class, cause_code FROM incidents WHERE endpoint_id = $1`,
      [endpointId],
    );
    expect(incidents).toEqual([
      {
        opened_at: rows[0].started_at,
        confirmed_at: rows[2].started_at,
        cause_class: 'dns_failure',
        cause_code: 'ESERVFAIL',
      },
    ]);
  }, 20_000);
});
