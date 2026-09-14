import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, NewService, Service, ServiceUpdate } from '../../db/types.js';

export interface ListServicesOptions {
  /** Opaque cursor: the `id` of the last row of the previous page. */
  cursor?: string;
  limit: number;
}

@Injectable()
export class ServiceRepository {
  constructor(private readonly db: DbService) {}

  async create(values: NewService, executor: Kysely<Database> = this.db.kysely): Promise<Service> {
    return executor.insertInto('services').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /**
   * Scoped by owner in the query itself, not checked afterward -- a row
   * belonging to another user simply does not match, and the caller turns
   * `undefined` into a 404, never a 403 (docs/m2-plan.md §2.2).
   */
  async findById(
    id: string,
    userId: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<Service | undefined> {
    return executor
      .selectFrom('services')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  /**
   * The lookup B-3's implicit-creation flow needs: "does this user already
   * have a service at this origin". `base_url` is expected already
   * normalized by the caller (scheme + host [+ port], no path).
   */
  async findByBaseUrl(
    userId: string,
    baseUrl: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<Service | undefined> {
    return executor
      .selectFrom('services')
      .selectAll()
      .where('user_id', '=', userId)
      .where('base_url', '=', baseUrl)
      .executeTakeFirst();
  }

  async list(userId: string, options: ListServicesOptions): Promise<Service[]> {
    let query = this.db.kysely
      .selectFrom('services')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .limit(options.limit);

    if (options.cursor) {
      query = query.where('id', '>', options.cursor);
    }

    return query.execute();
  }

  async update(
    id: string,
    userId: string,
    patch: ServiceUpdate,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<Service | undefined> {
    return executor
      .updateTable('services')
      .set({ ...patch, updated_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
  }

  /** Cascades to the service's endpoints, headers and tags (FK ON DELETE CASCADE). */
  async delete(id: string, userId: string): Promise<boolean> {
    const result = await this.db.kysely
      .deleteFrom('services')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
