import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, Header, NewHeader } from '../../db/types.js';

/** A header row with its owner's id already known; never both id fields. */
export type NewOwnedHeader = Omit<NewHeader, 'service_id' | 'endpoint_id'>;

@Injectable()
export class HeaderRepository {
  constructor(private readonly db: DbService) {}

  async listForService(serviceId: string): Promise<Header[]> {
    return this.db.kysely
      .selectFrom('headers')
      .selectAll()
      .where('service_id', '=', serviceId)
      .orderBy('name', 'asc')
      .execute();
  }

  async listForEndpoint(endpointId: string): Promise<Header[]> {
    return this.db.kysely
      .selectFrom('headers')
      .selectAll()
      .where('endpoint_id', '=', endpointId)
      .orderBy('name', 'asc')
      .execute();
  }

  /**
   * Replaces the full header set for a service, atomically.
   *
   * The API surface (PR4) always sends a full list -- "keep / replace /
   * clear" (docs/m2-plan.md §5.4) is expressed entirely in what that list
   * contains, so the repository never needs a partial-update path. Delete
   * then insert, in one transaction: a reader mid-write sees either the old
   * set or the new one, never a gap.
   */
  async replaceForService(
    serviceId: string,
    rows: NewOwnedHeader[],
    executor?: Kysely<Database>,
  ): Promise<Header[]> {
    const run = async (trx: Kysely<Database>): Promise<Header[]> => {
      await trx.deleteFrom('headers').where('service_id', '=', serviceId).execute();
      if (rows.length === 0) return [];
      return trx
        .insertInto('headers')
        .values(rows.map((r) => ({ ...r, service_id: serviceId })))
        .returningAll()
        .execute();
    };

    if (executor) return run(executor);
    return this.db.kysely.transaction().execute(run);
  }

  /** Same as `replaceForService`, for an endpoint's own headers. */
  async replaceForEndpoint(
    endpointId: string,
    rows: NewOwnedHeader[],
    executor?: Kysely<Database>,
  ): Promise<Header[]> {
    const run = async (trx: Kysely<Database>): Promise<Header[]> => {
      await trx.deleteFrom('headers').where('endpoint_id', '=', endpointId).execute();
      if (rows.length === 0) return [];
      return trx
        .insertInto('headers')
        .values(rows.map((r) => ({ ...r, endpoint_id: endpointId })))
        .returningAll()
        .execute();
    };

    if (executor) return run(executor);
    return this.db.kysely.transaction().execute(run);
  }
}
