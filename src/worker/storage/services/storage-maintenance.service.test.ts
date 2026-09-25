import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { StorageMaintenanceService } from './storage-maintenance.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  STORAGE_MAINTENANCE_INTERVAL_MS: '1000',
});

function fakeLogger() {
  const calls: { level: string; args: unknown[] }[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push({ level, args });
  return {
    calls,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
  } as unknown as PinoLogger & { calls: { level: string; args: unknown[] }[] };
}

function fakePartitions() {
  return {
    ensure: vi.fn().mockResolvedValue({ ran: true, created: ['a'] }),
    horizonDays: vi.fn().mockResolvedValue(3),
  };
}

function fakeRetention() {
  return {
    run: vi.fn().mockResolvedValue({ skipped: false, dropped: [], blocked: [], deferred: [] }),
  };
}

function make(partitions = fakePartitions(), retention = fakeRetention()) {
  const logger = fakeLogger();
  const svc = new StorageMaintenanceService(partitions as never, retention as never, cfg, logger);
  return { svc, partitions, retention, logger };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('StorageMaintenanceService', () => {
  it('runs a blocking first pass at init, and a failure rejects it so the worker does not start', async () => {
    const { svc, partitions } = make();
    partitions.ensure.mockRejectedValueOnce(new Error('cannot create partition'));
    await expect(svc.onModuleInit()).rejects.toThrow('cannot create partition');
    expect(partitions.ensure).toHaveBeenCalledWith(expect.any(Date), { wait: true });
  });

  it('re-runs on its interval, non-blocking, until destroyed', async () => {
    const { svc, partitions } = make();
    await svc.onModuleInit();
    expect(partitions.ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(partitions.ensure).toHaveBeenCalledTimes(2);
    expect(partitions.ensure).toHaveBeenLastCalledWith(expect.any(Date));
    await svc.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(partitions.ensure).toHaveBeenCalledTimes(2);
  });

  it('logs a failed tick and never rejects, so one bad pass cannot end the loop', async () => {
    const { svc, partitions, logger } = make();
    partitions.ensure.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.tick()).resolves.toBeUndefined();
    expect(logger.calls.some((c) => c.level === 'error')).toBe(true);
    await svc.tick();
    expect(partitions.ensure).toHaveBeenCalledTimes(2);
  });

  it('reports a horizon under one day as an error: inserts are about to fail', async () => {
    const { svc, partitions, logger } = make();
    partitions.horizonDays.mockResolvedValue(0.4);
    await svc.tick();
    expect(
      logger.calls.some((c) => c.level === 'error' && String(c.args[1]).includes('horizon')),
    ).toBe(true);
  });

  it('is quiet about a healthy horizon and about a pass another worker already ran', async () => {
    const { svc, partitions, logger } = make();
    partitions.ensure.mockResolvedValue({ ran: false, created: [] });
    await svc.tick();
    expect(logger.calls.filter((c) => c.level === 'error')).toEqual([]);
  });

  it('runs retention after partition creation on every tick', async () => {
    const { svc, retention } = make();
    await svc.tick(new Date('2026-09-24T00:00:00Z'));
    expect(retention.run).toHaveBeenCalledWith(new Date('2026-09-24T00:00:00Z'));
  });

  it('still runs retention when partition creation failed, and still creates when retention fails', async () => {
    const a = make();
    a.partitions.ensure.mockRejectedValueOnce(new Error('ddl'));
    await a.svc.tick();
    expect(a.retention.run).toHaveBeenCalledOnce();

    const b = make();
    b.retention.run.mockRejectedValueOnce(new Error('drop'));
    await expect(b.svc.tick()).resolves.toBeUndefined();
    expect(b.partitions.ensure).toHaveBeenCalledOnce();
    expect(b.logger.calls.some((c) => c.level === 'error')).toBe(true);
  });

  it('reports a partition the guard refused to drop at error, naming it', async () => {
    const { svc, retention, logger } = make();
    retention.run.mockResolvedValue({
      skipped: false,
      dropped: [],
      blocked: [{ partition: 'probe_results_p20260101', reason: 'unfolded rows' }],
      deferred: [],
    });
    await svc.tick();
    const e = logger.calls.find((c) => c.level === 'error');
    expect(e?.args[0]).toEqual({ partition: 'probe_results_p20260101' });
    expect(String(e?.args[1])).toMatch(/refused to drop: unfolded rows/);
  });

  it('says nothing when another worker held the retention lock', async () => {
    const { svc, retention, logger } = make();
    retention.run.mockResolvedValue({ skipped: true, dropped: [], blocked: [], deferred: [] });
    await svc.tick();
    expect(logger.calls.filter((c) => c.level === 'error')).toEqual([]);
  });
});
