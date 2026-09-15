import { Injectable } from '@nestjs/common';
import type { ExpressionBuilder, Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, Endpoint, EndpointUpdate, NewEndpoint } from '../../db/types.js';

export interface ListEndpointsOptions {
  cursor?: string;
  limit: number;
  /** Restricts to endpoints carrying this key:value tag (B-5). Omitted means no restriction. */
  tag?: { key: string; value: string };
}

function tagExists(
  eb: ExpressionBuilder<Database, 'endpoints'>,
  tag: { key: string; value: string },
) {
  return eb.exists(
    eb
      .selectFrom('tags')
      .select('tags.id')
      .whereRef('tags.endpoint_id', '=', 'endpoints.id')
      .where('tags.key', '=', tag.key)
      .where('tags.value', '=', tag.value),
  );
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

  /**
   * The tag filter (B-5) is a `WHERE EXISTS` subquery, not a materialized
   * id list joined in as `id IN (...)`: ENDPOINT_QUOTA_PER_USER permits up
   * to 100,000 endpoints, and an id-list join over a large match set would
   * bind one parameter per match before `limit` ever trims the result,
   * eventually exceeding Postgres's bind-parameter ceiling instead of
   * returning a page. `EXISTS` lets the planner filter and paginate in one
   * query, with cursor/limit applied exactly as without a tag.
   *
   * `listForServiceQuery`/`listQuery` are split out, unexecuted, so
   * `endpoint.repository.test.ts` can `.compile()` them and assert on
   * parameter count without a database -- a real regression here needs
   * many matching rows to observe at execution time, but is visible in the
   * query shape alone.
   */
  listForServiceQuery(
    serviceId: string,
    userId: string,
    options: { cursor?: string; limit: number; tag?: { key: string; value: string } },
  ) {
    let query = this.db.kysely
      .selectFrom('endpoints')
      .selectAll()
      .where('service_id', '=', serviceId)
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .limit(options.limit);

    if (options.cursor) {
      query = query.where('id', '>', options.cursor);
    }
    if (options.tag) {
      query = query.where((eb) => tagExists(eb, options.tag!));
    }

    return query;
  }

  async listForService(
    serviceId: string,
    userId: string,
    options: { cursor?: string; limit: number; tag?: { key: string; value: string } },
  ): Promise<Endpoint[]> {
    return this.listForServiceQuery(serviceId, userId, options).execute();
  }

  listQuery(userId: string, options: ListEndpointsOptions) {
    let query = this.db.kysely
      .selectFrom('endpoints')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .limit(options.limit);

    if (options.cursor) {
      query = query.where('id', '>', options.cursor);
    }
    if (options.tag) {
      query = query.where((eb) => tagExists(eb, options.tag!));
    }

    return query;
  }

  async list(userId: string, options: ListEndpointsOptions): Promise<Endpoint[]> {
    return this.listQuery(userId, options).execute();
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
