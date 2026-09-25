/**
 * Paces one repeating error log line.
 *
 * While the database is down, every scheduler tick fails the same way, and
 * each failure was logged: three error lines per tick per worker, about six a
 * second for two workers (#72, D3). An operator reading that log learns
 * nothing after the first line and loses everything else in it.
 *
 * So the first failure of a run is logged at once, and each later one only
 * once its interval has passed, the interval doubling from `initialMs` up to
 * `maxMs`. Every logged line carries how many were held back since the last,
 * so nothing is silently dropped -- only compressed. A success ends the run
 * and reports its length, so the recovery is as visible as the outage.
 *
 * Pure: the clock is injected, and the caller decides what to log.
 */
export interface FailureReport {
  /** Consecutive failures in this run so far, this one included. */
  failures: number;
  /** Failures since the last logged one that were not logged. */
  suppressed: number;
}

export class LogBackoff {
  private failures = 0;
  private suppressed = 0;
  private intervalMs: number;
  private nextLogAt = 0;

  constructor(
    private readonly initialMs: number,
    private readonly maxMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.intervalMs = initialMs;
  }

  /** Records a failure; returns what to log, or `undefined` to stay quiet. */
  failure(): FailureReport | undefined {
    this.failures += 1;
    const at = this.now();
    if (this.failures > 1 && at < this.nextLogAt) {
      this.suppressed += 1;
      return undefined;
    }
    const report = { failures: this.failures, suppressed: this.suppressed };
    this.suppressed = 0;
    if (this.failures > 1) this.intervalMs = Math.min(this.intervalMs * 2, this.maxMs);
    this.nextLogAt = at + this.intervalMs;
    return report;
  }

  /** Records a success; returns the length of the run it ended, 0 if none. */
  success(): number {
    const ended = this.failures;
    this.failures = 0;
    this.suppressed = 0;
    this.intervalMs = this.initialMs;
    this.nextLogAt = 0;
    return ended;
  }
}
