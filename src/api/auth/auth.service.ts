import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { DbService } from '../../core/db/db.service.js';
import { AppError, ValidationError } from '../../core/errors/app-error.js';
import { UserRepository } from '../../core/users/repositories/user.repository.js';
import { PasswordService } from './services/password.service.js';
import { AuthRateLimitService } from './services/rate-limit.service.js';
import { SessionRepository } from './repositories/session.repository.js';
import { generateToken, hashToken } from './utils/session-token.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
}

/** Thrown for every rejected credential, whatever was actually wrong (A-2). */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS', 'email or password is incorrect', 401);
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 'too many attempts, try again later', 429);
  }
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly users: UserRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionRepository,
    private readonly limiter: AuthRateLimitService,
  ) {}

  /**
   * Creates an account.
   *
   * Returns nothing either way, and deliberately does **not** issue a session.
   *
   * A-1 requires a taken address to be indistinguishable from a fresh one. With
   * auto-login that is impossible: a duplicate cannot receive a session without
   * logging in whoever already owns the address, and withholding one is an
   * observable difference. Registering without a session makes both outcomes
   * identical, at the cost of one extra login.
   */
  async register(email: string, password: string, ip: string): Promise<void> {
    this.requirePasswordPolicy(password, 'password');

    // Limited by address only, never by account.
    //
    // Counting registrations against the credential-failure counter would let
    // an unauthenticated attacker lock anyone out: submit a handful of
    // duplicate registrations for a victim's address, exhaust the limit, and
    // the victim's correct password is refused for the whole window. It would
    // also make repeated registration behave differently for an address that
    // exists, which is the distinction A-1 exists to remove.
    const verdict = await this.limiter.admit(ip, undefined);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

    const hash = await this.passwords.hash(password);
    await this.users.create(email, hash);
  }

  /** Verifies credentials and issues a session, or throws. */
  async login(email: string, password: string, ip: string): Promise<IssuedSession> {
    const verdict = await this.limiter.admit(ip, email);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

    const user = await this.users.findByEmail(email);

    // Both paths spend one Argon2 verification, or the time difference reveals
    // which addresses are registered (A-2).
    const ok = user
      ? await this.passwords.verify(user.password_hash, password)
      : await this.passwords.verifyDummy(password);

    if (!ok || !user) throw new InvalidCredentialsError();

    await this.limiter.succeeded(ip, email);
    return this.issue(user.id);
  }

  /**
   * Changes a password and revokes every other session (A-5).
   *
   * The current session is spared, so changing a password does not log out the
   * person doing it.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
    ip: string,
  ): Promise<void> {
    // Limited before the verification, and by address only.
    //
    // Without a limit here, anyone holding a session -- including a stolen one
    // -- can brute-force the current password and spend one Argon2
    // verification of our CPU per guess, never meeting the limiter that guards
    // login. By address rather than by account for the same reason as
    // registration: keying on the owner's address would let a stolen session
    // lock them out of the login they need to recover.
    const verdict = await this.limiter.admit(ip, undefined);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

    const user = await this.users.findById(userId);
    if (!user) throw new InvalidCredentialsError();

    if (!(await this.passwords.verify(user.password_hash, currentPassword))) {
      throw new InvalidCredentialsError();
    }

    this.requirePasswordPolicy(newPassword, 'newPassword');

    const hash = await this.passwords.hash(newPassword);

    // One transaction, because the two writes are one decision. If the
    // password changed and the revocation failed, the caller would get a 500
    // while every session they were trying to invalidate stayed live — and
    // changing a password is precisely what someone does when they believe a
    // session is compromised.
    await this.db.kysely.transaction().execute(async (trx) => {
      await this.users.updatePasswordHash(userId, hash, trx);
      await this.sessions.revokeAllForUser(userId, currentSessionId, new Date(), trx);
    });
  }

  /**
   * The configured minimum length.
   *
   * Enforced here rather than in the request schema because a parameter
   * decorator cannot read injected configuration, and building the schema from
   * a module-level config would reintroduce the singleton removed in M0. The
   * error shape matches the validation pipe's, so a client sees one format.
   */
  private requirePasswordPolicy(password: string, field: string): void {
    const min = this.cfg.PASSWORD_MIN_LENGTH;
    if (password.length < min) {
      throw new ValidationError([
        { path: field, message: `must be at least ${String(min)} characters` },
      ]);
    }
  }

  private async issue(userId: string): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.cfg.SESSION_TTL_DAYS * 86_400_000);
    await this.sessions.create(userId, hashToken(token), expiresAt);
    return { token, expiresAt };
  }
}
