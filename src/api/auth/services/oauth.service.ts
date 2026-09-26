import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { DbService } from '../../../core/db/db.service.js';
import type { Database, OAuthProvider } from '../../../core/db/types.js';
import { describeError } from '../../../core/errors/describe.js';
import { UserRepository } from '../../../core/users/repositories/user.repository.js';
import { RateLimitedError } from '../../../core/errors/app-error.js';
import { AuthService, type IssuedSession } from '../auth.service.js';
import { OAuthProviderError } from '../interfaces/oauth-provider.js';
import type { ProviderAccount } from '../repositories/oauth-identity.repository.js';
import { OAuthAuthorizationRepository } from '../repositories/oauth-authorization.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { OAuthStrategyRegistry } from '../strategies/strategy-registry.service.js';
import { looksLikeState } from '../utils/oauth-callback.js';
import { looksLikeOauthCookie } from '../utils/oauth-cookie.js';
import { hashToken, looksLikeToken } from '../utils/session-token.js';
import { AuthRateLimitService } from './rate-limit.service.js';
import { OAuthIdentityService, type SignInOutcome } from './oauth-identity.service.js';
import { validateReturnTo } from '../utils/return-to.js';

/** The fixed enumeration the callback redirects with on failure (plan §5). */
export type OAuthErrorCode =
  | 'OAUTH_STATE_INVALID'
  | 'OAUTH_ACCOUNT_EXISTS'
  | 'OAUTH_NO_VERIFIED_EMAIL'
  | 'OAUTH_PROVIDER_ERROR'
  | 'OAUTH_IDENTITY_TAKEN'
  | 'OAUTH_SESSION_REVOKED';

export interface StartResult {
  /** Opaque id stored in the state cookie. */
  cookieValue: string;
  redirectUrl: URL;
}

export type CallbackResult =
  ({ kind: 'success'; returnTo: string } & IssuedSession) | { kind: 'error'; code: OAuthErrorCode };

/**
 * The OAuth flow: start, complete, link. Cookies, sessions and HTTP belong to
 * the controller; this is the part that talks to the provider and to
 * OAuthIdentityService.
 */
