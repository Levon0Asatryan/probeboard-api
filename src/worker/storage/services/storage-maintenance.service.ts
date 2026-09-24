import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { PartitionService } from './partition.service.js';

/**
 * Keeps the partitions ahead of the clock (docs/m5-plan.md §3.6).
 *
 * `onModuleInit` runs the first pass **blocking**, and a failure rejects it:
 * the worker then refuses to start rather than probe with nowhere to write.
 * `SchedulerModule` imports `StorageModule`, so Nest awaits this hook before
 * the scheduler's own `onModuleInit` arms its first tick.
 */
@Injectable()
export class StorageMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly partitions: PartitionService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(StorageMaintenanceService.name) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    const { created } = await this.partitions.ensure(new Date(), { wait: true });
    this.logger.info({ created: created.length }, 'partitions ensured at startup');
    this.arm();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick().finally(() => this.arm());
    }, this.cfg.STORAGE_MAINTENANCE_INTERVAL_MS);
  }

  /** One pass. Never rejects: a failed tick is logged and the next one tries again. */
  async tick(now: Date = new Date()): Promise<void> {
    try {
      const { ran, created } = await this.partitions.ensure(now);
      const horizonDays = await this.partitions.horizonDays(now);
      if (ran) this.logger.info({ created: created.length, horizonDays }, 'partitions ensured');
      if (horizonDays < 1) {
        this.logger.error(
          { horizonDays },
          'partition horizon under one day -- inserts will start failing',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'partition maintenance failed; retrying next tick');
    }
  }
}
