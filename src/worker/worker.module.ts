import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, ConfigModule } from '../core/config/config.module.js';
import type { AppConfig } from '../core/config/schema.js';
import { DbModule } from '../core/db/db.module.js';
import { loggerOptions } from '../core/logging/index.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

/**
 * Probe worker. Same codebase as the API, different entrypoint and module set
 * (docs §7.1) so it can be scaled independently (NFR-7).
 *
 * Loops are added in M4 (scheduler), M5 (rollup), M6 (evaluator), M7 (dispatcher).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => loggerOptions('worker', cfg),
    }),
    DbModule,
    SchedulerModule,
  ],
})
export class WorkerModule {}
