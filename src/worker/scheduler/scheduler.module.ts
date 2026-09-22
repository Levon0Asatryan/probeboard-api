import { Module } from '@nestjs/common';
import { DbModule } from '../../core/db/db.module.js';
import { EndpointRuntimeRepository } from './repositories/endpoint-runtime.repository.js';
import { SchedulerService } from './scheduler.service.js';
import { MonitorLoaderService } from './services/monitor-loader.service.js';
import { ProbePoolService } from './services/probe-pool.service.js';

/**
 * The scheduler feature module (M4). `ConfigModule` and `LoggerModule` are
 * global in `WorkerModule`, so only the database dependency is imported here.
 */
@Module({
  imports: [DbModule],
  providers: [EndpointRuntimeRepository, ProbePoolService, MonitorLoaderService, SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
