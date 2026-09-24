import { describe, expect, it } from 'vitest';
import { HISTOGRAM_EDGES_MS } from './constants.js';
import { bucketIndex, emptyHistogram, mergeHistograms } from './histogram.js';
import { percentile } from './percentile.js';

function histOf(values: number[]): number[] {
  const h = emptyHistogram();
  for (const v of values) h[bucketIndex(v)] += 1;
  return h;
}

describe('percentile', () => {
  it('is null for an empty histogram, never 0', () => {
    expect(percentile(emptyHistogram(), 0.95)).toBeNull();
  });

  it('rejects p outside (0, 1]', () => {
    expect(() => percentile(histOf([5]), 0)).toThrow(RangeError);
    expect(() => percentile(histOf([5]), 1.5)).toThrow(RangeError);
  });

  it('interpolates linearly inside the bucket holding the rank', () => {
    // 100 values, all in (50, 75]: p50 is halfway through that bucket.
    const h = histOf(new Array<number>(100).fill(60));
    expect(percentile(h, 0.5)).toBeCloseTo(62.5, 6);
    expect(percentile(h, 1)).toBeCloseTo(75, 6);
  });

  it('clamps the ends to the observed min and max', () => {
    const h = histOf([60, 61, 62, 63]);
    expect(percentile(h, 1, { min: 60, max: 63 })).toBeCloseTo(63, 6);
    expect(percentile(h, 0.25, { min: 60, max: 63 })).toBeGreaterThanOrEqual(60);
  });

  it('interpolates the unbounded top bucket up to the observed max, not to an undefined edge', () => {
    const h = histOf([40_000, 50_000]);
    expect(percentile(h, 1, { min: 40_000, max: 50_000 })).toBeCloseTo(50_000, 6);
    // Without a max it cannot invent one: it stays at the bucket's lower edge.
    expect(percentile(h, 1)).toBe(30_000);
  });

  it('a single value is reported inside its own bucket', () => {
    const v = percentile(histOf([120]), 0.95, { min: 120, max: 120 });
    expect(v).toBeCloseTo(120, 6);
  });

  it('merge-then-percentile equals percentile of the concatenation (why the histogram is stored)', () => {
    const a = Array.from({ length: 500 }, (_, i) => 20 + (i % 300));
    const b = Array.from({ length: 800 }, (_, i) => 200 + ((i * 7) % 2500));
    const merged = mergeHistograms(histOf(a), histOf(b));
    const whole = histOf([...a, ...b]);
    expect(merged).toEqual(whole);
    const ex = { min: Math.min(...a, ...b), max: Math.max(...a, ...b) };
    expect(percentile(merged, 0.95, ex)).toBe(percentile(whole, 0.95, ex));
  });

  it('is within the containing bucket width of the exact p95 (ADR-0003 error bound)', () => {
    const values = Array.from({ length: 5000 }, (_, i) =>
      Math.round(30 + ((i * 2654435761) % 4000) / 4),
    );
    const sorted = [...values].sort((a, b) => a - b);
    const exact = sorted[Math.ceil(0.95 * sorted.length) - 1];
    const approx = percentile(histOf(values), 0.95, { min: sorted[0], max: sorted.at(-1)! })!;
    const i = bucketIndex(exact);
    const width = (HISTOGRAM_EDGES_MS[i] ?? Infinity) - (i === 0 ? 0 : HISTOGRAM_EDGES_MS[i - 1]);
    expect(Math.abs(approx - exact)).toBeLessThanOrEqual(width);
  });

  it('exports nothing that takes a percentile as input (percentiles are never averaged)', async () => {
    const mod = await import('./percentile.js');
    expect(Object.keys(mod)).toEqual(['percentile']);
  });
});
