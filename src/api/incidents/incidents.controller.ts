import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { SessionGuard, type RequestUser } from '../auth/guards/session.guard.js';
import { zodQuery } from '../common/pipes/zod-validation.pipe.js';
import { incidentQuerySchema, type IncidentQuery } from './dto/incident-query.dto.js';
import type { IncidentDto } from './dto/incident-response.dto.js';
import { IncidentsService } from './incidents.service.js';

/**
 * Incident history (docs/m6-plan.md §3.10): all of the caller's, one by id,
 * and per service and per endpoint (D-5, FR-27). Mounted at the version root
 * because two of the four routes hang off another module's resource path.
 */
@Controller()
@UseGuards(SessionGuard)
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get('incidents')
  async list(
    @CurrentUser() user: RequestUser,
    @Query(zodQuery(incidentQuerySchema)) query: IncidentQuery,
  ): Promise<IncidentDto[]> {
    return this.incidents.list(user.id, query);
  }

  @Get('incidents/:id')
  async get(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDto> {
    return this.incidents.get(user.id, id);
  }

  @Get('services/:id/incidents')
  async listForService(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodQuery(incidentQuerySchema)) query: IncidentQuery,
  ): Promise<IncidentDto[]> {
    return this.incidents.listForService(user.id, id, query);
  }

  @Get('endpoints/:id/incidents')
  async listForEndpoint(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodQuery(incidentQuerySchema)) query: IncidentQuery,
  ): Promise<IncidentDto[]> {
    return this.incidents.listForEndpoint(user.id, id, query);
  }
}
