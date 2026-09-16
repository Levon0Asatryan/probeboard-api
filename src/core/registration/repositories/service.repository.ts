import { Injectable } from '@nestjs/common';
import type { ExpressionBuilder, Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, NewService, Service, ServiceUpdate } from '../../db/types.js';

export interface ListServicesOptions {
  /** Opaque cursor: the `id` of the last row of the previous page. */
  cursor?: string;
  limit: number;
  /** Restricts to services carrying this key:value tag (B-5). Omitted means no restriction. */
  tag?: { key: string; value: string };
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

  /**
   * The tag filter (B-5) is a `LATERAL` join, not a `WHERE EXISTS`
   * subquery or a materialized id list joined in as `id IN (...)`: an id
   * list would bind one parameter per match before `limit` ever trims the
   * result, eventually exceeding Postgres's bind-parameter ceiling instead
   * of returning a page (the defect `services_user_id_id_idx` below and
   * this join shape together replace). `EXISTS` does not have that
   * problem, but it leaves the planner free to choose which side of the
   * join drives -- and a row-count estimate that is wrong immediately
   * after a bulk insert (before autovacuum's autoanalyze catches up) can
   * make it start from `tags` and materialize every match before `limit`
   * ever applies, rather than walking `services` in id order and stopping
   * at the first few matches. `LATERAL`'s correlated subquery can only be
   * the inner side of a nested loop -- Postgres has no plan where it
   * drives -- so the choice that estimate error gets wrong does not exist
   * to make. Confirmed against real data with EXPLAIN (ANALYZE, BUFFERS)
   * under artificially unanalyzed statistics, recorded in
   * docs/m2-verification.md.
   *
   * Split out from `list()`, unexecuted, so `service.repository.test.ts`
   * can `.compile()` it and assert on parameter count without a database --
   * a real regression here needs many matching rows to observe at
   * execution time, but is visible in the query shape alone.
   */
  listQuery(userId: string, options: ListServicesOptions) {
    let query = this.db.kysely
      .selectFrom('services')
      .selectAll('services')
      .where('user_id', '=', userId)
      .orderBy('services.id', 'asc')
      .limit(options.limit);

    if (options.cursor) {
      // Qualified, not bare `id`: once the tag branch below joins in
      // `matching_tag` (itself selecting `tags.id`), an unqualified `id`
      // is ambiguous between the two -- confirmed by removal, Postgres
      // rejects it outright rather than silently picking one.
      query = query.where('services.id', '>', options.cursor);
    }
    if (options.tag) {
      const { key, value } = options.tag;
      query = query.innerJoinLateral(
        (eb: ExpressionBuilder<Database, 'services'>) =>
          eb
            .selectFrom('tags')
            .select('tags.id')
            .whereRef('tags.service_id', '=', 'services.id')
            .where('tags.key', '=', key)
            .where('tags.value', '=', value)
            .limit(1)
            .as('matching_tag'),
        (join) => join.onTrue(),
      );
    }

    return query;
  }

  async list(userId: string, options: ListServicesOptions): Promise<Service[]> {
    return this.listQuery(userId, options).execute();
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
