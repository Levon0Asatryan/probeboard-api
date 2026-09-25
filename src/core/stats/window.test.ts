import { describe, expect, it } from 'vitest';
import { planWindow, WindowError, type RetainedFrom } from './window.js';

const d = (s: string) => new Date(s);
const ALL: RetainedFrom = { m1: d('2020-01-01T00:00:00Z'), h1: d('2020-01-01T00:00:00Z') };
const NONE: RetainedFrom = { m1: null, h1: null };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof WindowError ? e.windowCode : `other:${String(e)}`;
  }
  return undefined;
}

describe('planWindow tiling', () => {
  it('uses only d1 for a day-aligned window, and needs no retention-bound grain at all', () => {
    const plan = planWindow(d('2026-08-25T00:00:00Z'), d('2026-09-24T00:00:00Z'), NONE);
    expect(plan.d1).toHaveLength(30);
    expect(plan.h1).toHaveLength(0);
    expect(plan.m1).toHaveLength(0);
  });

  it('tiles an unaligned window exactly: partial days by hours, partial hours by minutes', () => {
    const from = d('2026-09-01T22:58:00Z');
    const to = d('2026-09-04T01:03:00Z');
    const plan = planWindow(from, to, ALL);
    const covered = plan.d1.length * 1440 + plan.h1.length * 60 + plan.m1.length;
    expect((to.getTime() - from.getTime()) / 60_000).toBe(covered);
    expect(plan.d1).toHaveLength(2); // the 2nd and 3rd
    expect(plan.m1).toHaveLength(2 + 3);
  });

  it('never overlaps: every tile start is distinct and ordered', () => {
    const plan = planWindow(d('2026-09-01T05:07:00Z'), d('2026-09-03T18:20:00Z'), ALL);
    const all = [...plan.d1, ...plan.h1, ...plan.m1].map((t) => t.getTime());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('planWindow rejections', () => {
  it('rejects a bound off the minute, at every age', () => {
    expect(code(() => planWindow(d('2026-09-24T12:00:30Z'), d('2026-09-24T12:01:30Z'), ALL))).toBe(
      'WINDOW_NOT_MINUTE_ALIGNED',
    );
    expect(
      code(() => planWindow(d('2026-09-24T12:00:00Z'), d('2026-09-24T12:01:00.500Z'), ALL)),
    ).toBe('WINDOW_NOT_MINUTE_ALIGNED');
    // Old and day-aligned except for seconds.
    expect(code(() => planWindow(d('2020-01-01T00:00:01Z'), d('2020-02-01T00:00:00Z'), ALL))).toBe(
      'WINDOW_NOT_MINUTE_ALIGNED',
    );
  });

  it('rejects an empty or inverted window', () => {
    expect(code(() => planWindow(d('2026-09-24T00:00:00Z'), d('2026-09-24T00:00:00Z'), ALL))).toBe(
      'WINDOW_INVALID',
    );
    expect(code(() => planWindow(d('2026-09-25T00:00:00Z'), d('2026-09-24T00:00:00Z'), ALL))).toBe(
      'WINDOW_INVALID',
    );
  });

  it('rejects an hour edge older than the oldest h1 partition, but accepts it day-aligned', () => {
    const retained: RetainedFrom = { m1: d('2026-09-20T00:00:00Z'), h1: d('2026-09-01T00:00:00Z') };
    expect(
      code(() => planWindow(d('2026-08-30T05:00:00Z'), d('2026-09-03T00:00:00Z'), retained)),
    ).toBe('WINDOW_GRAIN_RETIRED');
    expect(() =>
      planWindow(d('2026-08-30T00:00:00Z'), d('2026-09-03T00:00:00Z'), retained),
    ).not.toThrow();
  });

  it('rejects a sub-hour edge older than the oldest m1 partition, but accepts it hour-aligned', () => {
    const retained: RetainedFrom = { m1: d('2026-09-20T00:00:00Z'), h1: d('2026-09-01T00:00:00Z') };
    expect(
      code(() => planWindow(d('2026-09-10T05:30:00Z'), d('2026-09-10T08:00:00Z'), retained)),
    ).toBe('WINDOW_GRAIN_RETIRED');
    expect(() =>
      planWindow(d('2026-09-10T05:00:00Z'), d('2026-09-10T08:00:00Z'), retained),
    ).not.toThrow();
  });

  it('judges availability by what exists, so raising retention over dropped partitions does not help', () => {
    // Config might now say 400 days, but the catalogue's oldest h1 partition is recent.
    const actual: RetainedFrom = { m1: d('2026-09-20T00:00:00Z'), h1: d('2026-08-01T00:00:00Z') };
    expect(
      code(() => planWindow(d('2026-05-10T03:00:00Z'), d('2026-05-11T00:00:00Z'), actual)),
    ).toBe('WINDOW_GRAIN_RETIRED');
  });

  it('treats no partition at all as nothing retained', () => {
    expect(code(() => planWindow(d('2026-09-24T01:00:00Z'), d('2026-09-24T02:00:00Z'), NONE))).toBe(
      'WINDOW_GRAIN_RETIRED',
    );
  });
});
