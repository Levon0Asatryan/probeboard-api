import { Module } from '@nestjs/common';
import { DbModule } from '../../core/db/db.module.js';
import { EvaluatorRepository } from './repositories/evaluator.repository.js';
import { EvaluatorService } from './services/evaluator.service.js';

/** The incident evaluator (M6). Every worker runs one; `SKIP LOCKED` makes one evaluate at a time. */
@Module({
  imports: [DbModule],
  providers: [EvaluatorRepository, EvaluatorService],
  exports: [EvaluatorService],
})
export class IncidentsModule {}
