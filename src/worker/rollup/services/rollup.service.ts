import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { RollupRepository } from '../repositories/rollup.repository.js';

/**
 * Folds stored results into the aggregates every `ROLLUP_TICK_MS`
 * (docs/m5-plan.md §3.4).
 *
 * One `setTimeout` chain re-armed only after the previous pass settles, never
 * `setInterval`, so passes cannot overlap or stack behind a slow one. A failed
 * pass is logged and the next tick tries again: the fold and the watermark share
 * one transaction, so a failure leaves nothing half-applied and the retry is
 * exact. A rollup that is behind is **lag, not loss**.
 */
@Injectable()
export class RollupService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();
  /** When the orphan sweep last ran; 0 so the first tick runs it. */
  private orphansSweptAt = 0;

  constructor(
    private readonly repo: RollupRepository,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(RollupService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.arm(0);
  }

  /** Explicit, awaited before the pool closes -- see `main.ts`; the hook is a backstop. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick().finally(() => this.arm(this.cfg.ROLLUP_TICK_MS));
    }, delayMs);
  }

  /** One pass. Never rejects. */
  async tick(): Promise<void> {
    await this.sweepOrphans();
    try {
      const pass = await this.repo.runOnce(this.cfg.ROLLUP_BATCH_ROWS);
      if (pass.skipped) return;
      if (pass.folded > 0) this.logger.info({ folded: pass.folded }, 'rollup folded results');
      if (pass.lagMs > this.cfg.ROLLUP_STALE_TICKS * this.cfg.ROLLUP_TICK_MS) {
        this.logger.warn(
          { lagMs: Math.round(pass.lagMs) },
          'rollup watermark was stale before this pass -- no worker has folded for a while',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'rollup pass failed; nothing was applied, retrying next tick');
    }
  }

  /**
   * A deleted endpoint's aggregates, once per `STORAGE_MAINTENANCE_INTERVAL_MS`
   * (docs/m6-plan.md §3.12): hourly is ample for rows no reader can reach --
   * every statistics read joins endpoints. Never rejects; a failure is retried
   * at the next interval.
   */
  private async sweepOrphans(): Promise<void> {
    const now = Date.now();
    if (now - this.orphansSweptAt < this.cfg.STORAGE_MAINTENANCE_INTERVAL_MS) return;
    this.orphansSweptAt = now;
    try {
      const removed = await this.repo.removeOrphans();
      if (removed > 0) this.logger.info({ removed }, 'removed aggregates of deleted endpoints');
    } catch (err) {
      this.logger.error({ err }, 'removing aggregates of deleted endpoints failed; retrying later');
    }
  }
}
