import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { DbService } from '../../core/db/db.service.js';
import type { Database } from '../../core/db/types.js';
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

/** An account that signs in through a provider has no password to change. */
export class NoPasswordSetError extends AppError {
  constructor() {
    super('NO_PASSWORD_SET', 'this account has no password', 409);
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
    //
    // And on registration's own per-address budget, not login's: sharing one
    // let a room of registrations behind one NAT lock that address out of
    // login (#72).
    const verdict = await this.limiter.admitRegistration(ip);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

    const hash = await this.passwords.hash(password);
    await this.users.create(email, hash);
  }

  /** Verifies credentials and issues a session, or throws. */
  async login(email: string, password: string, ip: string): Promise<IssuedSession> {
    const verdict = await this.limiter.admit(ip, email);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

    const user = await this.users.findByEmail(email);

    // Three paths, one cost. Unknown address, known address with a password,
    // and known address with none — an account created through a provider —
    // all spend exactly one Argon2 verification.
    //
    // The third is easy to get wrong by returning early, and returning early
    // would make login an oracle for which accounts sign in through a
    // provider: a fast rejection here and a slow one there, which is a list of
    // accounts worth phishing rather than brute-forcing. A-2 does not stop
    // applying because an account happens to have no password.
    const ok =
      user?.password_hash != null
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

    // An account created through a provider has no password to change.
    //
    // This one is safe to answer plainly, unlike the login path above: the
    // caller already holds a session for this account, so it tells them
    // nothing they could not learn from their own settings page. Setting a
    // first password is a different operation, and it needs email
    // verification before it can be offered — otherwise anyone reaching an
    // authenticated session could plant a password and keep access after the
    // provider link is gone.
    if (user.password_hash == null) throw new NoPasswordSetError();

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

  /**
   * Issues a brand-new session for an account, whatever brought the caller
   * here.
   *
   * The one code path every way of authenticating goes through (D10): a
   * provider sign-in reaches this exactly like a password login does, so the
   * session cap and the `__Host-` cookie prefix cannot drift between the two.
   * Exposed deliberately for OAuthService to call -- it was private until the
   * callback needed the same guarantee a password login already had.
   */
  async issue(
    userId: string,
    now: Date = new Date(),
    executor: Kysely<Database> = this.db.kysely,
  ): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + this.cfg.SESSION_TTL_DAYS * 86_400_000);
    await this.sessions.create(userId, hashToken(token), expiresAt, executor);

    // Bound how many sessions one account can hold. Without this each login
    // leaves a row alive for the whole session lifetime, so an account
    // accumulates them for as long as it is used. The session just issued is
    // the newest, so it is never the one revoked.
    await this.sessions.revokeBeyondNewest(userId, this.cfg.MAX_SESSIONS_PER_USER, now, executor);

    return { token, expiresAt };
  }
}
