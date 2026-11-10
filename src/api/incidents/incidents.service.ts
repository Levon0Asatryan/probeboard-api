import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { NotFoundError } from '../../core/errors/app-error.js';
import { EndpointRepository } from '../../core/registration/repositories/endpoint.repository.js';
import { ServiceRepository } from '../../core/registration/repositories/service.repository.js';
import type { IncidentQuery } from './dto/incident-query.dto.js';
import { type IncidentDto, toIncidentDto } from './dto/incident-response.dto.js';
import { IncidentRepository } from './repositories/incident.repository.js';

/** Incident history (D-5, FR-27). Read-only: only the worker's evaluator writes incidents. */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly incidents: IncidentRepository,
    private readonly services: ServiceRepository,
    private readonly endpoints: EndpointRepository,
  ) {}

  async get(userId: string, id: string): Promise<IncidentDto> {
    const incident = await this.incidents.findById(id, userId);
    if (!incident) throw new NotFoundError('incident');
    return toIncidentDto(incident);
  }

  async list(userId: string, query: IncidentQuery): Promise<IncidentDto[]> {
    return this.page(userId, query, {});
  }

  /** `404` for a service that is not the caller's, the same as for one that does not exist. */
  async listForService(userId: string, serviceId: string, query: IncidentQuery) {
    if (!(await this.services.findById(serviceId, userId))) throw new NotFoundError('service');
    return this.page(userId, query, { serviceId });
  }

  async listForEndpoint(userId: string, endpointId: string, query: IncidentQuery) {
    if (!(await this.endpoints.findById(endpointId, userId))) throw new NotFoundError('endpoint');
    return this.page(userId, query, { endpointId });
  }

  private async page(
    userId: string,
    query: IncidentQuery,
    scope: { serviceId?: string; endpointId?: string },
  ): Promise<IncidentDto[]> {
    const rows = await this.incidents.list(userId, {
      ...scope,
      status: query.status,
      cursor: query.cursor,
      // The DTO's bound is structural; MAX_LIST_LIMIT is the configured cap.
      limit: Math.min(query.limit, this.cfg.MAX_LIST_LIMIT),
    });
    return rows.map(toIncidentDto);
  }
}
