import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { AuthMaintenanceService } from '../maintenance/auth-maintenance.service.js';
import type { AuthAttemptRepository } from '../rate-limiting/rate-limit.repository.js';
import type { SessionRepository } from '../sessions/session.repository.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  AUTH_ATTEMPT_RETENTION_MS: '3600000',
  AUTH_SWEEP_INTERVAL_MS: '900000',
  SESSION_RETENTION_DAYS: '7',
});

function make(overrides: { sessions?: number | Error; attempts?: number | Error } = {}) {
  const asResult = (v: number | Error | undefined, fallback: number) =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? fallback);

  const sessions = {
    pruneExpired: vi.fn(() => asResult(overrides.sessions, 0)),
  } as unknown as SessionRepository;
  const attempts = {
    pruneBefore: vi.fn(() => asResult(overrides.attempts, 0)),
  } as unknown as AuthAttemptRepository;
  const logger = { info: vi.fn(), error: vi.fn() };

  return {
    service: new AuthMaintenanceService(cfg, sessions, attempts, logger as never),
    sessions,
    attempts,
    logger,
  };
}

describe('sweep', () => {
  it('prunes both tables', async () => {
    const { service, sessions, attempts } = make({ sessions: 3, attempts: 7 });

    await expect(service.sweep()).resolves.toEqual({ sessions: 3, attempts: 7 });
    expect(sessions.pruneExpired).toHaveBeenCalledOnce();
    expect(attempts.pruneBefore).toHaveBeenCalledOnce();
  });

  it('uses the configured retention for attempts', async () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const { service, attempts } = make();

    await service.sweep(now);

    const cutoff = vi.mocked(attempts.pruneBefore).mock.calls[0][0];
    expect(now.getTime() - cutoff.getTime()).toBe(3_600_000);
  });

  it('keeps expired sessions for a grace period rather than deleting at expiry', async () => {
    // So an operator can still answer "was this session live at the time?".
    const now = new Date('2026-06-01T12:00:00Z');
    const { service, sessions } = make();

    await service.sweep(now);

    const cutoff = vi.mocked(sessions.pruneExpired).mock.calls[0][0];
    expect(cutoff.getTime()).toBeLessThan(now.getTime());
  });

  it('says nothing when there was nothing to remove', async () => {
    const { service, logger } = make();
    await service.sweep();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('reports a failure instead of taking the api down with it', async () => {
    // Housekeeping runs again next interval; it must not propagate.
    const { service, logger } = make({ sessions: new Error('connection terminated') });

    await expect(service.sweep()).resolves.toEqual({ sessions: 0, attempts: 0 });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0].cause).toContain('connection terminated');
  });
});

describe('lifecycle', () => {
  it('schedules a sweep that cannot hold the process open', () => {
    // A ref'd timer would delay shutdown by up to the whole interval.
    const { service } = make();
    const unref = vi.fn();
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue({ unref } as never);

    service.onModuleInit();

    expect(spy).toHaveBeenCalledWith(expect.any(Function), 900_000);
    expect(unref).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('sweeps once at startup, so a frequently restarted instance still runs it', async () => {
    // With the interval alone, an instance restarting more often than the
    // sweep period would never reach the first callback.
    const { service, sessions, attempts } = make();
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue({ unref: vi.fn() } as never);

    service.onModuleInit();
    await vi.waitFor(() => {
      expect(sessions.pruneExpired).toHaveBeenCalled();
    });
    expect(attempts.pruneBefore).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('does not let a failing startup sweep break boot', async () => {
    const { service } = make({ sessions: new Error('database is gone') });
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue({ unref: vi.fn() } as never);

    expect(() => {
      service.onModuleInit();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(true).toBe(true);
    });

    spy.mockRestore();
  });

  it('clears the timer on shutdown', () => {
    const { service } = make();
    const clear = vi.spyOn(global, 'clearInterval');

    service.onModuleInit();
    service.onModuleDestroy();

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('does not clear a timer it never set', () => {
    expect(() => make().service.onModuleDestroy()).not.toThrow();
  });
});
