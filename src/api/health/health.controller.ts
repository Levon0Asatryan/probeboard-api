import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { DbService } from '../../core/db/db.service.js';
import { describeError } from '../../core/errors/describe.js';
import { LIVENESS_PATH, READINESS_PATH } from './constants.js';

@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(HealthController.name) private readonly logger: PinoLogger,
  ) {}

  /** Liveness: the process is running. Deliberately touches no dependency. */
  @Get(LIVENESS_PATH)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the process can actually serve traffic. */
  @Get(READINESS_PATH)
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.query();
    } catch (err) {
      // Log the cause, return only a stable code. The detail is useful to an
      // operator and is not something to hand to an unauthenticated caller.
      this.logger.error({ cause: describeError(err) }, 'readiness check failed');
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message: 'database is not reachable',
      });
    }
    return { status: 'ok', database: 'ok' };
  }

  /**
   * Bounded by its own deadline.
   *
   * The pool's `connectionTimeoutMillis` bounds *acquiring* a connection, not a
   * query on one already established. A database that accepts connections but
   * stops answering — disk full, lock contention — would otherwise leave this
   * request open indefinitely and pile readiness checks up behind it.
   *
   * The timeout bounds the response, not the query: PostgreSQL keeps executing
   * until its own statement timeout. That is the right trade for a health
   * check, which needs to answer rather than to cancel work.
   */
  private async query(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`readiness query exceeded ${this.cfg.HEALTH_TIMEOUT_MS}ms`)),
        this.cfg.HEALTH_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([sql`SELECT 1`.execute(this.db.kysely), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
