import { describe, expect, it } from 'vitest';
import {
  PARTITION_FAMILIES,
  addUtcDays,
  addUtcMonths,
  partitionName,
  periodsCovering,
  periodStart,
} from './partition-periods.js';

describe('periodsCovering', () => {
  it('returns today and each following day, oldest first, aligned to UTC midnight', () => {
    const now = new Date('2026-09-24T22:30:00Z');
    const periods = periodsCovering('day', now, addUtcDays(now, 3));
    expect(periods.map((p) => p.suffix)).toEqual(['20260924', '20260925', '20260926', '20260927']);
    expect(periods[0].from.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(periods[0].to.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('crosses a month and a year boundary without skipping or repeating a day', () => {
    const periods = periodsCovering(
      'day',
      new Date('2026-12-30T12:00:00Z'),
      new Date('2027-01-02T00:00:00Z'),
    );
    expect(periods.map((p) => p.suffix)).toEqual(['20261230', '20261231', '20270101', '20270102']);
  });

  it('makes adjacent ranges meet exactly, so no instant falls between two partitions', () => {
    const periods = periodsCovering(
      'day',
      new Date('2026-02-27T00:00:00Z'),
      new Date('2026-03-02T00:00:00Z'),
    );
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i].from.getTime()).toBe(periods[i - 1].to.getTime());
    }
    expect(periods.map((p) => p.suffix)).toEqual(['20260227', '20260228', '20260301', '20260302']);
  });

  it('covers months by their real length', () => {
    const now = new Date('2026-11-15T00:00:00Z');
    const periods = periodsCovering('month', now, addUtcMonths(now, 2));
    expect(periods.map((p) => p.suffix)).toEqual(['202611', '202612', '202701']);
    expect(periods[1].to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is independent of the process time zone', () => {
    // 23:30 UTC on the 24th is already the 25th in UTC+4. Node re-reads TZ when
    // it changes, so this fails if any local getter or local-zone Date.parse is used.
    const before = process.env.TZ;
    process.env.TZ = 'Asia/Yerevan';
    try {
      const at = new Date('2026-09-24T23:30:00Z');
      expect(at.getDate()).toBe(25);
      expect(periodStart('day', at).toISOString()).toBe('2026-09-24T00:00:00.000Z');
      expect(periodsCovering('day', at, at).map((p) => p.suffix)).toEqual(['20260924']);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('partitionName', () => {
  it('derives names from the family constant and the UTC suffix', () => {
    expect(partitionName(PARTITION_FAMILIES[0], { suffix: '20260924' })).toBe(
      'probe_results_p20260924',
    );
    expect(partitionName(PARTITION_FAMILIES[3], { suffix: '202609' })).toBe(
      'probe_stats_h1_p202609',
    );
  });

  it('only ever interpolates safe identifiers', () => {
    for (const f of PARTITION_FAMILIES) expect(f.parent).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
