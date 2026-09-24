import { Module } from '@nestjs/common';
import { DbModule } from '../../core/db/db.module.js';
import { ProbeResultRepository } from './repositories/probe-result.repository.js';
import { PartitionService } from './services/partition.service.js';
import { StorageMaintenanceService } from './services/storage-maintenance.service.js';

/**
 * Result storage (M5). `SchedulerModule` imports this, so Nest awaits
 * `StorageMaintenanceService.onModuleInit` -- the blocking first partition
 * pass -- before the scheduler's own init arms a tick.
 */
@Module({
  imports: [DbModule],
  providers: [ProbeResultRepository, PartitionService, StorageMaintenanceService],
  exports: [ProbeResultRepository, PartitionService],
})
export class StorageModule {}