@Injectable()
export class OAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly users: UserRepository,
    private readonly strategies: OAuthStrategyRegistry,
    private readonly authorizations: OAuthAuthorizationRepository,
    private readonly identities: OAuthIdentityService,
    private readonly authService: AuthService,
    private readonly sessions: SessionRepository,
    private readonly limiter: AuthRateLimitService,
    @InjectPinoLogger(OAuthService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Begins a flow: sign-in when `userId` is absent, linking when present
   * (D13).
   */
  async start(
    provider: OAuthProvider,
    opts: { ip: string; returnTo?: unknown; userId?: string },
    now: Date = new Date(),
  ): Promise<StartResult> {
    await this.admit(opts.ip);

    const strategy = this.strategies.get(provider);

    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const nonce = strategy.usesNonce ? randomNonce() : undefined;

    const pending = await this.authorizations.create({
      provider,
      mode: opts.userId ? 'link' : 'signin',
      userId: opts.userId,
      state,
      codeVerifier,
      nonce,
      returnTo: validateReturnTo(opts.returnTo),
      expiresAt: new Date(now.getTime() + this.cfg.OAUTH_STATE_TTL_MS),
    });

    const redirectUrl = await strategy.authorizationUrl({
      redirectUri: this.redirectUri(provider),
      state,
      codeChallenge,
      nonce,
    });

    return { cookieValue: pending.id, redirectUrl };
  }

  /**
   * Completes a flow. Never throws for an ordinary failure -- every rejected
   * path is a `CallbackResult`, because the caller always redirects, never
   * renders an error page. Only a rate limit refusal throws, since that
   * happens before there is anything to redirect about.
   */
  async complete(
    provider: OAuthProvider,
    opts: {
      ip: string;
      cookieValue: string | undefined;
      query: URLSearchParams;
      /** The session cookie presented alongside the callback, if any. */
      sessionToken: string | undefined;
    },
    now: Date = new Date(),
  ): Promise<CallbackResult> {
    await this.admit(opts.ip);

    // Missing cookie and a state the row does not recognise are two different
    // rejections that produce one error code, deliberately: which of them
    // fired is a fact about our internals, and belongs in the log, not the
    // redirect (plan §7 step 8-9).
    if (!opts.cookieValue) {
      this.logger.warn({ provider }, 'oauth callback: no state cookie');
      return { kind: 'error', code: 'OAUTH_STATE_INVALID' };
    }

    // Both are attacker-controlled and both reach a typed column, so a
    // malformed one is refused here rather than handed to PostgreSQL to fail
    // as a 500 (rule #8). Neither value is logged: it is whatever the caller
    // chose to send.
    if (!looksLikeOauthCookie(opts.cookieValue)) {
      this.logger.warn({ provider }, 'oauth callback: malformed state cookie');
      return { kind: 'error', code: 'OAUTH_STATE_INVALID' };
    }

    const state = opts.query.get('state') ?? '';
    if (!looksLikeState(state)) {
      this.logger.warn({ provider }, 'oauth callback: malformed state');
      return { kind: 'error', code: 'OAUTH_STATE_INVALID' };
    }
    // Bound to the provider the callback actually arrived on (RFC 9700's
    // mix-up), not only the id and state: see consume()'s own comment.
    const pending = await this.authorizations.consume(opts.cookieValue, state, provider, now);
    if (!pending) {
      this.logger.warn({ provider }, 'oauth callback: no matching pending authorization');
      return { kind: 'error', code: 'OAUTH_STATE_INVALID' };
    }

    let linkUserId: string | undefined;
    if (pending.mode === 'link') {
      // Enforced by a CHECK constraint (mode = 'link') = (user_id IS NOT
      // NULL): this is a DB invariant violation, not a request to handle.
      if (!pending.user_id) throw new Error('link authorization with no user_id');
      linkUserId = pending.user_id;
    }

    const strategy = this.strategies.get(provider);

    try {
      const account = await strategy.complete({
        redirectUri: this.redirectUri(provider),
        query: opts.query,
        expectedState: pending.state,
        codeVerifier: pending.code_verifier,
        nonce: pending.nonce ?? undefined,
      });

      if (linkUserId) {
        return await this.completeLink(
          linkUserId,
          opts.sessionToken,
          account,
          pending.return_to,
          now,
        );
      }

      const outcome = await this.identities.signIn(account, now);
      return await this.toResult(outcome, pending.return_to, now);
    } catch (err) {
      if (err instanceof OAuthProviderError) {
        // The provider's own error text is attacker-influenceable and never
        // rendered; the reason and cause are for the log alone.
        this.logger.warn(
          { provider, reason: err.reason, cause: describeError(err.cause) },
          'oauth provider error',
        );
        return { kind: 'error', code: 'OAUTH_PROVIDER_ERROR' };
      }
      throw err;
    }
  }

  /**
   * Links a provider account, re-checking the originating session and
   * issuing the resulting session in the same transaction.
   *
   * A check-then-write with no lock leaves a window: `logout-all` commits
   * between the check and the write, and the write -- which the slow
   * provider round trip has already delayed by however long that took --
   * proceeds anyway. Locking the session row (`FOR UPDATE`) closes the
   * window for the *check*, but not by itself for the *write*: this
   * transaction's own `sessions.create` (inside `authService.issue`, via
   * `toResult`) inserts a session that did not exist when `revokeAllForUser`
   * took its row-level lock, so under READ COMMITTED that UPDATE's row set
   * never includes it, however the two transactions interleave or block on
   * each other. A revoke-all that should have caught this exact link's
   * result would not.
   *
   * The fix is the same lock, on the row every credential of the account
   * shares: the user row itself, taken first (before the session lock),
   * matching the order `SessionRepository.revokeAllForUser` and
   * `OAuthIdentityRepository.unlink` also use. With both sides locking users
   * before sessions, one call fully commits before the other's lock
   * acquisition unblocks -- so whichever runs second sees everything the
   * first one did, including a session inserted after the first one's own
   * scan would otherwise have missed it.
   */
  private async completeLink(
    linkUserId: string,
    sessionToken: string | undefined,
    account: ProviderAccount,
    returnTo: string,
    now: Date,
  ): Promise<CallbackResult> {
    return this.db.kysely.transaction().execute(async (trx) => {
      await this.users.lockForUpdate(linkUserId, trx);

      const currentUserId = await this.currentSessionUserId(sessionToken, now, trx);
      if (currentUserId !== linkUserId) {
        this.logger.warn(
          { userId: linkUserId },
          'oauth link: originating session is no longer active',
        );
        return { kind: 'error', code: 'OAUTH_SESSION_REVOKED' };
      }

      const outcome = await this.identities.link(linkUserId, account, now, trx);
      return await this.toResult(outcome, returnTo, now, trx);
    });
  }

  private async toResult(
    outcome: SignInOutcome,
    returnTo: string,
    now: Date,
    executor?: Kysely<Database>,
  ): Promise<CallbackResult> {
    switch (outcome.kind) {
      case 'signed_in':
      case 'created':
      case 'linked': {
        const session = await this.authService.issue(outcome.userId, now, executor);
        return { kind: 'success', returnTo, ...session };
      }
      case 'account_exists':
      case 'already_linked':
        return { kind: 'error', code: 'OAUTH_ACCOUNT_EXISTS' };
      case 'no_email':
        return { kind: 'error', code: 'OAUTH_NO_VERIFIED_EMAIL' };
      case 'identity_taken':
        return { kind: 'error', code: 'OAUTH_IDENTITY_TAKEN' };
    }
  }

  /**
   * The session cookie's owner, or undefined for anything that is not a
   * live, active session -- missing, malformed, expired or revoked. Soft by
   * design: an absent or dead session here is a fact for the caller to act
   * on, not a reason to throw, since sign-in mode never has one at all.
   *
   * Locks the row (`FOR UPDATE`) when called with a transaction executor, so
   * a caller writing inside that same transaction can rely on the answer
   * still being true when the write commits -- see `completeLink`.
   */
  private async currentSessionUserId(
    token: string | undefined,
    now: Date,
    executor?: Kysely<Database>,
  ): Promise<string | undefined> {
    if (!token || !looksLikeToken(token)) return undefined;
    const session = executor
      ? await this.sessions.findActiveForUpdate(hashToken(token), now, executor)
      : await this.sessions.findActive(hashToken(token), now);
    return session?.userId;
  }

  private redirectUri(provider: OAuthProvider): string {
    // A distinct URI per provider, registered as an exact string with the
    // provider (D8) -- RFC 9700's mix-up countermeasure, and free. Never
    // derived from the request's Host header, which is attacker-controlled.
    return new URL(
      `/v1/auth/oauth/${provider}/callback`,
      this.cfg.OAUTH_REDIRECT_BASE_URL,
    ).toString();
  }

  private async admit(ip: string): Promise<void> {
    // ip scope only, never email (D11): the address here is asserted by the
    // provider, not guessed, so counting failures against it would let anyone
    // lock out an account by mashing a broken OAuth flow.
    const verdict = await this.limiter.admit(ip, undefined);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);
  }
}
