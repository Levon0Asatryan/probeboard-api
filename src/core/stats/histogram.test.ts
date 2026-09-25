import { describe, expect, it } from 'vitest';
import { HISTOGRAM_BUCKETS, HISTOGRAM_EDGES_MS } from './constants.js';
import { bucketIndex, emptyHistogram, histogramCount, mergeHistograms } from './histogram.js';

describe('HISTOGRAM_EDGES_MS', () => {
  it('is the documented 19 edges, ascending, making 20 buckets (ADR-0003)', () => {
    expect(HISTOGRAM_EDGES_MS).toHaveLength(19);
    expect(HISTOGRAM_BUCKETS).toBe(20);
    expect([...HISTOGRAM_EDGES_MS].sort((a, b) => a - b)).toEqual([...HISTOGRAM_EDGES_MS]);
    expect(HISTOGRAM_EDGES_MS[0]).toBe(10);
    expect(HISTOGRAM_EDGES_MS.at(-1)).toBe(30_000);
  });
});

describe('bucketIndex (le: an edge belongs to the lower bucket)', () => {
  it.each([
    [0, 0],
    [1, 0],
    [10, 0],
    [11, 1],
    [25, 1],
    [26, 2],
    [50, 2],
    [51, 3],
    [1000, 10],
    [1001, 11],
    [30_000, 18],
    [30_001, 19],
    [10_000_000, 19],
  ])('%i ms -> bucket %i', (ms, idx) => {
    expect(bucketIndex(ms)).toBe(idx);
  });

  it('agrees with the SQL width_bucket(ms - 1, edges) + 1 rule at every edge and one either side', () => {
    // The fold computes width_bucket(total_ms - 1, $edges) + 1 (1-based).
    // width_bucket over an ascending array = the number of thresholds <= operand.
    const widthBucket = (x: number) => HISTOGRAM_EDGES_MS.filter((e) => e <= x).length;
    for (const edge of HISTOGRAM_EDGES_MS) {
      for (const ms of [edge - 1, edge, edge + 1]) {
        expect(bucketIndex(ms) + 1).toBe(widthBucket(ms - 1) + 1);
      }
    }
  });
});

describe('mergeHistograms', () => {
  it('adds element by element and is associative', () => {
    const a = emptyHistogram();
    const b = emptyHistogram();
    const c = emptyHistogram();
    a[0] = 2;
    b[0] = 3;
    b[19] = 1;
    c[5] = 4;
    expect(mergeHistograms(a, b)[0]).toBe(5);
    expect(mergeHistograms(mergeHistograms(a, b), c)).toEqual(
      mergeHistograms(a, mergeHistograms(b, c)),
    );
    expect(histogramCount(mergeHistograms(a, b))).toBe(6);
  });

  it('rejects a histogram that is not exactly 20 buckets', () => {
    expect(() => mergeHistograms([1, 2], emptyHistogram())).toThrow(RangeError);
  });
});
