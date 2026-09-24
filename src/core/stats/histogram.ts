import { HISTOGRAM_BUCKETS, HISTOGRAM_EDGES_MS } from './constants.js';

/**
 * The 0-based bucket a latency falls in: the number of edges strictly below it,
 * so a value equal to an edge belongs to the lower bucket (`le`).
 *
 * The SQL fold computes the same thing as `width_bucket(ms - 1, $edges)`; a
 * test asserts the two agree at every edge and one either side.
 */
export function bucketIndex(ms: number): number {
  let n = 0;
  for (const edge of HISTOGRAM_EDGES_MS) {
    if (ms > edge) n += 1;
    else break;
  }
  return n;
}

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKETS).fill(0);
}

/** Integer addition, element by element: associative and exact (ADR-0003). */
export function mergeHistograms(a: readonly number[], b: readonly number[]): number[] {
  if (a.length !== HISTOGRAM_BUCKETS || b.length !== HISTOGRAM_BUCKETS) {
    throw new RangeError(`a histogram has exactly ${HISTOGRAM_BUCKETS} buckets`);
  }
  return a.map((v, i) => v + b[i]);
}

export function histogramCount(hist: readonly number[]): number {
  return hist.reduce((sum, v) => sum + v, 0);
}
