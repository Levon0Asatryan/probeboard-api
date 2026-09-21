import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';

/** What `drain` found when the grace period ran out. */
export interface DrainResult {
  /** Keys that were in flight at the start of the drain and settled before the grace expired. */
  settled: string[];
  /** Keys still in flight when the grace expired. Their leases must be left standing (§3.9). */
  stillRunning: string[];
}

/**
 * The bounded set of probes running at once (NFR-1).
 *
 * Tracks each in-flight slot by an opaque key -- `endpointId:scheduledAt`, the
 * caller's choice, never interpreted here -- against its own settlement
 * promise. Nothing about probing, loading or the database lives in this
 * class; it only counts and waits.
 *
 * **`start`'s promise must never reject.** `SchedulerService.runOne` is the
 * component that guarantees this (D23): every terminal write is in its own
 * `try/catch`, so nothing the pool holds a reference to can throw past it.
 * The `.catch` here is a backstop, not the primary guard -- if it ever fires,
 * that is itself the bug D23 exists to prevent, logged loudly rather than
 * swallowed, because an unhandled rejection at this layer would otherwise
 * terminate the worker process (AGENTS.md's silently-exiting loop, reached
 * through the pool instead of the tick).
 */
@Injectable()
export class ProbePoolService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(ProbePoolService.name) private readonly logger: PinoLogger,
  ) {}

  get size(): number {
    return this.inFlight.size;
  }

  get capacity(): number {
    return this.cfg.PROBE_CONCURRENCY;
  }

  /** How many more probes this tick may start (NFR-1's gate). Never negative. */
  get available(): number {
    return Math.max(0, this.capacity - this.inFlight.size);
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  keys(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Registers `key` as running for the duration of `work`, and removes it on
   * settle whichever way `work` settles. The caller does not await this --
   * that is the whole point of a pool (§3.4) -- so a rejection that reaches
   * here has nowhere else to go; see the class doc.
   */
  start(key: string, work: Promise<void>): void {
    this.inFlight.set(key, work);
    work
      .catch((err: unknown) => {
        this.logger.error(
          { err, key },
          'a pooled probe rejected -- this is a D23 violation, not an endpoint failure',
        );
      })
      .finally(() => {
        this.inFlight.delete(key);
      })
      .catch(() => {
        /* the logger call above cannot itself reject in a way that matters here */
      });
  }

  /**
   * Waits up to `graceMs` for the slots in flight *right now* to settle.
   *
   * Snapshots the key set before waiting: a slot claimed and started while
   * this drain is already running (impossible once the tick timer is
   * cleared, but not assumed away) must not count as "still running" for a
   * grace period it never got — nor as settled if it happens to finish
   * quickly, which would let a fresh probe masquerade as one this drain was
   * responsible for.
   */
  async drain(graceMs: number): Promise<DrainResult> {
    const atStart = new Set(this.keys());
    if (atStart.size === 0) return { settled: [], stillRunning: [] };

    // The timer is cleared whichever branch of the race wins. Left running,
    // a still-referenced setTimeout keeps the event loop alive for up to
    // graceMs after every in-flight slot has already settled -- observable
    // as a worker that outlives app.close() by nearly the full grace, doing
    // nothing (Codex round 2 on #61).
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(
        [...atStart].map((k) => this.inFlight.get(k)).filter((p) => p !== undefined),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    const stillRunning = [...atStart].filter((k) => this.inFlight.has(k));
    const settled = [...atStart].filter((k) => !stillRunning.includes(k));
    return { settled, stillRunning };
  }
}
