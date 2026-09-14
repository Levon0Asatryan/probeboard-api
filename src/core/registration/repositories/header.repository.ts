import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DbService } from '../../db/db.service.js';
import type { Database, Header, NewHeader } from '../../db/types.js';

/** A header row with its owner's id already known; never both id fields. */
export type NewOwnedHeader = Omit<NewHeader, 'service_id' | 'endpoint_id'>;

@Injectable()
export class HeaderRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Scoped by owner in the query itself, matching `ServiceRepository`/
   * `EndpointRepository` -- a service that exists but belongs to someone
   * else returns the same empty list as one that does not exist at all,
   * so a caller cannot use this to learn that a foreign id is valid.
   */
  async listForService(serviceId: string, userId: string): Promise<Header[]> {
    return this.db.kysely
      .selectFrom('headers')
      .innerJoin('services', 'services.id', 'headers.service_id')
      .select([
        'headers.id',
        'headers.service_id',
        'headers.endpoint_id',
        'headers.name',
        'headers.is_secret',
        'headers.value',
        'headers.secret_ciphertext',
        'headers.secret_iv',
        'headers.secret_auth_tag',
        'headers.created_at',
        'headers.updated_at',
      ])
      .where('headers.service_id', '=', serviceId)
      .where('services.user_id', '=', userId)
      .orderBy('headers.name', 'asc')
      .execute();
  }

  async listForEndpoint(endpointId: string, userId: string): Promise<Header[]> {
    return this.db.kysely
      .selectFrom('headers')
      .innerJoin('endpoints', 'endpoints.id', 'headers.endpoint_id')
      .select([
        'headers.id',
        'headers.service_id',
        'headers.endpoint_id',
        'headers.name',
        'headers.is_secret',
        'headers.value',
        'headers.secret_ciphertext',
        'headers.secret_iv',
        'headers.secret_auth_tag',
        'headers.created_at',
        'headers.updated_at',
      ])
      .where('headers.endpoint_id', '=', endpointId)
      .where('endpoints.user_id', '=', userId)
      .orderBy('headers.name', 'asc')
      .execute();
  }

  /**
   * Replaces the full header set for a service, atomically -- or does
   * nothing and returns `undefined` if `serviceId` does not belong to
   * `userId`, the same "404 not 403" contract `ServiceRepository`/
   * `EndpointRepository` already use. Without `userId` scoping this method
   * would replace any service's headers given only its id, regardless of
   * who submitted the request -- exactly the disclosure/tamper risk 404 vs
   * 403 exists to close, just reached through a different repository.
   *
   * The API surface (PR4) always sends a full list -- "keep / replace /
   * clear" (docs/m2-plan.md §5.4) is expressed entirely in what that list
   * contains, so the repository never needs a partial-update path.
   *
   * Locks the service row first, before the delete, with the ownership
   * check folded into the same `SELECT ... FOR UPDATE` -- one statement,
   * so there is no separate existence check to forget. Without the lock,
   * two concurrent replacements of the same owner's headers -- most
   * visibly when the current set is empty -- can each run their DELETE
   * before either INSERT commits, and the stored result becomes the union
   * of both requested sets (or a spurious unique-index failure when the
   * two sets share a name), neither of which is what either caller asked
   * for. Locking serializes the two full replacements the same way
   * `UserRepository.lockForUpdate` already serializes a create against a
   * count elsewhere in this milestone (docs/m2-plan.md §5.3) -- a
   * transaction that also needs to lock the owning user's row must take
   * that lock first, per the users-then-other-rows order `SessionRepository`
   * already documents.
   */
  async replaceForService(
    serviceId: string,
    userId: string,
    rows: NewOwnedHeader[],
    executor?: Kysely<Database>,
  ): Promise<Header[] | undefined> {
    const run = async (trx: Kysely<Database>): Promise<Header[] | undefined> => {
      const owned = await trx
        .selectFrom('services')
        .select('id')
        .where('id', '=', serviceId)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!owned) return undefined;

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
    userId: string,
    rows: NewOwnedHeader[],
    executor?: Kysely<Database>,
  ): Promise<Header[] | undefined> {
    const run = async (trx: Kysely<Database>): Promise<Header[] | undefined> => {
      const owned = await trx
        .selectFrom('endpoints')
        .select('id')
        .where('id', '=', endpointId)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!owned) return undefined;

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
