import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Database, MaintenanceWindow } from '../../../core/db/types.js';

export interface MaintenanceWindowFilter {
  serviceId?: string;
  endpointId?: string;
  active?: boolean;
  cursor?: string;
  limit: number;
}

/**
 * Maintenance windows, every statement scoped by `user_id`. The schema holds
 * the owner equal to the target's owner (0011's composite keys), and a
 * window's target deleted takes the window with it (cascade), so the owner
 * column alone is the whole tenant boundary here.
 */
@Injectable()
export class MaintenanceWindowRepository {
  constructor(private readonly db: DbService) {}

  async insert(
    values: {
      user_id: string;
      service_id: string | null;
      endpoint_id: string | null;
      starts_at: Date;
      ends_at: Date;
      reason: string | null;
    },
    executor: Kysely<Database>,
  ): Promise<MaintenanceWindow> {
    return executor
      .insertInto('maintenance_windows')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Every stored window, ended ones included (docs/m6-plan.md §3.7). */
  async countForUser(userId: string, executor: Kysely<Database>): Promise<number> {
    const row = await executor
      .selectFrom('maintenance_windows')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async findById(
    id: string,
    userId: string,
    executor: Kysely<Database> = this.db.kysely,
    opts: { forUpdate?: boolean } = {},
  ): Promise<MaintenanceWindow | undefined> {
    let q = executor
      .selectFrom('maintenance_windows')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async update(
    id: string,
    userId: string,
    values: { starts_at: Date; ends_at: Date; reason: string | null },
    executor: Kysely<Database>,
  ): Promise<MaintenanceWindow> {
    return executor
      .updateTable('maintenance_windows')
      .set({ ...values, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await this.db.kysely
      .deleteFrom('maintenance_windows')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  /**
   * Latest start first: `starts_at DESC, id DESC`. The cursor is resolved
   * inside the owner scope, so another user's id pages nothing.
   */
  async list(userId: string, f: MaintenanceWindowFilter): Promise<MaintenanceWindow[]> {
    let q = this.db.kysely.selectFrom('maintenance_windows as w').selectAll('w');
    q = q.where('w.user_id', '=', userId);
    if (f.serviceId !== undefined) q = q.where('w.service_id', '=', f.serviceId);
    if (f.endpointId !== undefined) q = q.where('w.endpoint_id', '=', f.endpointId);
    if (f.active === true) {
      q = q.where(sql<boolean>`w.starts_at <= now() AND w.ends_at > now()`);
    } else if (f.active === false) {
      q = q.where(sql<boolean>`NOT (w.starts_at <= now() AND w.ends_at > now())`);
    }
    if (f.cursor !== undefined) {
      const cursor = f.cursor;
      q = q.where(
        sql<boolean>`(w.starts_at, w.id) < (
          SELECT c.starts_at, c.id FROM maintenance_windows c
          WHERE  c.id = ${cursor} AND c.user_id = ${userId})`,
      );
    }
    return q.orderBy('w.starts_at', 'desc').orderBy('w.id', 'desc').limit(f.limit).execute();
  }
}
