import { HISTOGRAM_BUCKETS, HISTOGRAM_EDGES_MS } from './constants.js';

export interface Extremes {
  /** Smallest latency observed in the merged window, when known. */
  min: number | null;
  /** Largest latency observed in the merged window, when known. */
  max: number | null;
}

/**
 * A percentile of a merged histogram, by linear interpolation inside the bucket
 * holding the rank (ADR-0003).
 *
 * This is the only way a percentile is produced. Percentiles are never averaged
 * and no function here takes one as input: given p95 for each of 24 hourly
 * buckets there is no arithmetic that recovers the day's p95, which is why the
 * histogram is what is stored.
 *
 * The observed extremes tighten the ends: the lowest populated bucket starts at
 * `max(edge below, min)` and the highest ends at `min(edge, max)`, so the
 * unbounded top bucket interpolates to the real maximum instead of an undefined
 * edge. The error is still worst where buckets are widest (above 10 s).
 *
 * `null` for an empty histogram -- never `0`, which would read as a perfect
 * endpoint.
 */
export function percentile(
  hist: readonly number[],
  p: number,
  extremes: Extremes = { min: null, max: null },
): number | null {
  if (!(p > 0 && p <= 1)) throw new RangeError('p must be in (0, 1]');
  if (hist.length !== HISTOGRAM_BUCKETS) {
    throw new RangeError(`a histogram has exactly ${HISTOGRAM_BUCKETS} buckets`);
  }
  const n = hist.reduce((sum, v) => sum + v, 0);
  if (n === 0) return null;

  const first = hist.findIndex((v) => v > 0);
  const last = hist.length - 1 - [...hist].reverse().findIndex((v) => v > 0);
  const rank = p * n;

  let before = 0;
  for (let i = 0; i < hist.length; i += 1) {
    const count = hist[i];
    if (count === 0 || before + count < rank) {
      before += count;
      continue;
    }
    let lower = i === 0 ? 0 : HISTOGRAM_EDGES_MS[i - 1];
    let upper = i < HISTOGRAM_EDGES_MS.length ? HISTOGRAM_EDGES_MS[i] : (extremes.max ?? lower);
    if (i === first && extremes.min !== null) lower = Math.max(lower, extremes.min);
    if (i === last && extremes.max !== null) upper = Math.min(upper, extremes.max);
    if (upper < lower) upper = lower;
    return lower + ((upper - lower) * (rank - before)) / count;
  }
  return null;
}
