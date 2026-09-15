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
import { assertPathBytes, canonicalPath, effectiveUrl } from './url.js';

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

  /**
   * Checked against the *canonical* path (post-URL-parse), not the raw
   * request string: URL canonicalization can expand a value through
   * percent-encoding, so validating the pre-parse string would let a
   * value that is under the cap before parsing land over it after.
   */
  private checkPathBytes(path: string): void {
    assertPathBytes(path, this.cfg.MAX_ENDPOINT_PATH_BYTES);
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

    // SSRF validation does real DNS resolution against a user-controlled
    // hostname -- run it before opening the transaction so a slow or
    // attacker-stallable lookup never happens while the user row lock is
    // held. Re-validated below only if base_url changed since this read.
    const preService = await this.services.findById(serviceId, userId);
    if (!preService) throw new NotFoundError('service');
    const prePath = canonicalPath(preService.base_url, dto.path);
    this.checkPathBytes(prePath);
    await assertSaveableUrl(effectiveUrl(preService.base_url, prePath), this.ssrfConfig);

    const endpointId = await this.db.kysely.transaction().execute(async (trx) => {
      await this.users.lockForUpdate(userId, trx);

      const service = await this.services.findById(serviceId, userId, trx);
      if (!service) throw new NotFoundError('service');

      // Canonical before anything else touches it: `orders`, `/orders` and
      // `/a/../orders` all resolve to the same target, and the unique index
      // below only catches duplicates that are byte-identical strings.
      const path = canonicalPath(service.base_url, dto.path);
      this.checkPathBytes(path);
      // D10: re-validated on every save, using the joined base+path -- but
      // only re-run the DNS lookup if base_url actually changed since the
      // unlocked pre-check above (a concurrent update to the service row
      // between that read and this lock), since the path is unchanged.
      if (service.base_url !== preService.base_url) {
        await assertSaveableUrl(effectiveUrl(service.base_url, path), this.ssrfConfig);
      }

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
            path,
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

  async listForService(
    userId: string,
    serviceId: string,
    query: ListQuery,
  ): Promise<EndpointDto[]> {
    const service = await this.services.findById(serviceId, userId);
    if (!service) throw new NotFoundError('service');

    // The DTO's own bound is a generous structural ceiling, not the real
    // cap -- MAX_LIST_LIMIT is configured (§5.5).
    const limit = Math.min(query.limit, this.cfg.MAX_LIST_LIMIT);
    const rows = await this.endpoints.listForService(serviceId, userId, {
      cursor: query.cursor,
      limit,
    });
    return Promise.all(rows.map((row) => this.toDto(userId, row.id)));
  }

  async list(userId: string, query: ListQuery): Promise<EndpointDto[]> {
    // The DTO's own bound is a generous structural ceiling, not the real
    // cap -- MAX_LIST_LIMIT is configured (§5.5).
    const limit = Math.min(query.limit, this.cfg.MAX_LIST_LIMIT);
    const rows = await this.endpoints.list(userId, { ...query, limit });
    return Promise.all(rows.map((row) => this.toDto(userId, row.id)));
  }

  /**
   * One transaction, the endpoint row locked first (D10's re-validation
   * still reads the service row, but only the endpoint row needs locking
   * here -- nothing else in this method's own writes touches the service).
   * Locking first, before computing `method`/`path`, closes two gaps at
   * once: a header "keep" resolved from a pre-lock read could be replaced
   * by a concurrent PATCH's rotation before this one's replace runs and
   * would then restore the stale ciphertext, and writing back `method`/
   * `path` unconditionally (copied from a pre-lock read) could silently
   * revert a concurrent PATCH's change to the field this one never asked
   * to touch. Only fields actually present in `dto` are written; `method`/
   * `path` are still read for D10's re-validation even when unchanged.
   */
  async update(userId: string, id: string, dto: UpdateEndpointRequest): Promise<EndpointDto> {
    if (dto.headers) this.headerValidation.validate(dto.headers);

    // SSRF validation does real DNS resolution against a user-controlled
    // hostname -- run it before opening the transaction so it never happens
    // while the endpoint row lock is held. Re-validated below only if the
    // joined base+path changed since this unlocked read.
    const preExisting = await this.endpoints.findById(id, userId);
    if (!preExisting) throw new NotFoundError('endpoint');
    const preService = await this.services.findById(preExisting.service_id, userId);
    if (!preService) throw new NotFoundError('endpoint');
    const prePath =
      dto.path !== undefined ? canonicalPath(preService.base_url, dto.path) : preExisting.path;
    if (dto.path !== undefined) this.checkPathBytes(prePath);
    const preUrl = effectiveUrl(preService.base_url, prePath);
    await assertSaveableUrl(preUrl, this.ssrfConfig);

    await this.db.kysely.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('endpoints')
        .selectAll()
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) throw new NotFoundError('endpoint');

      const service = await trx
        .selectFrom('services')
        .selectAll()
        .where('id', '=', existing.service_id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!service) throw new NotFoundError('endpoint');

      // existing.path is already canonical (stored that way at create/last
      // update); only a newly-supplied path needs canonicalizing here.
      const path =
        dto.path !== undefined ? canonicalPath(service.base_url, dto.path) : existing.path;
      if (dto.path !== undefined) this.checkPathBytes(path);
      // D10: unconditional re-validation, even if neither method nor path
      // changed -- but only re-run the DNS lookup if the joined base+path
      // actually differs from the unlocked pre-check above (a concurrent
      // change to the service or endpoint row between that read and this lock).
      const url = effectiveUrl(service.base_url, path);
      if (url !== preUrl) {
        await assertSaveableUrl(url, this.ssrfConfig);
      }

      if (dto.intervalS !== undefined) this.checkInterval(dto.intervalS);
      if (dto.timeoutMs !== undefined) this.checkTimeout(dto.timeoutMs);
      if (dto.maxRedirects !== undefined) this.checkMaxRedirects(dto.maxRedirects);

      await this.endpoints
        .update(
          id,
          userId,
          {
            ...(dto.method !== undefined ? { method: dto.method } : {}),
            ...(dto.path !== undefined ? { path } : {}),
            ...(dto.intervalS !== undefined ? { interval_s: dto.intervalS } : {}),
            ...(dto.timeoutMs !== undefined ? { timeout_ms: dto.timeoutMs } : {}),
            ...(dto.expectedStatus ? { expected_status: JSON.stringify(dto.expectedStatus) } : {}),
            ...(dto.latencyWarnMs !== undefined ? { latency_warn_ms: dto.latencyWarnMs } : {}),
            ...(dto.failureThreshold !== undefined
              ? { failure_threshold: dto.failureThreshold }
              : {}),
            ...(dto.successThreshold !== undefined
              ? { success_threshold: dto.successThreshold }
              : {}),
            ...(dto.followRedirects !== undefined ? { follow_redirects: dto.followRedirects } : {}),
            ...(dto.maxRedirects !== undefined ? { max_redirects: dto.maxRedirects } : {}),
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

      if (dto.headers) {
        const existingHeaders = await trx
          .selectFrom('headers')
          .selectAll()
          .where('endpoint_id', '=', id)
          .execute();
        const rows = this.headerStorage.toStorageRows(dto.headers, existingHeaders);
        await this.headers.replaceForEndpoint(id, userId, rows, trx);
      }
      if (dto.tags) {
        await this.tags.replaceForEndpoint(
          id,
          userId,
          dto.tags.map((t) => ({ key: t.key, value: t.value })),
          trx,
        );
      }
    });

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
