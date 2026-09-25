/**
 * Histogram bucket edges in milliseconds (ADR-0003).
 *
 * **Not configuration.** Buckets are fixed at write time, and changing an edge
 * silently reinterprets every histogram already stored, so this is a documented
 * constant of the data format rather than a tunable.
 *
 * Bucket _i_ holds `edge[i-1] < v <= edge[i]` (Prometheus's inclusive `le`
 * convention); the last bucket, with no edge, holds everything above 30 s.
 * 19 finite edges make 20 buckets.
 */
export const HISTOGRAM_EDGES_MS: readonly number[] = [
  10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, 15_000,
  30_000,
];

export const HISTOGRAM_BUCKETS = HISTOGRAM_EDGES_MS.length + 1;
