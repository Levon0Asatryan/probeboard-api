import { Module } from '@nestjs/common';
import { DbModule } from '../../core/db/db.module.js';
import { RollupRepository } from './repositories/rollup.repository.js';
import { RollupService } from './services/rollup.service.js';

/** The rollup loop (M5). Every worker runs one; `SKIP LOCKED` makes one fold at a time. */
@Module({
  imports: [DbModule],
  providers: [RollupRepository, RollupService],
  exports: [RollupService],
})
export class RollupModule {}
