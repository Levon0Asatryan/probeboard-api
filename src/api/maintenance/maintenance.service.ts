import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { DbService } from '../../core/db/db.service.js';
import { AppError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { EndpointRepository } from '../../core/registration/repositories/endpoint.repository.js';
import { ServiceRepository } from '../../core/registration/repositories/service.repository.js';
import { UserRepository } from '../../core/users/repositories/user.repository.js';
import type {
  CreateMaintenanceWindowRequest,
  MaintenanceWindowQuery,
  UpdateMaintenanceWindowRequest,
} from './dto/maintenance-window.dto.js';
import {
  type MaintenanceWindowDto,
  toMaintenanceWindowDto,
} from './dto/maintenance-window-response.dto.js';
import { MaintenanceWindowRepository } from './repositories/maintenance-window.repository.js';

const DAY_MS = 86_400_000;

/**
 * Maintenance windows (docs/m6-plan.md §3.7, D20).
 *
 * A window's effect is decided when each probe result is **written**: the
 * worker flags a result whose `started_at` a window covered. So creating,
 * editing or deleting one never rewrites recorded results or past incidents,
 * and a window wholly in the past could only pretend to apply -- `endsAt` at
 * or before now is refused on create and on edit. A `startsAt` in the past is
 * accepted: the window applies from the moment it is saved.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly windows: MaintenanceWindowRepository,
    private readonly services: ServiceRepository,
    private readonly endpoints: EndpointRepository,
    private readonly users: UserRepository,
  ) {}

  /**
   * Counted under the user row lock the endpoint quota already takes (M2
   * §5.3), then inserted in the same transaction: a separate count would let
   * two concurrent creates both see room for one.
   */
  async create(userId: string, dto: CreateMaintenanceWindowRequest): Promise<MaintenanceWindowDto> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    const created = await this.db.kysely.transaction().execute(async (trx) => {
      await this.users.lockForUpdate(userId, trx);

      const target =
        dto.serviceId !== undefined
          ? await this.services.findById(dto.serviceId, userId, trx)
          : await this.endpoints.findById(dto.endpointId!, userId, trx);
      if (!target) throw new NotFoundError(dto.serviceId !== undefined ? 'service' : 'endpoint');

      // The clock is read after the lock, not at request entry: a create that
      // waited behind another must judge "in the past" as of now (AGENTS.md).
      this.checkTimes(startsAt, endsAt, Date.now());

      const count = await this.windows.countForUser(userId, trx);
      const limit = this.cfg.MAINTENANCE_WINDOW_QUOTA_PER_USER;
      if (count >= limit) {
        throw new AppError(
          'MAINTENANCE_WINDOW_QUOTA_EXCEEDED',
          `maintenance window quota reached: ${String(count)} of ${String(limit)} stored`,
          409,
          { limit, count },
        );
      }

      return this.windows.insert(
        {
          user_id: userId,
          service_id: dto.serviceId ?? null,
          endpoint_id: dto.endpointId ?? null,
          starts_at: startsAt,
          ends_at: endsAt,
          reason: dto.reason ?? null,
        },
        trx,
      );
    });
    return toMaintenanceWindowDto(created, Date.now());
  }

  /** The window row locked, the stored values merged with the request, the whole re-checked. */
  async update(
    userId: string,
    id: string,
    dto: UpdateMaintenanceWindowRequest,
  ): Promise<MaintenanceWindowDto> {
    const updated = await this.db.kysely.transaction().execute(async (trx) => {
      const current = await this.windows.findById(id, userId, trx, { forUpdate: true });
      if (!current) throw new NotFoundError('maintenance window');

      const startsAt = dto.startsAt !== undefined ? new Date(dto.startsAt) : current.starts_at;
      const endsAt = dto.endsAt !== undefined ? new Date(dto.endsAt) : current.ends_at;
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new ValidationError([{ path: 'endsAt', message: 'must be after startsAt' }]);
      }
      this.checkTimes(startsAt, endsAt, Date.now());

      return this.windows.update(
        id,
        userId,
        {
          starts_at: startsAt,
          ends_at: endsAt,
          reason: dto.reason !== undefined ? dto.reason : current.reason,
        },
        trx,
      );
    });
    return toMaintenanceWindowDto(updated, Date.now());
  }

  async get(userId: string, id: string): Promise<MaintenanceWindowDto> {
    const w = await this.windows.findById(id, userId);
    if (!w) throw new NotFoundError('maintenance window');
    return toMaintenanceWindowDto(w, Date.now());
  }

  async list(userId: string, query: MaintenanceWindowQuery): Promise<MaintenanceWindowDto[]> {
    const rows = await this.windows.list(userId, {
      serviceId: query.serviceId,
      endpointId: query.endpointId,
      active: query.active,
      cursor: query.cursor,
      limit: Math.min(query.limit, this.cfg.MAX_LIST_LIMIT),
    });
    const now = Date.now();
    return rows.map((w) => toMaintenanceWindowDto(w, now));
  }

  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.windows.delete(id, userId))) throw new NotFoundError('maintenance window');
  }

  private checkTimes(startsAt: Date, endsAt: Date, now: number): void {
    if (endsAt.getTime() <= now) {
      throw new AppError(
        'MAINTENANCE_WINDOW_IN_PAST',
        'a window must end in the future: it applies only to results written while it is open',
        400,
      );
    }
    const maxDays = this.cfg.MAINTENANCE_MAX_DURATION_DAYS;
    if (endsAt.getTime() - startsAt.getTime() > maxDays * DAY_MS) {
      throw new AppError(
        'MAINTENANCE_WINDOW_TOO_LONG',
        `a window may last at most ${String(maxDays)} days`,
        400,
        { limit: maxDays },
      );
    }
  }
}
