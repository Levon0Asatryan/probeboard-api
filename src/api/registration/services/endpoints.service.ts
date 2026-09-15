import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import {
  ConflictError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from '../../../core/errors/app-error.js';
import { isUniqueViolation } from '../../../core/db/utils/pg-error.js';
import { assertSaveableUrl } from '../../../core/ssrf/host-validator.js';
import { EndpointRepository } from '../../../core/registration/repositories/endpoint.repository.js';
import { HeaderRepository } from '../../../core/registration/repositories/header.repository.js';
import { ServiceRepository } from '../../../core/registration/repositories/service.repository.js';
import { TagRepository } from '../../../core/registration/repositories/tag.repository.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import type { CreateEndpointRequest } from '../dto/create-endpoint.dto.js';
import { type EndpointDto, toEndpointDto } from '../dto/endpoint-response.dto.js';
import type { ListQuery } from '../dto/list-query.dto.js';
import type { UpdateEndpointRequest } from '../dto/update-endpoint.dto.js';
import { HeaderStorageService } from './header-storage.service.js';
import { HeaderValidationService } from './header-validation.service.js';
import { effectiveUrl } from './url.js';

@Injectable()
export class EndpointsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly services: ServiceRepository,
    private readonly endpoints: EndpointRepository,
    private readonly headers: HeaderRepository,
    private readonly tags: TagRepository,
    private readonly users: UserRepository,
    private readonly headerValidation: HeaderValidationService,
    private readonly headerStorage: HeaderStorageService,
  ) {}

  private get ssrfConfig() {
    return { enabled: this.cfg.SSRF_GUARD_ENABLED, blockedPorts: this.cfg.SSRF_BLOCKED_PORTS };
  }

  private checkInterval(intervalS: number): void {
    if (!this.cfg.PROBE_ALLOWED_INTERVALS_S.includes(intervalS)) {
      throw new ValidationError([
        {
          path: 'intervalS',
          message: `must be one of ${this.cfg.PROBE_ALLOWED_INTERVALS_S.join(', ')}`,
        },
      ]);
    }
  }

  private checkTimeout(timeoutMs: number): void {
    if (timeoutMs > this.cfg.PROBE_MAX_TIMEOUT_MS) {
      throw new ValidationError([
        { path: 'timeoutMs', message: `must not exceed ${String(this.cfg.PROBE_MAX_TIMEOUT_MS)}` },
      ]);
    }
  }

  private checkMaxRedirects(maxRedirects: number): void {
    if (maxRedirects > this.cfg.PROBE_MAX_REDIRECTS_CAP) {
      throw new ValidationError([
        {
          path: 'maxRedirects',
          message: `must not exceed ${String(this.cfg.PROBE_MAX_REDIRECTS_CAP)}`,
        },
      ]);
    }
  }

  async createForService(
    userId: string,
    serviceId: string,
    dto: CreateEndpointRequest,
  ): Promise<EndpointDto> {
    if (dto.headers) this.headerValidation.validate(dto.headers);

    const intervalS = dto.intervalS ?? this.cfg.PROBE_DEFAULT_INTERVAL_S;
    const timeoutMs = dto.timeoutMs ?? this.cfg.PROBE_DEFAULT_TIMEOUT_MS;
    const maxRedirects = dto.maxRedirects ?? this.cfg.PROBE_DEFAULT_MAX_REDIRECTS;
    this.checkInterval(intervalS);
    this.checkTimeout(timeoutMs);
    this.checkMaxRedirects(maxRedirects);

    const endpointId = await this.db.kysely.transaction().execute(async (trx) => {
      await this.users.lockForUpdate(userId, trx);

      const service = await this.services.findById(serviceId, userId, trx);
      if (!service) throw new NotFoundError('service');

      // D10: re-validated on every save, using the joined base+path.
      await assertSaveableUrl(effectiveUrl(service.base_url, dto.path), this.ssrfConfig);

      const count = await this.endpoints.countForUser(userId, trx);
      if (count >= this.cfg.ENDPOINT_QUOTA_PER_USER) {
        throw new QuotaExceededError(
          `endpoint quota reached: ${String(count)} of ${String(this.cfg.ENDPOINT_QUOTA_PER_USER)} used`,
          { limit: this.cfg.ENDPOINT_QUOTA_PER_USER, count },
        );
      }

      const endpoint = await this.endpoints
        .create(
          {
            service_id: serviceId,
            user_id: userId,
            method: dto.method,
            path: dto.path,
            interval_s: intervalS,
            timeout_ms: timeoutMs,
            max_redirects: maxRedirects,
            ...(dto.expectedStatus ? { expected_status: JSON.stringify(dto.expectedStatus) } : {}),
            ...(dto.latencyWarnMs !== undefined ? { latency_warn_ms: dto.latencyWarnMs } : {}),
            ...(dto.failureThreshold !== undefined
              ? { failure_threshold: dto.failureThreshold }
              : {}),
            ...(dto.successThreshold !== undefined
              ? { success_threshold: dto.successThreshold }
              : {}),
            ...(dto.followRedirects !== undefined ? { follow_redirects: dto.followRedirects } : {}),
            ...(dto.assertions ? { assertions: JSON.stringify(dto.assertions) } : {}),
          },
          trx,
        )
        .catch((err: unknown) => {
          if (isUniqueViolation(err, 'endpoints_service_method_path_key')) {
            throw new ConflictError(
              'CONFLICT',
              'an endpoint already exists for this method and path',
            );
          }
          throw err;
        });

      if (dto.headers && dto.headers.length > 0) {
        const rows = this.headerStorage.toStorageRows(dto.headers, []);
        await this.headers.replaceForEndpoint(endpoint.id, userId, rows, trx);
      }
      if (dto.tags && dto.tags.length > 0) {
        await this.tags.replaceForEndpoint(
          endpoint.id,
          userId,
          dto.tags.map((t) => ({ key: t.key, value: t.value })),
          trx,
        );
      }

      return endpoint.id;
    });

    return this.toDto(userId, endpointId);
  }

  async get(userId: string, id: string): Promise<EndpointDto> {
    return this.toDto(userId, id);
  }

  async listForService(userId: string, serviceId: string): Promise<EndpointDto[]> {
    const service = await this.services.findById(serviceId, userId);
    if (!service) throw new NotFoundError('service');
    const rows = await this.endpoints.listForService(serviceId, userId);
    return Promise.all(rows.map((row) => this.toDto(userId, row.id)));
  }

  async list(userId: string, query: ListQuery): Promise<EndpointDto[]> {
    const rows = await this.endpoints.list(userId, query);
    return Promise.all(rows.map((row) => this.toDto(userId, row.id)));
  }

  async update(userId: string, id: string, dto: UpdateEndpointRequest): Promise<EndpointDto> {
    const existing = await this.endpoints.findById(id, userId);
    if (!existing) throw new NotFoundError('endpoint');
    const service = await this.services.findById(existing.service_id, userId);
    if (!service) throw new NotFoundError('endpoint');

    if (dto.headers) this.headerValidation.validate(dto.headers);

    const method = dto.method ?? existing.method;
    const path = dto.path ?? existing.path;
    // D10: unconditional re-validation, even if neither method nor path changed.
    await assertSaveableUrl(effectiveUrl(service.base_url, path), this.ssrfConfig);

    if (dto.intervalS !== undefined) this.checkInterval(dto.intervalS);
    if (dto.timeoutMs !== undefined) this.checkTimeout(dto.timeoutMs);
    if (dto.maxRedirects !== undefined) this.checkMaxRedirects(dto.maxRedirects);

    const updated = await this.endpoints
      .update(id, userId, {
        method,
        path,
        ...(dto.intervalS !== undefined ? { interval_s: dto.intervalS } : {}),
        ...(dto.timeoutMs !== undefined ? { timeout_ms: dto.timeoutMs } : {}),
        ...(dto.expectedStatus ? { expected_status: JSON.stringify(dto.expectedStatus) } : {}),
        ...(dto.latencyWarnMs !== undefined ? { latency_warn_ms: dto.latencyWarnMs } : {}),
        ...(dto.failureThreshold !== undefined ? { failure_threshold: dto.failureThreshold } : {}),
        ...(dto.successThreshold !== undefined ? { success_threshold: dto.successThreshold } : {}),
        ...(dto.followRedirects !== undefined ? { follow_redirects: dto.followRedirects } : {}),
        ...(dto.maxRedirects !== undefined ? { max_redirects: dto.maxRedirects } : {}),
        ...(dto.assertions ? { assertions: JSON.stringify(dto.assertions) } : {}),
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err, 'endpoints_service_method_path_key')) {
          throw new ConflictError(
            'CONFLICT',
            'an endpoint already exists for this method and path',
          );
        }
        throw err;
      });
    if (!updated) throw new NotFoundError('endpoint');

    if (dto.headers) {
      const existingHeaders = await this.headers.listForEndpoint(id, userId);
      const rows = this.headerStorage.toStorageRows(dto.headers, existingHeaders);
      await this.headers.replaceForEndpoint(id, userId, rows);
    }
    if (dto.tags) {
      await this.tags.replaceForEndpoint(
        id,
        userId,
        dto.tags.map((t) => ({ key: t.key, value: t.value })),
      );
    }

    return this.toDto(userId, id);
  }

  async delete(userId: string, id: string): Promise<void> {
    const deleted = await this.endpoints.delete(id, userId);
    if (!deleted) throw new NotFoundError('endpoint');
  }

  async setEnabled(userId: string, id: string, enabled: boolean): Promise<EndpointDto> {
    const updated = await this.endpoints.setEnabled(id, userId, enabled);
    if (!updated) throw new NotFoundError('endpoint');
    return this.toDto(userId, id);
  }

  private async toDto(userId: string, id: string): Promise<EndpointDto> {
    const endpoint = await this.endpoints.findById(id, userId);
    if (!endpoint) throw new NotFoundError('endpoint');
    const [endpointHeaders, serviceHeaders, tags] = await Promise.all([
      this.headers.listForEndpoint(id, userId),
      this.headers.listForService(endpoint.service_id, userId),
      this.tags.listForEndpoint(id, userId),
    ]);
    return toEndpointDto(endpoint, endpointHeaders, serviceHeaders, tags);
  }
}
