import { isSupportedJsonPath } from '../../assertions/json-path-grammar.js';
import type { Db } from '../utils/kysely.js';
import type { EndpointAssertion } from '../types.js';

/**
 * Removes `json_path` assertions whose path predates the supported grammar.
 *
 * M2 stored assertions with any non-empty string as a path; the grammar that
 * decides what the probe evaluator can actually express arrived afterwards
 * (`core/assertions/json-path-grammar.ts`). The DTO now rejects an
 * unsupported path, but only on the *next* create or update — a row already
 * in the table is never revalidated, and the first probe against it would
 * report `ASSERTION_FAILED` on every run forever: an endpoint the operator
 * believes is configured correctly, reporting permanent false downtime
 * (docs/m3-plan.md D48).
 *
 * Deliberately not a migration. The migrator discovers `*.up.sql` files and
 * hands their contents to `client.query`, so a migration could not call the
 * shared grammar at all, and re-expressing the grammar in SQL would be a
 * third copy of the one thing that is supposed to have exactly one (D50).
 * Nothing under `db/migrations/` changes, so the migrator's paired-file rule
 * and its CI job are untouched (D51).
 *
 * The offending entry is **removed** rather than flagged: `EndpointAssertion`
 * has no "disabled" field, the DTO schemas are strict, and the evaluator
 * dispatches only on `type`, so writing an extra key would store fine and
 * change nothing observable. The endpoint keeps probing; its other
 * assertions and its status check are untouched. What was removed is
 * returned (and printed by the CLI) so an operator can rewrite the path into
 * the supported subset and re-add it through the normal API.
 *
 * Idempotent: a second run finds nothing left to remove.
 */

export interface RemovedAssertion {
  endpointId: string;
  removed: EndpointAssertion;
}

export interface AuditOptions {
  /**
   * Awaited after a row is locked and re-read, before its rewrite is issued.
   *
   * A seam for the barrier test that proves the lock does its job: without
   * one, a test can only hope the competing write interleaves in the right
   * place, which `AGENTS.md` explicitly rules out as evidence.
   */
  onRowLocked?: (endpointId: string) => Promise<void>;

  /**
   * Called with each removal as the transaction that removed it commits,
   * before any further row is touched.
   *
   * The removal is permanent the moment its per-row transaction commits, so
   * a record that is only emitted once the whole scan returns is a record
   * that does not exist yet for every row already rewritten: a database
   * error, a `SIGTERM` or a failing stdout partway through would leave those
   * assertions deleted with nothing to reconstruct them from, which is
   * exactly the guarantee the printed record is supposed to provide.
   *
   * Throwing from here aborts the run deliberately. If the recovery record
   * cannot be written down, continuing would destroy further assertions that
   * also could not be recorded.
   */
  onRemoved?: (entry: RemovedAssertion) => void;

  /**
   * Rows per scan page. Exposed so a test can cross a page boundary without
   * seeding {@link SCAN_PAGE_SIZE} endpoints.
   */
  scanPageSize?: number;
}

/**
 * Rows read per scan page.
 *
 * The scan cannot be one unbounded `SELECT`: it would materialize every
 * endpoint's full assertions array in this process before repairing a single
 * row, clean endpoints included. The endpoint quota allows 100,000 per user
 * and nothing bounds a deployment, so the audit D48 makes mandatory before
 * M4 starts probing is exactly the run that would exhaust memory, or hand
 * PostgreSQL one enormous read, on the largest database.
 */
export const SCAN_PAGE_SIZE = 500;

function isUnsupported(assertion: EndpointAssertion): boolean {
  return assertion.type === 'json_path' && !isSupportedJsonPath(assertion.path);
}

export async function auditJsonPathAssertions(
  db: Db,
  options: AuditOptions = {},
): Promise<RemovedAssertion[]> {
  const pageSize = options.scanPageSize ?? SCAN_PAGE_SIZE;
  const removed: RemovedAssertion[] = [];
  let after: string | undefined;

  // Paged rather than one unbounded read, and each page is repaired before
  // the next is fetched, so memory stays bounded by one page however large
  // the table is.
  //
  // Keyset (`ORDER BY id`, `WHERE id > last`) rather than OFFSET: this scan
  // runs while rows are being rewritten, and OFFSET re-counts from the start
  // on every page. Paging on the primary key is stable because the audit
  // never changes an id.
  for (;;) {
    // An unlocked scan, only to decide which rows are worth locking: every
    // row it nominates is re-read and re-judged under its own lock below, so
    // a stale answer here costs at most one wasted lock and can never decide
    // the rewrite. Locking every endpoint to inspect it is the alternative.
    const base = db
      .selectFrom('endpoints')
      .select(['id', 'assertions'])
      .orderBy('id')
      .limit(pageSize);
    const page = await (after === undefined ? base : base.where('id', '>', after)).execute();
    if (page.length === 0) break;
    after = page[page.length - 1].id;

    const candidates = page.filter((row) => row.assertions.some(isUnsupported)).map((r) => r.id);

    for (const endpointId of candidates) {
      // One transaction per row rather than one for the whole table: the API
      // stays up while this runs, and a single long transaction would hold a
      // lock on every endpoint for the duration.
      const perRow = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('endpoints')
          .select(['id', 'assertions'])
          .where('id', '=', endpointId)
          .forUpdate()
          .executeTakeFirst();
        if (!row) return [];

        // Judged from the locked read, never from the scan above: this is a
        // read-modify-write on a live table, so a concurrent PATCH committing
        // between the two would otherwise be overwritten by a stale copy
        // (docs/m3-plan.md D54, AGENTS.md "read-modify-write on shared rows").
        const unsupported = row.assertions.filter(isUnsupported);
        if (unsupported.length === 0) return [];
        const kept = row.assertions.filter((assertion) => !isUnsupported(assertion));

        await options.onRowLocked?.(endpointId);

        await trx
          .updateTable('endpoints')
          .set({ assertions: JSON.stringify(kept), updated_at: new Date() })
          .where('id', '=', endpointId)
          .execute();

        return unsupported.map((assertion) => ({ endpointId, removed: assertion }));
      });

      // After the transaction resolves, which is after it commits: the record
      // is emitted for work that is already durable, never for a rewrite that
      // might still roll back.
      for (const entry of perRow) options.onRemoved?.(entry);

      removed.push(...perRow);
    }

    // A short page is the last one; without this the loop costs one extra
    // empty round trip per run.
    if (page.length < pageSize) break;
  }

  return removed;
}
