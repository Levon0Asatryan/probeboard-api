import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { EvaluatorRepository } from '../repositories/evaluator.repository.js';

/**
 * Turns stored results into incidents every `EVALUATOR_TICK_MS`
 * (docs/m6-plan.md §3.3), beside the rollup and in the same shape.
 *
 * One `setTimeout` chain re-armed only after the previous pass settles, so
 * passes never overlap or stack. A failed pass is logged and retried next
 * tick: state, incidents, outbox and watermark share one transaction, so a
 * failure leaves nothing half-applied. It never probes and never sends a
 * notification -- it only writes the outbox M7 drains.
 */
@Injectable()
export class EvaluatorService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly repo: EvaluatorRepository,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(EvaluatorService.name) private readonly logger: PinoLogger,
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
      this.inFlight = this.tick().finally(() => this.arm(this.cfg.EVALUATOR_TICK_MS));
    }, delayMs);
  }

  /** One pass. Never rejects. */
  async tick(): Promise<void> {
    try {
      const pass = await this.repo.runOnce({
        batchXids: this.cfg.EVALUATOR_BATCH_XIDS,
        unknownGraceMs: this.cfg.UNKNOWN_GRACE_MS,
      });
      if (pass.skipped) return;
      for (const e of pass.opened) this.logger.info(e, 'incident opened');
      for (const e of pass.closed) this.logger.info(e, 'incident closed');
      if (pass.late > 0) {
        this.logger.warn(
          { late: pass.late },
          'late results not applied to incident state -- stored and folded, older than one already applied',
        );
      }
      if (pass.markedUnknown > 0) {
        this.logger.info(
          { endpoints: pass.markedUnknown },
          'endpoints with no recent result marked unknown',
        );
      }
      if (pass.lagMs > this.cfg.EVALUATOR_STALE_TICKS * this.cfg.EVALUATOR_TICK_MS) {
        this.logger.warn(
          { lagMs: Math.round(pass.lagMs) },
          'evaluator watermark was stale before this pass -- no worker has evaluated for a while',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'evaluator pass failed; nothing was applied, retrying next tick');
    }
  }
}
