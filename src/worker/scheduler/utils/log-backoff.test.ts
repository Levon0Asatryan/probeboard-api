import { describe, expect, it } from 'vitest';
import { LogBackoff } from './log-backoff.js';

function clocked(initialMs = 1000, maxMs = 8000) {
  let t = 0;
  const backoff = new LogBackoff(initialMs, maxMs, () => t);
  return {
    backoff,
    at: (ms: number) => {
      t = ms;
    },
  };
}

describe('LogBackoff', () => {
  it('logs the first failure at once', () => {
    const { backoff } = clocked();
    expect(backoff.failure()).toEqual({ failures: 1, suppressed: 0 });
  });

  it('holds back failures inside the interval and reports how many', () => {
    const { backoff, at } = clocked();
    backoff.failure();
    at(500);
    expect(backoff.failure()).toBeUndefined();
    at(999);
    expect(backoff.failure()).toBeUndefined();
    at(1000);
    expect(backoff.failure()).toEqual({ failures: 4, suppressed: 2 });
  });

  it('doubles the interval up to the cap', () => {
    // One failure per second, as a scheduler tick produces during an outage.
    const { backoff, at } = clocked(1000, 8000);
    const logged: number[] = [];
    for (let s = 0; s <= 40; s += 1) {
      at(s * 1000);
      if (backoff.failure()) logged.push(s);
    }
    // 1s, 2s, 4s, 8s apart, then every 8s: 8 lines for 41 failures, not 41.
    expect(logged).toEqual([0, 1, 3, 7, 15, 23, 31, 39]);
  });

  it('reports the length of the run a success ends, and starts over', () => {
    const { backoff, at } = clocked();
    backoff.failure();
    at(100);
    backoff.failure();
    expect(backoff.success()).toBe(2);
    expect(backoff.success()).toBe(0);
    at(200);
    // A new run logs its first failure at once, whatever the old interval was.
    expect(backoff.failure()).toEqual({ failures: 1, suppressed: 0 });
  });
});
