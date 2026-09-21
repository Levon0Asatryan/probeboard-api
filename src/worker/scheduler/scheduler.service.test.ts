import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../core/config/index.js';
import type { ClaimedSlot } from './repositories/endpoint-runtime.repository.js';

const probeMock = vi.hoisted(() => vi.fn());
vi.mock('../probing/index.js', async () => {
  const actual = await vi.importActual<typeof import('../probing/index.js')>('../probing/index.js');
  return { ...actual, probe: probeMock };
});

const { SchedulerService, slotKey } = await import('./scheduler.service.js');

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  WORKER_ID: 'worker-1',
  SCHEDULER_TICK_MS: '1000',
  SCHEDULER_LOAD_BUDGET_MS: '100',
});

function fakeLogger(): PinoLogger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  return {
    calls,
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
    trace: (...args: unknown[]) => calls.push({ level: 'trace', args }),
    fatal: (...args: unknown[]) => calls.push({ level: 'fatal', args }),
  } as unknown as PinoLogger & { calls: { level: string; args: unknown[] }[] };
}

function fakeRepo() {
  return {
    adopt: vi.fn().mockResolvedValue(0),
    reconcile: vi.fn().mockResolvedValue(0),
    claim: vi.fn().mockResolvedValue([]),
    release: vi.fn().mockResolvedValue(1),
    abandon: vi.fn().mockResolvedValue(1),
  };
}

function fakePool(available = 10) {
  const started: { key: string; work: Promise<void> }[] = [];
  return {
    available,
    started,
    start: vi.fn((key: string, work: Promise<void>) => {
      started.push({ key, work });
      // Swallow rejections here too, same as the real pool, so a test that
      // does not await `started[i].work` does not fail on an unhandled
      // rejection warning.
      work.catch(() => {});
    }),
    drain: vi.fn().mockResolvedValue({ settled: [], stillRunning: [] }),
  };
}

function fakeLoader(config: unknown = sampleConfig()) {
  return { load: vi.fn().mockResolvedValue(config) };
}

function sampleConfig() {
  return {
    monitorId: 'e1',
    url: 'https://example.test/',
    method: 'GET',
    headers: {},
    expectedStatus: [],
    assertions: [],
    timeoutMs: 5000,
    followRedirects: true,
    maxRedirects: 5,
  };
}

function row(over: Partial<ClaimedSlot> = {}): ClaimedSlot {
  return {
    endpoint_id: 'e1',
    scheduled_at: '2026-01-01 00:00:00+00',
    next_run_at: new Date('2026-01-01T00:01:00Z'),
    ...over,
  };
}

function makeService(
  overrides: {
    repo?: ReturnType<typeof fakeRepo>;
    pool?: ReturnType<typeof fakePool>;
    loader?: ReturnType<typeof fakeLoader>;
    logger?: ReturnType<typeof fakeLogger>;
  } = {},
) {
  const repo = overrides.repo ?? fakeRepo();
  const pool = overrides.pool ?? fakePool();
  const loader = overrides.loader ?? fakeLoader();
  const logger = overrides.logger ?? fakeLogger();
  const svc = new SchedulerService(cfg, repo as never, pool as never, loader as never, logger);
  return { svc, repo, pool, loader, logger };
}

