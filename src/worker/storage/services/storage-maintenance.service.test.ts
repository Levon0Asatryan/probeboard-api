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

function make(partitions = fakePartitions()) {
  const logger = fakeLogger();
  const svc = new StorageMaintenanceService(partitions as never, cfg, logger);
  return { svc, partitions, logger };
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
});
