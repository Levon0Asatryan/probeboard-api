import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { ProbePoolService } from './probe-pool.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  PROBE_CONCURRENCY: '2',
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProbePoolService: capacity (NFR-1)', () => {
  it('available reflects capacity minus in-flight, and never goes negative', () => {
    const pool = new ProbePoolService(cfg, fakeLogger());
    expect(pool.available).toBe(2);
    const a = deferred();
    pool.start('a', a.promise);
    expect(pool.available).toBe(1);
    const b = deferred();
    pool.start('b', b.promise);
    expect(pool.available).toBe(0);
    // A third registration beyond capacity is the caller's mistake to avoid
    // (the tick reads `available` first), but the pool itself must not
    // report a negative number if it happens.
    const c = deferred();
    pool.start('c', c.promise);
    expect(pool.available).toBe(0);
    a.resolve();
    b.resolve();
    c.resolve();
  });

  it('removes a key once its work settles, freeing capacity', async () => {
    const pool = new ProbePoolService(cfg, fakeLogger());
    const a = deferred();
    pool.start('a', a.promise);
    expect(pool.size).toBe(1);
    a.resolve();
    await vi.waitFor(() => expect(pool.size).toBe(0));
    expect(pool.available).toBe(2);
  });

  it('removes a key even when its work rejects, and logs it as a D23 violation', async () => {
    const logger = fakeLogger();
    const pool = new ProbePoolService(cfg, logger);
    const a = deferred();
    pool.start('a', a.promise);
    a.reject(new Error('should never happen per D23'));
    await vi.waitFor(() => expect(pool.size).toBe(0));
    expect(logger.calls.some((c) => c.level === 'error')).toBe(true);
  });
});

describe('ProbePoolService: drain (§3.9)', () => {
  it('returns immediately with no keys when nothing is in flight', async () => {
    const pool = new ProbePoolService(cfg, fakeLogger());
    const result = await pool.drain(1000);
    expect(result).toEqual({ settled: [], stillRunning: [] });
  });

  it('reports a slot that settles within the grace as settled, not still running', async () => {
    const pool = new ProbePoolService(cfg, fakeLogger());
    const a = deferred();
    pool.start('a', a.promise);
    const drainPromise = pool.drain(10_000);
    a.resolve();
    const result = await drainPromise;
    expect(result.settled).toEqual(['a']);
    expect(result.stillRunning).toEqual([]);
  });

  it(
    'clears the grace timer once every in-flight slot has settled, rather than leaving it ' +
      'referenced until the full grace elapses (Codex #61 round 2)',
    async () => {
      const pool = new ProbePoolService(cfg, fakeLogger());
      const a = deferred();
      pool.start('a', a.promise);
      const drainPromise = pool.drain(10_000);
      a.resolve();
      await drainPromise;
      // The "settled" branch won the race well before the 10s grace, so a
      // cleared timer means none is left pending; an uncleared one would
      // still be counted here, keeping the event loop alive for the
      // remainder of the grace for no reason.
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('reports a slot still running when the grace expires first, and leaves it tracked', async () => {
    const pool = new ProbePoolService(cfg, fakeLogger());
    const a = deferred();
    pool.start('a', a.promise);
    const drainPromise = pool.drain(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await drainPromise;
    expect(result.stillRunning).toEqual(['a']);
    expect(result.settled).toEqual([]);
    expect(pool.has('a')).toBe(true); // still tracked -- its lease is not released
    a.resolve();
  });

  it('does not count a slot started after the drain began as either settled or still running', async () => {
    const pool = new ProbePoolService(cfg, fakeLogger());
    const a = deferred();
    pool.start('a', a.promise);
    const drainPromise = pool.drain(1000);
    const b = deferred();
    pool.start('b', b.promise); // started mid-drain
    b.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await drainPromise;
    expect(result.settled).not.toContain('b');
    expect(result.stillRunning).not.toContain('b');
    a.resolve();
  });
});
