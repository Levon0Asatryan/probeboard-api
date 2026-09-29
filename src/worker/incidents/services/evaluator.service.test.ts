import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import type { EvaluatorPass } from '../repositories/evaluator.repository.js';
import { EvaluatorService } from './evaluator.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  EVALUATOR_TICK_MS: '1000',
  EVALUATOR_BATCH_XIDS: '77',
  EVALUATOR_STALE_TICKS: '10',
  UNKNOWN_GRACE_MS: '120000',
});

const EMPTY: EvaluatorPass = {
  skipped: false,
  evaluated: 0,
  late: 0,
  opened: [],
  closed: [],
  markedUnknown: 0,
  orphansRemoved: 0,
  lagMs: 0,
};

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

function make(pass: Partial<EvaluatorPass> = {}) {
  const repo = { runOnce: vi.fn().mockResolvedValue({ ...EMPTY, ...pass }) };
  const logger = fakeLogger();
  return { svc: new EvaluatorService(repo as never, cfg, logger), repo, logger };
}

const messages = (logger: ReturnType<typeof fakeLogger>, level: string) =>
  logger.calls.filter((c) => c.level === level).map((c) => c.args[1]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EvaluatorService', () => {
  it('passes the configured batch and grace, and ticks on the configured interval until stopped', async () => {
    const { svc, repo } = make();
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.runOnce).toHaveBeenCalledWith({ batchXids: 77, unknownGraceMs: 120_000 });
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
          release = () => resolve(EMPTY);
        }),
    );
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(5000);
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
    expect(messages(logger, 'error')).toEqual([
      'evaluator pass failed; nothing was applied, retrying next tick',
    ]);
  });

  it('logs each opened and closed incident with its endpoint', async () => {
    const { svc, logger } = make({
      opened: [{ endpointId: 'e1', incidentId: 'i1' }],
      closed: [{ endpointId: 'e2', incidentId: 'i2' }],
    });
    await svc.tick();
    const info = logger.calls.filter((c) => c.level === 'info');
    expect(info.map((c) => c.args)).toEqual([
      [{ endpointId: 'e1', incidentId: 'i1' }, 'incident opened'],
      [{ endpointId: 'e2', incidentId: 'i2' }, 'incident closed'],
    ]);
  });

  it('warns about late results and about a stale watermark, and says nothing when skipped', async () => {
    const late = make({ late: 2 });
    await late.svc.tick();
    expect(messages(late.logger, 'warn')[0]).toMatch(/late results not applied/);

    const stale = make({ lagMs: 10 * 1000 + 1 });
    await stale.svc.tick();
    expect(messages(stale.logger, 'warn')[0]).toMatch(/watermark was stale/);

    const fresh = make({ lagMs: 10 * 1000 });
    await fresh.svc.tick();
    expect(messages(fresh.logger, 'warn')).toEqual([]);

    const skipped = make({ skipped: true, late: 5, lagMs: 1e9 });
    await skipped.svc.tick();
    expect(skipped.logger.calls).toEqual([]);
  });

  it('reports endpoints the sweep marked unknown', async () => {
    const { svc, logger } = make({ markedUnknown: 3 });
    await svc.tick();
    expect(messages(logger, 'info')).toContain('endpoints with no recent result marked unknown');
  });
});
