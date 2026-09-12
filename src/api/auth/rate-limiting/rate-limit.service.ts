import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import type { AuthAttemptScope } from '../../../core/db/types.js';
import { normalizeEmail } from '../../../core/users/email.js';
import { AuthAttemptRepository } from '../rate-limiting/rate-limit.repository.js';

export interface RateLimitVerdict {
  allowed: boolean;
  /** Which limit refused it, for the log. Never returned to the caller. */
  scope?: AuthAttemptScope;
  retryAfterSeconds: number;
}

/**
 * Authentication rate limiting (NFR-14, A-6).
 *
 * Two limits, because A-6 describes two threats:
 *
 * - **by IP**, counting every attempt, against one host hammering the endpoint.
 * - **by email**, counting only failures, against credential stuffing at one
 *   account from many hosts. An attacker with a botnet defeats the IP limit
 *   entirely, and this is the one that stops them.
 *
 * Counters live in PostgreSQL rather than in memory so they survive a restart
 * — otherwise an attacker simply waits for a deploy — and so a second api
 * instance shares them. That is also why `@nestjs/throttler` was not used: its
 * default storage is in-process.
 *
 * Admission and recording are one atomic operation. Checking and then
 * recording as separate steps let a parallel burst through: measured, twenty
 * concurrent attempts were admitted against a cap of five. Stuffing arrives in
 * parallel, so that race removed the protection entirely.
 */
@Injectable()
export class AuthRateLimitService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly attempts: AuthAttemptRepository,
  ) {}

  /**
   * Admits an attempt, or refuses it.
   *
   * Call this **before** verifying the password, so a locked-out attacker
   * cannot make us spend an Argon2 verification per attempt. The attempt is
   * recorded as part of admission; call `succeeded()` afterwards only if it
   * worked.
   */
  async admit(
    ip: string,
    email: string | undefined,
    now: Date = new Date(),
  ): Promise<RateLimitVerdict> {
    const result = await this.attempts.reserve(
      ip,
      email === undefined ? undefined : normalizeEmail(email),
      {
        since: new Date(now.getTime() - this.cfg.AUTH_WINDOW_MS),
        maxPerIp: this.cfg.AUTH_MAX_PER_IP,
        maxFailuresPerEmail: this.cfg.AUTH_MAX_FAILURES_PER_EMAIL,
      },
      now,
    );

    return {
      allowed: result.allowed,
      scope: result.scope,
      retryAfterSeconds: result.allowed ? 0 : Math.ceil(this.cfg.AUTH_WINDOW_MS / 1000),
    };
  }

  /** Records that an admitted attempt succeeded. */
  async succeeded(ip: string, email: string | undefined, now: Date = new Date()): Promise<void> {
    await this.attempts.markSucceeded(
      ip,
      email === undefined ? undefined : normalizeEmail(email),
      now,
    );
  }
}
