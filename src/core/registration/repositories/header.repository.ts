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
   * contains, so the repository never needs a partial-update path.
   *
   * Locks the service row first, before the delete. Without it two
   * concurrent replacements of the same owner's headers -- most visibly
   * when the current set is empty -- can each run their DELETE before
   * either INSERT commits, and the stored result becomes the union of both
   * requested sets (or a spurious unique-index failure when the two sets
   * share a name), neither of which is what either caller asked for.
   * Locking serializes the two full replacements the same way
   * `UserRepository.lockForUpdate` already serializes a create against a
   * count elsewhere in this milestone (docs/m2-plan.md §5.3) -- a
   * transaction that also needs to lock the owning user's row must take
   * that lock first, per the users-then-other-rows order `SessionRepository`
   * already documents.
   */
  async replaceForService(
    serviceId: string,
    rows: NewOwnedHeader[],
    executor?: Kysely<Database>,
  ): Promise<Header[]> {
    const run = async (trx: Kysely<Database>): Promise<Header[]> => {
      await trx
        .selectFrom('services')
        .select('id')
        .where('id', '=', serviceId)
        .forUpdate()
        .execute();
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
      await trx
        .selectFrom('endpoints')
        .select('id')
        .where('id', '=', endpointId)
        .forUpdate()
        .execute();
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