beforeEach(() => {
  vi.useFakeTimers();
  probeMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('slotKey', () => {
  it('is endpointId:scheduledAt, matching the fence every repository write binds on', () => {
    expect(slotKey({ endpoint_id: 'e1', scheduled_at: 't1' })).toBe('e1:t1');
  });
});

describe('SchedulerService: the tick', () => {
  it('claims nothing when the pool has no capacity, without ever calling claim() (NFR-1)', async () => {
    const { svc, repo } = makeService({ repo: fakeRepo(), pool: fakePool(0) });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.claim).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('claims min(batchSize, capacity) when the pool has room', async () => {
    const { svc, repo } = makeService({ pool: fakePool(3) });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.claim).toHaveBeenCalledWith('worker-1', cfg.SCHEDULER_LEASE_MS, 3);
    await svc.stop();
  });

  it('D19: a rejecting adopt() does not stop reconcile() or claim() running the same tick', async () => {
    const repo = fakeRepo();
    repo.adopt.mockRejectedValue(new Error('adopt boom'));
    const { svc, logger } = makeService({ repo });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.reconcile).toHaveBeenCalledOnce();
    expect(repo.claim).toHaveBeenCalledOnce();
    expect(logger.calls.some((c) => c.level === 'error')).toBe(true);
    await svc.stop();
  });

  it('D19: a rejecting reconcile() does not stop claim() running the same tick', async () => {
    const repo = fakeRepo();
    repo.reconcile.mockRejectedValue(new Error('reconcile boom'));
    const { svc } = makeService({ repo });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.claim).toHaveBeenCalledOnce();
    await svc.stop();
  });

  it('D19: a persistently failing adopt() still lets every subsequent tick claim', async () => {
    const repo = fakeRepo();
    repo.adopt.mockRejectedValue(new Error('adopt boom'));
    const { svc } = makeService({ repo });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(cfg.SCHEDULER_TICK_MS);
    await vi.advanceTimersByTimeAsync(cfg.SCHEDULER_TICK_MS);
    expect(repo.claim.mock.calls.length).toBeGreaterThanOrEqual(3);
    await svc.stop();
  });

  it('re-arms after the tick settles, and never overlaps: claim is not called again mid-tick', async () => {
    const repo = fakeRepo();
    let resolveClaim!: (rows: ClaimedSlot[]) => void;
    repo.claim.mockImplementationOnce(
      () =>
        new Promise<ClaimedSlot[]>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const { svc } = makeService({ repo });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.claim).toHaveBeenCalledOnce();

    // The tick interval elapses while the first claim is still pending.
    await vi.advanceTimersByTimeAsync(cfg.SCHEDULER_TICK_MS * 3);
    expect(repo.claim).toHaveBeenCalledOnce(); // still just the one -- no overlap

    resolveClaim([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(cfg.SCHEDULER_TICK_MS);
    expect(repo.claim.mock.calls.length).toBeGreaterThanOrEqual(2); // resumes once settled

    await svc.stop();
  });
});

describe('SchedulerService: one claimed slot', () => {
  it('loads, probes, and releases on a successful outcome', async () => {
    probeMock.mockResolvedValue({ monitorId: 'e1', success: true, startedAt: Date.now() });
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    const pool = fakePool(1);
    const { svc } = makeService({ repo, pool });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.started).toHaveLength(1);
    await pool.started[0].work;
    expect(repo.release).toHaveBeenCalledWith('e1', 'worker-1', row().scheduled_at);
    expect(repo.abandon).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('abandons the slot when the loader rejects, and never releases it', async () => {
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    const pool = fakePool(1);
    const loader = fakeLoader();
    loader.load.mockRejectedValue(new Error('load boom'));
    const { svc } = makeService({ repo, pool, loader });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await pool.started[0].work;
    expect(repo.abandon).toHaveBeenCalledWith('e1', 'worker-1', row().scheduled_at);
    expect(repo.release).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('D20: abandons the slot when the loader overruns SCHEDULER_LOAD_BUDGET_MS, without probing', async () => {
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    const pool = fakePool(1);
    const loader = fakeLoader();
    loader.load.mockImplementation(() => new Promise(() => {})); // never settles
    const { svc } = makeService({ repo, pool, loader });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(cfg.SCHEDULER_LOAD_BUDGET_MS);
    await pool.started[0].work;
    expect(repo.abandon).toHaveBeenCalledWith('e1', 'worker-1', row().scheduled_at);
    expect(probeMock).not.toHaveBeenCalled();
    await svc.stop();
  });

  it("abandons the slot when probe() throws, honouring M3's never-rejects contract as a bug, not an endpoint failure", async () => {
    probeMock.mockRejectedValue(new Error('probe bug'));
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    const pool = fakePool(1);
    const { svc } = makeService({ repo, pool });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await pool.started[0].work;
    expect(repo.abandon).toHaveBeenCalledWith('e1', 'worker-1', row().scheduled_at);
    expect(repo.release).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('D23: a rejecting release() does not escape runOne as an unhandled rejection', async () => {
    probeMock.mockResolvedValue({ monitorId: 'e1', success: true, startedAt: Date.now() });
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    repo.release.mockRejectedValue(new Error('db down'));
    const pool = fakePool(1);
    const { svc, logger } = makeService({ repo, pool });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pool.started[0].work).resolves.toBeUndefined();
    // Specifically the inner guard's own message, not the outer dispatch
    // backstop's ('runOne rejected -- a D23 violation') -- the backstop
    // would also make `work` resolve, so asserting only that masks the
    // inner guard being removed.
    expect(logger.calls.some((c) => String(c.args[1]).includes('release failed'))).toBe(true);
    expect(logger.calls.some((c) => String(c.args[1]).includes('D23 violation'))).toBe(false);
    await svc.stop();
  });

  it('D23: a rejecting abandon() does not escape runOne as an unhandled rejection', async () => {
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    repo.abandon.mockRejectedValue(new Error('db down'));
    const pool = fakePool(1);
    const loader = fakeLoader();
    loader.load.mockRejectedValue(new Error('load boom'));
    const { svc, logger } = makeService({ repo, pool, loader });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pool.started[0].work).resolves.toBeUndefined();
    expect(logger.calls.some((c) => String(c.args[1]).includes('abandon failed'))).toBe(true);
    expect(logger.calls.some((c) => String(c.args[1]).includes('D23 violation'))).toBe(false);
    await svc.stop();
  });

  it('warns, but does not throw, when release matches zero rows', async () => {
    probeMock.mockResolvedValue({ monitorId: 'e1', success: true, startedAt: Date.now() });
    const repo = fakeRepo();
    repo.claim.mockResolvedValueOnce([row()]);
    repo.release.mockResolvedValue(0);
    const pool = fakePool(1);
    const { svc, logger } = makeService({ repo, pool });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await pool.started[0].work;
    expect(logger.calls.some((c) => c.level === 'warn')).toBe(true);
    await svc.stop();
  });
});

describe('SchedulerService: stop', () => {
  it('clears the timer so no further tick runs', async () => {
    const { svc, repo } = makeService();
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = repo.claim.mock.calls.length;
    await svc.stop();
    await vi.advanceTimersByTimeAsync(cfg.SCHEDULER_TICK_MS * 5);
    expect(repo.claim.mock.calls.length).toBe(callsBeforeStop);
  });

  it('drains the pool with SCHEDULER_SHUTDOWN_GRACE_MS and logs a warning for anything still running', async () => {
    const pool = fakePool();
    pool.drain.mockResolvedValue({ settled: [], stillRunning: ['e2:slot'] });
    const { svc, logger } = makeService({ pool });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await svc.stop();
    expect(pool.drain).toHaveBeenCalledWith(cfg.SCHEDULER_SHUTDOWN_GRACE_MS);
    expect(logger.calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('is idempotent: a second concurrent call does not drain twice', async () => {
    const pool = fakePool();
    const { svc } = makeService({ pool });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = [svc.stop(), svc.stop()];
    await Promise.all([a, b]);
    expect(pool.drain).toHaveBeenCalledOnce();
  });
});
