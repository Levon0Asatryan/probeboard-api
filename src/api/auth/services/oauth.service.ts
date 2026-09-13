import { Inject, Injectable } from '@nestjs/common';
import {
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import type { OAuthProvider } from '../../../core/db/types.js';
import { describeError } from '../../../core/errors/describe.js';
import { RateLimitedError, type AuthService, type IssuedSession } from '../auth.service.js';
import { OAuthProviderError } from '../interfaces/oauth-provider.js';
import { OAuthAuthorizationRepository } from '../repositories/oauth-authorization.repository.js';
import { OAuthStrategyRegistry } from '../strategies/index.js';
import { AuthRateLimitService } from './rate-limit.service.js';
import { OAuthIdentityService, type SignInOutcome } from './oauth-identity.service.js';
import { validateReturnTo } from '../utils/return-to.js';

/** The fixed enumeration the callback redirects with on failure (plan §5). */
export type OAuthErrorCode =
  | 'OAUTH_STATE_INVALID'
  | 'OAUTH_ACCOUNT_EXISTS'
  | 'OAUTH_NO_VERIFIED_EMAIL'
  | 'OAUTH_PROVIDER_ERROR'
  | 'OAUTH_IDENTITY_TAKEN';

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
    private readonly strategies: OAuthStrategyRegistry,
    private readonly authorizations: OAuthAuthorizationRepository,
    private readonly identities: OAuthIdentityService,
    private readonly authService: AuthService,
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
    opts: { ip: string; cookieValue: string | undefined; query: URLSearchParams },
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

    const state = opts.query.get('state') ?? '';
    const pending = await this.authorizations.consume(opts.cookieValue, state, now);
    if (!pending) {
      this.logger.warn({ provider }, 'oauth callback: no matching pending authorization');
      return { kind: 'error', code: 'OAUTH_STATE_INVALID' };
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

      let outcome: SignInOutcome;
      if (pending.mode === 'link') {
        // Enforced by a CHECK constraint (mode = 'link') = (user_id IS NOT
        // NULL): this is a DB invariant violation, not a request to handle.
        if (!pending.user_id) throw new Error('link authorization with no user_id');
        outcome = await this.identities.link(pending.user_id, account);
      } else {
        outcome = await this.identities.signIn(account, now);
      }

      return await this.toResult(outcome, pending.return_to);
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

  private async toResult(outcome: SignInOutcome, returnTo: string): Promise<CallbackResult> {
    switch (outcome.kind) {
      case 'signed_in':
      case 'created':
      case 'linked': {
        const session = await this.authService.issue(outcome.userId);
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
