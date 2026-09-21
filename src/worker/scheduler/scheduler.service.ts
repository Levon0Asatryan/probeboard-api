import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { probe, type ProbeDeps } from '../probing/index.js';
import { createProbeDeps } from './probe-deps.factory.js';
import {
  EndpointRuntimeRepository,
  type ClaimedSlot,
} from './repositories/endpoint-runtime.repository.js';
import { MonitorLoaderService } from './services/monitor-loader.service.js';
import { ProbePoolService } from './services/probe-pool.service.js';

/** `endpointId:scheduledAt` -- the pool's key, and what a claim, release or abandon all fence on. */
export function slotKey(row: Pick<ClaimedSlot, 'endpoint_id' | 'scheduled_at'>): string {
  return `${row.endpoint_id}:${row.scheduled_at}`;
}

class LoadBudgetExceededError extends Error {
  constructor(budgetMs: number) {
    super(`monitor load exceeded SCHEDULER_LOAD_BUDGET_MS (${budgetMs}ms)`);
  }
}

/**
 * The tick loop: claims due work and starts it, bounded by the pool (§3.4).
 *
 * One `setTimeout` chain, re-armed only after the previous tick's own work
 * settles -- never `setInterval`, which would queue a second tick behind a
 * slow claim and stack unboundedly. That makes overlap between ticks
 * structurally impossible; the probes a tick *starts* do outlive it, and
 * their count is what `ProbePoolService` bounds.
 *
 * Each step inside a tick is caught **individually** (D19): a persistently
 * failing `adopt()` must not prevent `claim()` from running on the same
 * tick, or every tick, forever, and the outer `catch` exists only for the
 * claim itself and anything unanticipated. Removing any one of the three
 * inner `try/catch` blocks is what a guard-removal test proves against.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private tickInFlight: Promise<void> = Promise.resolve();
  private readonly probeDeps: ProbeDeps;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly repo: EndpointRuntimeRepository,
    private readonly pool: ProbePoolService,
    private readonly loader: MonitorLoaderService,
    @InjectPinoLogger(SchedulerService.name) private readonly logger: PinoLogger,
  ) {
    this.probeDeps = createProbeDeps(cfg);
  }

  onModuleInit(): void {
    this.start();
  }

  /**
   * Backstop only. The documented shutdown order (§3.9) is `main.ts` calling
   * `stop()` explicitly before `app.close()`, so releases complete before
   * `DbService.onModuleDestroy` tears the pool down -- Nest's own destroy
   * hooks run in an order this class cannot rely on. This exists so a module
   * torn down without going through `main.ts` (a test, most likely) does not
   * leave a timer armed against a database that is about to disappear.
   * `stop()` is idempotent, so when `main.ts` already called it this is a
   * no-op.
   */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.stopping) return;
    this.arm(0);
  }

  private arm(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.tickInFlight = this.runTick();
    }, delayMs);
  }

  private async runTick(): Promise<void> {
    const startedAt = Date.now();
    try {
      try {
        await this.repo.adopt(this.cfg.SCHEDULER_ADOPT_JITTER_MAX_S);
      } catch (err) {
        this.logger.error({ err }, 'adopt() failed; claim still runs this tick (D19)');
      }

      try {
        await this.repo.reconcile();
      } catch (err) {
        this.logger.error({ err }, 'reconcile() failed; claim still runs this tick (D19)');
      }

      // Re-checked here, not only at arm-time: adopt()/reconcile() await the
      // database, so a SIGTERM arriving mid-await resumes straight into this
      // block unless it is asked again. Without this, a tick already in
      // flight when stop() is called can still claim and dispatch fresh
      // work after shutdown began -- the timer being cleared is not enough,
      // because this tick was already running before it was (§3.9).
      if (this.stopping) return;

      const capacity = this.pool.available;
      if (capacity > 0) {
        const rows = await this.repo.claim(
          this.cfg.WORKER_ID,
          this.cfg.SCHEDULER_LEASE_MS,
          Math.min(this.cfg.SCHEDULER_BATCH_SIZE, capacity),
        );
        for (const row of rows) this.dispatch(row);
      }
    } catch (err) {
      this.logger.error({ err }, 'tick failed');
    } finally {
      if (!this.stopping) {
        this.arm(Math.max(0, this.cfg.SCHEDULER_TICK_MS - (Date.now() - startedAt)));
      }
    }
  }

  /** Starts one claimed slot in the pool. Not awaited by the tick (§3.4). */
  private dispatch(row: ClaimedSlot): void {
    const key = slotKey(row);
    const work = this.runOne(row).catch((err: unknown) => {
      // D23: runOne must never reach here. If it does, the pool's own
      // backstop also logs it -- this one names the row, which the pool's
      // opaque key does not.
      this.logger.error(
        { err, endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
        'runOne rejected -- a D23 violation',
      );
    });
    this.pool.start(key, work);
  }

  /**
   * One claimed slot, start to finish. Every path out releases or abandons
   * the lease, and each of those two writes is independently guarded (D23):
   * the catch path itself awaits a database write, so it must not be able to
   * fail the recovery it is performing.
   */
  private async runOne(row: ClaimedSlot): Promise<void> {
    const claimedAt = Date.now();

    const loaded = await this.tryLoad(row);
    if (!loaded) {
      await this.guardedAbandon(row);
      return;
    }

    this.logger.info(
      {
        workerId: this.cfg.WORKER_ID,
        endpointId: row.endpoint_id,
        scheduledAt: row.scheduled_at,
        claimToStartMs: Date.now() - claimedAt,
        msg: 'attempt',
      },
      'attempt',
    );

    let outcome;
    try {
      outcome = await probe(loaded, this.probeDeps);
    } catch (err) {
      // M3's contract: probe() never rejects for a network condition, so a
      // rejection here is our bug, not the endpoint's (§3.7).
      this.logger.error(
        { err, endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
        'probe() threw -- contract violation; abandoning the slot',
      );
      await this.guardedAbandon(row);
      return;
    }

    this.logger.info(
      {
        workerId: this.cfg.WORKER_ID,
        endpointId: row.endpoint_id,
        scheduledAt: row.scheduled_at,
        success: outcome.success,
        failureClass: outcome.failureClass,
        msg: 'outcome',
      },
      'outcome',
    );

    await this.guardedRelease(row);
  }

  /**
   * Loads under `SCHEDULER_LOAD_BUDGET_MS` (D20). `undefined` on any
   * failure -- overrun or rejection are the same case for the caller, which
   * abandons the slot either way; only the log line distinguishes them.
   *
   * The budget is passed to the loader itself, which bounds the underlying
   * transaction with `statement_timeout` on the connection -- not only
   * raced here. Racing alone stops *awaiting* an overrun, but leaves the
   * transaction running and its connection checked out for however long it
   * actually takes, which is how enough overruns exhaust the pool. This
   * race is kept anyway, as a backstop for whatever is not itself a
   * database statement (e.g. pool acquisition, already separately bounded
   * by `connectionTimeoutMillis`).
   */
  private async tryLoad(row: ClaimedSlot) {
    const budgetMs = this.cfg.SCHEDULER_LOAD_BUDGET_MS;
    try {
      return await this.withDeadline(this.loader.load(row.endpoint_id, budgetMs), budgetMs);
    } catch (err) {
      this.logger.error(
        { err, endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
        'monitor load failed or exceeded SCHEDULER_LOAD_BUDGET_MS; abandoning the slot',
      );
      return undefined;
    }
  }

  private withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new LoadBudgetExceededError(ms)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private async guardedRelease(row: ClaimedSlot): Promise<void> {
    try {
      const n = await this.repo.release(row.endpoint_id, this.cfg.WORKER_ID, row.scheduled_at);
      if (n === 0) {
        this.logger.warn(
          { endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
          'release matched no row -- the lease was already lost',
        );
      }
    } catch (err) {
      // D23: this write itself must not throw out of the recovery path.
      // A failed release leaves the lease standing, bounded by
      // SCHEDULER_LEASE_MS and reclaimed per §3.11 -- strictly better than
      // losing the process.
      this.logger.error(
        { err, endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
        'release failed -- lease left standing, reclaimed at expiry',
      );
    }
  }

  private async guardedAbandon(row: ClaimedSlot): Promise<void> {
    try {
      const n = await this.repo.abandon(row.endpoint_id, this.cfg.WORKER_ID, row.scheduled_at);
      if (n === 0) {
        this.logger.warn(
          { endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
          'abandon matched no row -- the lease was already lost',
        );
      }
    } catch (err) {
      this.logger.error(
        { err, endpointId: row.endpoint_id, scheduledAt: row.scheduled_at },
        'abandon failed -- lease left standing, reclaimed at expiry',
      );
    }
  }

  /**
   * Stops claiming, lets an in-flight tick's own statement finish, then
   * waits up to `SCHEDULER_SHUTDOWN_GRACE_MS` for probes already running to
   * settle. A probe still running when the grace expires keeps its lease --
   * releasing it here would invite a peer to start a second probe of the
   * same endpoint while ours is still in flight (§3.9, D12).
   *
   * Idempotent: a second call while the first is still draining awaits the
   * same drain rather than starting another.
   */
  private stopPromise: Promise<void> | undefined;

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.tickInFlight;

    const { stillRunning } = await this.pool.drain(this.cfg.SCHEDULER_SHUTDOWN_GRACE_MS);
    for (const key of stillRunning) {
      this.logger.warn(
        { key },
        'probe still in flight at shutdown grace expiry -- lease left in place',
      );
    }
  }
}
