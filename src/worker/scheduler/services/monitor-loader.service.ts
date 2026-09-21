import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError } from '../../../core/errors/app-error.js';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import { parseHeaderEncryptionKey } from '../../../core/crypto/header-cipher.js';
import { decryptHeaderValue } from '../../../core/registration/header-decryption.js';
import { mergeHeaderRows } from '../../../core/registration/header-merge.js';
import { effectiveUrl } from '../../../core/registration/url.js';
import type { EndpointProbeConfig } from '../../probing/index.js';

/** The claimed slot's endpoint no longer exists, or the row it points at is gone. */
export class MonitorNotFoundError extends AppError {
  constructor(endpointId: string) {
    super('MONITOR_NOT_FOUND', `endpoint ${endpointId} has no row to load`, 404);
  }
}

/**
 * Reads one endpoint's full probe configuration -- the endpoint, its
 * service, and their merged headers, decrypted -- and turns it into what
 * `probe()` needs (docs/m4-plan.md §6).
 *
 * **One `REPEATABLE READ` transaction, not three statements at
 * `READ COMMITTED`.** The endpoint, the service and the headers are read
 * separately, but a service's `base_url` and its headers must come from the
 * *same instant*: a `base_url` rotation and a secret-header rotation
 * committing between two of these reads would assemble a probe config that
 * sends the newly rotated credential to the previous origin -- a
 * configuration that never existed in the database at any instant, produced
 * entirely by our own read pattern. `REPEATABLE READ` pins one snapshot for
 * the whole transaction, so every read inside it sees the database as it was
 * at the moment the transaction began, whichever row is read first (D22).
 *
 * The transaction is read-only and takes no locks, so it costs nothing here:
 * bounded by `SCHEDULER_LOAD_BUDGET_MS` at the call site (§3.5), it cannot
 * hold a snapshot open long enough to matter for vacuum.
 *
 * Reads are **not** scoped by `user_id`, unlike every repository in
 * `core/registration/`: those exist for API requests acting on behalf of one
 * user, and a row belonging to someone else must look exactly like a row
 * that does not exist (404, never 403). The scheduler has no such caller --
 * `endpoint_id` came from its own claim, which already ran across every
 * tenant's due work, and reading by id alone is what lets one worker serve
 * the whole fleet.
 */
@Injectable()
export class MonitorLoaderService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private get key(): Buffer {
    return parseHeaderEncryptionKey(this.cfg.HEADER_ENCRYPTION_KEY);
  }

  /**
   * `timeoutMs`, when given, bounds every read in this transaction with
   * `SET LOCAL statement_timeout` on the connection itself -- not merely
   * how long the caller waits for it. `SchedulerService`'s own load budget
   * (D20) previously raced this promise against a JS timer and stopped
   * *awaiting* it on expiry, but the transaction kept running underneath:
   * a slow read holds a checked-out pool connection for however long it
   * actually takes, regardless of whether anyone is still waiting on it, so
   * enough overruns exhaust `DATABASE_POOL_MAX` and stall every other
   * scheduling statement. A cancelled statement surfaces as a rejection,
   * which the caller already treats as a load failure -- abandon the slot.
   */
  async load(endpointId: string, timeoutMs?: number): Promise<EndpointProbeConfig> {
    const key = this.key;

    return this.db.kysely
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        if (timeoutMs !== undefined) {
          await sql`SET LOCAL statement_timeout = ${sql.lit(Math.trunc(timeoutMs))}`.execute(trx);
        }
        const endpoint = await trx
          .selectFrom('endpoints')
          .selectAll()
          .where('id', '=', endpointId)
          .executeTakeFirst();
        if (!endpoint) throw new MonitorNotFoundError(endpointId);

        const service = await trx
          .selectFrom('services')
          .selectAll()
          .where('id', '=', endpoint.service_id)
          .executeTakeFirst();
        // Foreign key makes this unreachable in practice; treated as the same
        // "nothing to load" case rather than assumed away (AGENTS.md).
        if (!service) throw new MonitorNotFoundError(endpointId);

        const serviceHeaders = await trx
          .selectFrom('headers')
          .selectAll()
          .where('service_id', '=', service.id)
          .execute();
        const endpointHeaders = await trx
          .selectFrom('headers')
          .selectAll()
          .where('endpoint_id', '=', endpoint.id)
          .execute();

        const merged = mergeHeaderRows(serviceHeaders, endpointHeaders);
        const headers: Record<string, string> = {};
        for (const h of merged) {
          headers[h.name] = h.is_secret ? decryptHeaderValue(h, key) : (h.value ?? '');
        }

        return {
          monitorId: endpoint.id,
          url: effectiveUrl(service.base_url, endpoint.path),
          method: endpoint.method,
          headers,
          expectedStatus: endpoint.expected_status,
          assertions: endpoint.assertions,
          timeoutMs: endpoint.timeout_ms,
          followRedirects: endpoint.follow_redirects,
          maxRedirects: endpoint.max_redirects,
        };
      });
  }
}
