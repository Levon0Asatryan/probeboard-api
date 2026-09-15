import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import {
  ConflictError,
  NotFoundError,
  QuotaExceededError,
} from '../../../core/errors/app-error.js';
import { isUniqueViolation } from '../../../core/db/utils/pg-error.js';
import { assertSaveableUrl } from '../../../core/ssrf/host-validator.js';
import { EndpointRepository } from '../../../core/registration/repositories/endpoint.repository.js';
import { HeaderRepository } from '../../../core/registration/repositories/header.repository.js';
import { ServiceRepository } from '../../../core/registration/repositories/service.repository.js';
import { TagRepository } from '../../../core/registration/repositories/tag.repository.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import type { CreateServiceRequest } from '../dto/create-service.dto.js';
import { type ServiceDto, toServiceDto } from '../dto/service-response.dto.js';
import type { UpdateServiceRequest } from '../dto/update-service.dto.js';
import type { ListQuery } from '../dto/list-query.dto.js';
import { HeaderStorageService } from './header-storage.service.js';
import { HeaderValidationService } from './header-validation.service.js';

export interface CreateServiceResult {
  service: ServiceDto;
  /** Only present for the implicit form (B-3) -- the endpoint it attached or created. */
  endpointId?: string;
}

@Injectable()
export class ServicesService {
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

  async create(userId: string, dto: CreateServiceRequest): Promise<CreateServiceResult> {
    if (dto.headers) this.headerValidation.validate(dto.headers);

    if (dto.baseUrl !== undefined) {
      // The schema's refine guarantees `name` is present whenever `baseUrl` is.
      return this.createExplicit(userId, dto.baseUrl, dto.name!, dto);
    }
    // The schema's refine guarantees exactly one of baseUrl/url is present.
    return this.createImplicit(userId, dto.url!, dto.name, dto);
  }

  private async createExplicit(
    userId: string,
    rawBaseUrl: string,
    name: string,
    dto: CreateServiceRequest,
  ): Promise<CreateServiceResult> {
    await assertSaveableUrl(rawBaseUrl, this.ssrfConfig);
    const origin = new URL(rawBaseUrl).origin;

    const service = await this.services
      .create({ user_id: userId, name, base_url: origin })
      .catch((err: unknown) => {
        if (isUniqueViolation(err, 'services_user_base_url_key')) {
          throw new ConflictError('CONFLICT', 'a service already exists at this base URL');
        }
        throw err;
      });

    if (dto.headers && dto.headers.length > 0) {
      const rows = this.headerStorage.toStorageRows(dto.headers, []);
      await this.headers.replaceForService(service.id, userId, rows);
    }
    if (dto.tags && dto.tags.length > 0) {
      await this.tags.replaceForService(
        service.id,
        userId,
        dto.tags.map((t) => ({ key: t.key, value: t.value })),
      );
    }

    return { service: await this.toDto(service.id, userId) };
  }

  /** B-3: attaches to an existing service at the same origin, or creates both service and endpoint. */
  private async createImplicit(
    userId: string,
    rawUrl: string,
    name: string | undefined,
    dto: CreateServiceRequest,
  ): Promise<CreateServiceResult> {
    await assertSaveableUrl(rawUrl, this.ssrfConfig);
    const parsed = new URL(rawUrl);
    const origin = parsed.origin;
    const path = parsed.pathname + parsed.search || '/';

    const endpointId = await this.db.kysely.transaction().execute(async (trx) => {
      await this.users.lockForUpdate(userId, trx);

      let service = await this.services.findByBaseUrl(userId, origin, trx);
      service ??= await this.services.create(
        { user_id: userId, name: name ?? origin, base_url: origin },
        trx,
      );

      const count = await this.endpoints.countForUser(userId, trx);
      if (count >= this.cfg.ENDPOINT_QUOTA_PER_USER) {
        throw new QuotaExceededError(
          `endpoint quota reached: ${String(count)} of ${String(this.cfg.ENDPOINT_QUOTA_PER_USER)} used`,
          { limit: this.cfg.ENDPOINT_QUOTA_PER_USER, count },
        );
      }

      const endpoint = await this.endpoints.create(
        {
          service_id: service.id,
          user_id: userId,
          method: 'GET',
          path,
          interval_s: this.cfg.PROBE_DEFAULT_INTERVAL_S,
          timeout_ms: this.cfg.PROBE_DEFAULT_TIMEOUT_MS,
          max_redirects: this.cfg.PROBE_DEFAULT_MAX_REDIRECTS,
        },
        trx,
      );

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

    const service = await this.services.findByBaseUrl(userId, origin, this.db.kysely);
    return { service: await this.toDto(service!.id, userId), endpointId };
  }

  async get(userId: string, id: string): Promise<ServiceDto> {
    const service = await this.services.findById(id, userId);
    if (!service) throw new NotFoundError('service');
    return this.toDto(id, userId);
  }

  async list(userId: string, query: ListQuery): Promise<ServiceDto[]> {
    const rows = await this.services.list(userId, query);
    return Promise.all(rows.map((row) => this.toDto(row.id, userId)));
  }

  async update(userId: string, id: string, dto: UpdateServiceRequest): Promise<ServiceDto> {
    const existing = await this.services.findById(id, userId);
    if (!existing) throw new NotFoundError('service');

    if (dto.headers) this.headerValidation.validate(dto.headers);

    let baseUrl: string | undefined;
    if (dto.baseUrl !== undefined) {
      await assertSaveableUrl(dto.baseUrl, this.ssrfConfig);
      baseUrl = new URL(dto.baseUrl).origin;
    }

    const updated = await this.services
      .update(id, userId, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err, 'services_user_base_url_key')) {
          throw new ConflictError('CONFLICT', 'a service already exists at this base URL');
        }
        throw err;
      });
    if (!updated) throw new NotFoundError('service');

    if (dto.headers) {
      const existingHeaders = await this.headers.listForService(id, userId);
      const rows = this.headerStorage.toStorageRows(dto.headers, existingHeaders);
      await this.headers.replaceForService(id, userId, rows);
    }
    if (dto.tags) {
      await this.tags.replaceForService(
        id,
        userId,
        dto.tags.map((t) => ({ key: t.key, value: t.value })),
      );
    }

    return this.toDto(id, userId);
  }

  async delete(userId: string, id: string): Promise<void> {
    const deleted = await this.services.delete(id, userId);
    if (!deleted) throw new NotFoundError('service');
  }

  private async toDto(id: string, userId: string): Promise<ServiceDto> {
    const [service, headers, tags] = await Promise.all([
      this.services.findById(id, userId),
      this.headers.listForService(id, userId),
      this.tags.listForService(id, userId),
    ]);
    if (!service) throw new NotFoundError('service');
    return toServiceDto(service, headers, tags);
  }
}
