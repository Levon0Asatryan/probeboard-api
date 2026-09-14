import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, Endpoint, EndpointUpdate, NewEndpoint } from '../../db/types.js';

export interface ListEndpointsOptions {
  cursor?: string;
  limit: number;
}

@Injectable()
export class EndpointRepository {
  constructor(private readonly db: DbService) {}

  async create(
    values: NewEndpoint,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<Endpoint> {
    return executor.insertInto('endpoints').values(values).returningAll().executeTakeFirstOrThrow();
  }

  async findById(
    id: string,
    userId: string,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<Endpoint | undefined> {
    return executor
      .selectFrom('endpoints')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  async listForService(serviceId: string, userId: string): Promise<Endpoint[]> {
    return this.db.kysely
      .selectFrom('endpoints')
      .selectAll()
      .where('service_id', '=', serviceId)
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .execute();
  }

  async list(userId: string, options: ListEndpointsOptions): Promise<Endpoint[]> {
    let query = this.db.kysely
      .selectFrom('endpoints')
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
    patch: EndpointUpdate,
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<Endpoint | undefined> {
    return executor
      .updateTable('endpoints')
      .set({ ...patch, updated_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
  }

  async setEnabled(id: string, userId: string, enabled: boolean): Promise<Endpoint | undefined> {
    return this.update(id, userId, { enabled });
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await this.db.kysely
      .deleteFrom('endpoints')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /**
   * The count the endpoint quota (B-8) is checked against.
   *
   * Callers that must serialize this against a concurrent create pass a
   * transaction executor that already holds `users.lockForUpdate(userId)` --
   * this method does not lock anything itself (docs/m2-plan.md §5.3).
   */
  async countForUser(userId: string, executor: Kysely<Database> = this.db.kysely): Promise<number> {
    const row = await executor
      .selectFrom('endpoints')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
