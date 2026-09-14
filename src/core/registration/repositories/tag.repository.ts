import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, NewTag, Tag } from '../../db/types.js';

export type NewOwnedTag = Omit<NewTag, 'service_id' | 'endpoint_id'>;

@Injectable()
export class TagRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Scoped by owner in the query itself, matching `HeaderRepository`'s own
   * version of this method -- see its comment.
   */
  async listForService(serviceId: string, userId: string): Promise<Tag[]> {
    return this.db.kysely
      .selectFrom('tags')
      .innerJoin('services', 'services.id', 'tags.service_id')
      .select(['tags.id', 'tags.service_id', 'tags.endpoint_id', 'tags.key', 'tags.value'])
      .where('tags.service_id', '=', serviceId)
      .where('services.user_id', '=', userId)
      .orderBy('tags.key', 'asc')
      .execute();
  }

  async listForEndpoint(endpointId: string, userId: string): Promise<Tag[]> {
    return this.db.kysely
      .selectFrom('tags')
      .innerJoin('endpoints', 'endpoints.id', 'tags.endpoint_id')
      .select(['tags.id', 'tags.service_id', 'tags.endpoint_id', 'tags.key', 'tags.value'])
      .where('tags.endpoint_id', '=', endpointId)
      .where('endpoints.user_id', '=', userId)
      .orderBy('tags.key', 'asc')
      .execute();
  }

  /**
   * Same replace-atomically-and-owner-scoped shape as `HeaderRepository`,
   * including the owner-row lock that serializes two concurrent full-set
   * replacements and the ownership check folded into it -- see its comment.
   * Returns `undefined`, not an empty replace, when `serviceId` does not
   * belong to `userId`.
   */
  async replaceForService(
    serviceId: string,
    userId: string,
    rows: NewOwnedTag[],
    executor?: Kysely<Database>,
  ): Promise<Tag[] | undefined> {
    const run = async (trx: Kysely<Database>): Promise<Tag[] | undefined> => {
      const owned = await trx
        .selectFrom('services')
        .select('id')
        .where('id', '=', serviceId)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!owned) return undefined;

      await trx.deleteFrom('tags').where('service_id', '=', serviceId).execute();
      if (rows.length === 0) return [];
      return trx
        .insertInto('tags')
        .values(rows.map((r) => ({ ...r, service_id: serviceId })))
        .returningAll()
        .execute();
    };

    if (executor) return run(executor);
    return this.db.kysely.transaction().execute(run);
  }

  async replaceForEndpoint(
    endpointId: string,
    userId: string,
    rows: NewOwnedTag[],
    executor?: Kysely<Database>,
  ): Promise<Tag[] | undefined> {
    const run = async (trx: Kysely<Database>): Promise<Tag[] | undefined> => {
      const owned = await trx
        .selectFrom('endpoints')
        .select('id')
        .where('id', '=', endpointId)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!owned) return undefined;

      await trx.deleteFrom('tags').where('endpoint_id', '=', endpointId).execute();
      if (rows.length === 0) return [];
      return trx
        .insertInto('tags')
        .values(rows.map((r) => ({ ...r, endpoint_id: endpointId })))
        .returningAll()
        .execute();
    };

    if (executor) return run(executor);
    return this.db.kysely.transaction().execute(run);
  }

  /** Services owned by `userId` carrying the given key:value tag, for filtering. */
  async filterServiceIdsByTag(userId: string, key: string, value: string): Promise<string[]> {
    const rows = await this.db.kysely
      .selectFrom('tags')
      .innerJoin('services', 'services.id', 'tags.service_id')
      .select('tags.service_id as id')
      .where('services.user_id', '=', userId)
      .where('tags.key', '=', key)
      .where('tags.value', '=', value)
      .execute();
    return rows.map((r) => r.id).filter((id): id is string => id !== null);
  }
}
