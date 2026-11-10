import { Module } from '@nestjs/common';
import { EndpointRepository } from '../../core/registration/repositories/endpoint.repository.js';
import { ServiceRepository } from '../../core/registration/repositories/service.repository.js';
import { AuthModule } from '../auth/auth.module.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';
import { IncidentRepository } from './repositories/incident.repository.js';

/** Incident history over HTTP (M6). The worker's evaluator is the only writer. */
@Module({
  imports: [AuthModule],
  controllers: [IncidentsController],
  providers: [IncidentRepository, IncidentsService, ServiceRepository, EndpointRepository],
})
export class IncidentsModule {}
