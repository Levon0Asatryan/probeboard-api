import { AppError } from '../errors/app-error.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The oldest partition that still exists, per retention-bound grain. `null`: none. */
export interface RetainedFrom {
  m1: Date | null;
  h1: Date | null;
}

/** Bucket starts, oldest first, that together tile `[from, to)` exactly. */
export interface WindowPlan {
  d1: Date[];
  h1: Date[];
  m1: Date[];
}

export type WindowErrorCode =
  | 'WINDOW_INVALID'
  | 'WINDOW_NOT_MINUTE_ALIGNED'
  | 'WINDOW_GRAIN_RETIRED'
  | 'WINDOW_CHANGED_DURING_READ';

/**
 * A window the stored aggregates cannot answer exactly. Always a typed
 * rejection, never a plausible-looking partial answer: rounding a window, or
 * reading half of it, changes a number a user trusts (docs/m5-plan.md D17).
 */
export class WindowError extends AppError {
  constructor(
    readonly windowCode: WindowErrorCode,
    message: string,
  ) {
    super(windowCode, message, 400);
    this.name = 'WindowError';
  }
}

/**
 * Tiles `[from, to)` coarsest first: `d1` for whole UTC days, `h1` for whole
 * hours, `m1` for whole minutes.
 *
 * Both bounds must be minute-aligned at every age -- no stored bucket is finer
 * than a minute, so `[12:00:30, 12:01:30)` cannot be tiled and any answer would
 * include or omit part of a boundary minute.
 *
 * Availability comes from what **actually exists** (`retained`), not from
 * config: retention can be raised after a shorter setting already dropped
 * partitions, so a config-derived horizon would call a gone bucket available.
 * An edge hour older than h1's oldest partition has no bucket, so a window with
 * an edge there must be day-aligned; one older than m1's must be at least
 * hour-aligned. `d1` is unpartitioned and always available.
 */
export function planWindow(from: Date, to: Date, retained: RetainedFrom): WindowPlan {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new WindowError('WINDOW_INVALID', 'from must be before to');
  }
  if (start % MINUTE !== 0 || end % MINUTE !== 0) {
    throw new WindowError(
      'WINDOW_NOT_MINUTE_ALIGNED',
      'window bounds must fall on a whole minute: no stored bucket is finer',
    );
  }

  const plan: WindowPlan = { d1: [], h1: [], m1: [] };
  for (let t = start; t < end;) {
    if (t % DAY === 0 && t + DAY <= end) {
      plan.d1.push(new Date(t));
      t += DAY;
    } else if (t % HOUR === 0 && t + HOUR <= end) {
      requireRetained('h1', retained.h1, t);
      plan.h1.push(new Date(t));
      t += HOUR;
    } else {
      requireRetained('m1', retained.m1, t);
      plan.m1.push(new Date(t));
      t += MINUTE;
    }
  }
  return plan;
}

function requireRetained(grain: 'h1' | 'm1', oldest: Date | null, at: number): void {
  if (oldest === null || at < oldest.getTime()) {
    throw new WindowError(
      'WINDOW_GRAIN_RETIRED',
      `${grain} buckets no longer exist for ${new Date(at).toISOString()}: ` +
        `align the window to a coarser boundary`,
    );
  }
}

/** The oldest bucket start a plan needs from a retention-bound grain, or `null`. */
export function oldestNeeded(plan: WindowPlan, grain: 'h1' | 'm1'): Date | null {
  return plan[grain][0] ?? null;
}
