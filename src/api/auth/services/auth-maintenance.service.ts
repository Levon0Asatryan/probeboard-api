import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { describeError } from '../../../core/errors/describe.js';
import { AuthAttemptRepository } from '../repositories/auth-attempt.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';

/**
 * Keeps `sessions` and `auth_attempts` bounded.
 *
 * Both would otherwise grow without limit, which is the same defect this
 * project criticises elsewhere. M5 owns retention across the whole schema and
 * will absorb this; until then a small interval here is better than an
 * unbounded table.
 *
 * It runs in the api rather than the worker only because `api/auth` is not
 * importable from `worker/` — the layer rule that keeps the two separable.
 */
@Injectable()
export class AuthMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly sessions: SessionRepository,
    private readonly attempts: AuthAttemptRepository,
    @InjectPinoLogger(AuthMaintenanceService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    // Once at startup, because an instance that restarts more often than the
    // sweep interval would otherwise never reach the first callback and both
    // tables would grow without bound. Not awaited: boot must not wait on
    // housekeeping, and sweep() never throws.
    void this.sweep();

    // The interval is its own setting rather than the retention period: those
    // are different questions, and tying them together is what created the
    // gap above.
    this.timer = setInterval(() => void this.sweep(), this.cfg.AUTH_SWEEP_INTERVAL_MS);
    // unref so a pending sweep never holds the process open during shutdown.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Expired sessions are kept for a grace period rather than deleted at
   * expiry, so an operator can still answer "was this session live at the
   * time?" after an incident.
   */
  async sweep(now: Date = new Date()): Promise<{ sessions: number; attempts: number }> {
    const retention = this.cfg.AUTH_ATTEMPT_RETENTION_MS;

    try {
      const [sessions, attempts] = await Promise.all([
        this.sessions.pruneExpired(
          new Date(now.getTime() - this.cfg.SESSION_RETENTION_DAYS * 86_400_000),
        ),
        this.attempts.pruneBefore(new Date(now.getTime() - retention)),
      ]);

      if (sessions > 0 || attempts > 0) {
        this.logger.info({ sessions, attempts }, 'auth housekeeping removed expired rows');
      }
      return { sessions, attempts };
    } catch (err) {
      // Housekeeping failing must not take the api down; it runs again next
      // interval. Never swallowed silently.
      this.logger.error({ cause: describeError(err) }, 'auth housekeeping failed');
      return { sessions: 0, attempts: 0 };
    }
  }
}
