import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, NewTag, Tag } from '../../db/types.js';

export type NewOwnedTag = Omit<NewTag, 'service_id' | 'endpoint_id'>;

@Injectable()
export class TagRepository {
  constructor(private readonly db: DbService) {}

  async listForService(serviceId: string): Promise<Tag[]> {
    return this.db.kysely
      .selectFrom('tags')
      .selectAll()
      .where('service_id', '=', serviceId)
      .orderBy('key', 'asc')
      .execute();
  }

  async listForEndpoint(endpointId: string): Promise<Tag[]> {
    return this.db.kysely
      .selectFrom('tags')
      .selectAll()
      .where('endpoint_id', '=', endpointId)
      .orderBy('key', 'asc')
      .execute();
  }

  /**
   * Same replace-atomically shape as `HeaderRepository`, including the
   * owner-row lock that serializes two concurrent full-set replacements --
   * see its comment.
   */
  async replaceForService(
    serviceId: string,
    rows: NewOwnedTag[],
    executor?: Kysely<Database>,
  ): Promise<Tag[]> {
    const run = async (trx: Kysely<Database>): Promise<Tag[]> => {
      await trx
        .selectFrom('services')
        .select('id')
        .where('id', '=', serviceId)
        .forUpdate()
        .execute();
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
    rows: NewOwnedTag[],
    executor?: Kysely<Database>,
  ): Promise<Tag[]> {
    const run = async (trx: Kysely<Database>): Promise<Tag[]> => {
      await trx
        .selectFrom('endpoints')
        .select('id')
        .where('id', '=', endpointId)
        .forUpdate()
        .execute();
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
