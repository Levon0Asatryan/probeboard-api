import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { RollupService, ROLLUP_STALE_TICKS } from './rollup.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  ROLLUP_TICK_MS: '1000',
  ROLLUP_BATCH_ROWS: '77',
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
  } as unknown as PinoLogger & {
    calls: { level: string; args: unknown[] }[];
  };
}

function make(pass: unknown = { skipped: false, folded: 0, lagMs: 0 }) {
  const repo = { runOnce: vi.fn().mockResolvedValue(pass) };
  const logger = fakeLogger();
  return { svc: new RollupService(repo as never, cfg, logger), repo, logger };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RollupService', () => {
  it('passes the configured batch size, and ticks on the configured interval until stopped', async () => {
    const { svc, repo } = make();
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.runOnce).toHaveBeenCalledWith(77);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.runOnce).toHaveBeenCalledTimes(2);
    await svc.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repo.runOnce).toHaveBeenCalledTimes(2);
  });

  it('never overlaps passes: the next is armed only after the previous settles', async () => {
    const { svc, repo } = make();
    let release!: () => void;
    repo.runOnce.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ skipped: false, folded: 0, lagMs: 0 });
        }),
    );
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(5000); // far longer than the tick
    expect(repo.runOnce).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.runOnce).toHaveBeenCalledTimes(2);
    await svc.stop();
  });

  it('logs a failed pass at error and never rejects, so one bad pass cannot end the loop', async () => {
    const { svc, repo, logger } = make();
    repo.runOnce.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.tick()).resolves.toBeUndefined();
    expect(logger.calls.some((c) => c.level === 'error')).toBe(true);
    await svc.tick();
    expect(repo.runOnce).toHaveBeenCalledTimes(2);
  });

  it('says nothing about a pass another worker already ran', async () => {
    const { svc, logger } = make({ skipped: true, folded: 0, lagMs: 0 });
    await svc.tick();
    expect(logger.calls).toEqual([]);
  });

  it('reports what it folded, and a stale watermark as a warning', async () => {
    const stale = make({ skipped: false, folded: 3, lagMs: ROLLUP_STALE_TICKS * 1000 + 1 });
    await stale.svc.tick();
    expect(stale.logger.calls.find((c) => c.level === 'info')?.args[0]).toEqual({ folded: 3 });
    expect(stale.logger.calls.some((c) => c.level === 'warn')).toBe(true);

    const fresh = make({ skipped: false, folded: 3, lagMs: 500 });
    await fresh.svc.tick();
    expect(fresh.logger.calls.some((c) => c.level === 'warn')).toBe(false);
  });
});
