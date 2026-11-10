import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../../core/db/db.service.js';
import type { Incident } from '../../../core/db/types.js';

export interface IncidentFilter {
  status?: 'open' | 'closed';
  endpointId?: string;
  serviceId?: string;
  cursor?: string;
  limit: number;
}

/**
 * Incident reads, always owner-scoped **through `endpoints`** (docs/m6-plan.md
 * §3.10). `incidents` has no foreign key to `endpoints` (plan D13) and keeps a
 * deleted endpoint's rows until the evaluator's next sweep, so the join on
 * `endpoints.id` *and* `endpoints.user_id` is what makes another user's
 * incident and a deleted endpoint's incident both answer exactly like a random
 * UUID: no row.
 */
@Injectable()
export class IncidentRepository {
  constructor(private readonly db: DbService) {}

  async findById(id: string, userId: string): Promise<Incident | undefined> {
    return this.db.kysely
      .selectFrom('incidents as i')
      .innerJoin('endpoints as e', (j) =>
        j.onRef('e.id', '=', 'i.endpoint_id').on('e.user_id', '=', userId),
      )
      .selectAll('i')
      .where('i.id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Newest first: `opened_at DESC, id DESC`. The cursor is resolved to its
   * `(opened_at, id)` inside the same owner-scoped join, so another user's
   * incident id as a cursor resolves to nothing and yields an empty page --
   * it reveals neither the row nor its position.
   */
  async list(userId: string, f: IncidentFilter): Promise<Incident[]> {
    let q = this.db.kysely
      .selectFrom('incidents as i')
      .innerJoin('endpoints as e', (j) =>
        j.onRef('e.id', '=', 'i.endpoint_id').on('e.user_id', '=', userId),
      )
      .selectAll('i');

    if (f.status === 'open') q = q.where('i.closed_at', 'is', null);
    if (f.status === 'closed') q = q.where('i.closed_at', 'is not', null);
    if (f.endpointId !== undefined) q = q.where('i.endpoint_id', '=', f.endpointId);
    if (f.serviceId !== undefined) q = q.where('i.service_id', '=', f.serviceId);
    if (f.cursor !== undefined) {
      const cursor = f.cursor;
      q = q.where(
        sql<boolean>`(i.opened_at, i.id) < (
          SELECT c.opened_at, c.id
          FROM   incidents c
          JOIN   endpoints ce ON ce.id = c.endpoint_id AND ce.user_id = ${userId}
          WHERE  c.id = ${cursor})`,
      );
    }

    return q.orderBy('i.opened_at', 'desc').orderBy('i.id', 'desc').limit(f.limit).execute();
  }
}
