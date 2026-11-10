import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { EndpointHealth } from '../../../core/db/types.js';

/**
 * What the endpoint read needs beyond the endpoint row (docs/m6-plan.md
 * §3.10): the evaluator's stored state, and whether a window covers now.
 * Only ever called after the endpoint itself was found under its owner, and
 * each query is scoped again here so it cannot be the one that forgets.
 */
@Injectable()
export class EndpointHealthRepository {
  constructor(private readonly db: DbService) {}

  async stored(endpointId: string, userId: string): Promise<EndpointHealth | undefined> {
    return this.db.kysely
      .selectFrom('endpoint_health as h')
      .innerJoin('endpoints as e', (j) =>
        j.onRef('e.id', '=', 'h.endpoint_id').on('e.user_id', '=', userId),
      )
      .selectAll('h')
      .where('h.endpoint_id', '=', endpointId)
      .executeTakeFirst();
  }

  /**
   * The earliest start among the windows on this endpoint or its service that
   * cover the database's `now()`; `null` when none does. `[starts_at, ends_at)`.
   */
  async maintenanceSince(
    endpointId: string,
    serviceId: string,
    userId: string,
  ): Promise<Date | null> {
    const row = await this.db.kysely
      .selectFrom('maintenance_windows')
      .select((eb) => eb.fn.min('starts_at').as('since'))
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('endpoint_id', '=', endpointId), eb('service_id', '=', serviceId)]))
      .where(sql<boolean>`starts_at <= now() AND ends_at > now()`)
      .executeTakeFirst();
    return (row?.since as Date | null | undefined) ?? null;
  }
}
