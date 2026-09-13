import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  type Configuration,
  discovery,
  enableNonRepudiationChecks,
} from 'openid-client';
import {
  type AuthorizationCallback,
  type AuthorizationRequest,
  OAuthProviderError,
  type OAuthProviderStrategy,
  type StrategyOptions,
} from '../interfaces/oauth-provider.js';
import type { ProviderAccount } from '../repositories/oauth-identity.repository.js';
import {
  callbackUrl,
  classifyProviderFailure,
  isInsecureTransportRefusal,
} from '../utils/oauth-callback.js';

export interface GoogleStrategyOptions extends StrategyOptions {
  /** Overridable for the test double. Defaults to Google. */
  issuer?: URL;
}

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

/**
 * Sign-in with Google, which is an OpenID Connect provider.
 *
 * The identity is the ID token Google signs, verified here rather than read
 * from the userinfo endpoint: `iss`, `aud`, expiry, a `nonce` that binds the
 * token to this one flow, and the signature against Google's published keys.
 * The nonce is mandatory because passing it is what makes the library require
 * and check an ID token at all.
 *
 * The signature check is an explicit opt-in, and the first version of this
 * file did not have it. OpenID Connect permits a client to skip verifying an ID
 * token's signature when the token came straight from the token endpoint over
 * TLS, and the library follows the spec: without `enableNonRepudiationChecks`
 * it accepted a token signed with a key Google never published. That is sound
 * only as long as TLS to the token endpoint is -- a misconfigured proxy, an
 * intercepting middlebox, or a test that allows plain HTTP all remove it --
 * and it made this comment's promise of signature verification untrue. The
 * cost of checking is one cached JWKS fetch.
 */
export class GoogleStrategy implements OAuthProviderStrategy {
  readonly provider = 'google' as const;
  readonly usesNonce = true;

  /**
   * Discovery, fetched on first use and cached.
   *
   * Not at boot, and never from a readiness check: an outage at Google must
   * not stop probeboard starting or take it out of a load balancer, which for
   * a monitoring product would be a self-inflicted outage. A failed attempt is
   * forgotten so the next sign-in retries rather than failing until restart.
   */
  private configuration?: Promise<Configuration>;

  constructor(private readonly options: GoogleStrategyOptions) {}

  async authorizationUrl(request: AuthorizationRequest): Promise<URL> {
    if (!request.nonce) {
      throw new TypeError('GoogleStrategy requires a nonce; it is what binds the ID token');
    }

    const config = await this.config();

    // Throws synchronously for an unusable endpoint, before any request. Left
    // unwrapped that escapes as a 500 rather than the provider error it is.
    try {
      return buildAuthorizationUrl(config, {
        redirect_uri: request.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
        // Otherwise a browser signed in to one Google account is signed in to
        // probeboard as that account without being asked which.
        prompt: 'select_account',
      });
    } catch (err) {
      throw new OAuthProviderError(
        isInsecureTransportRefusal(err) ? 'misconfigured' : 'authorization_error',
        'google',
        err,
      );
    }
  }

  async complete(callback: AuthorizationCallback): Promise<ProviderAccount> {
    if (!callback.nonce) {
      throw new TypeError('GoogleStrategy requires the nonce the flow was started with');
    }

    const config = await this.config();

    let tokens: Awaited<ReturnType<typeof authorizationCodeGrant>>;
    try {
      tokens = await authorizationCodeGrant(config, callbackUrl(callback), {
        pkceCodeVerifier: callback.codeVerifier,
        expectedState: callback.expectedState,
        expectedNonce: callback.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw new OAuthProviderError(classifyProviderFailure(err), 'google', err);
    }

    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new OAuthProviderError('invalid_identity', 'google');
    }

    return {
      provider: 'google',
      accountId: claims.sub,
      email: typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null,
      // Strictly the boolean. Anything else -- missing, or a string "true" from
      // an older token format -- counts as unverified, so an ambiguous claim
      // fails towards refusing rather than towards trusting.
      emailVerified: claims.email_verified === true,
    };
  }

  private config(): Promise<Configuration> {
    this.configuration ??= discovery(
      this.options.issuer ?? GOOGLE_ISSUER,
      this.options.clientId,
      this.options.clientSecret,
      undefined,
      {
        // The library counts in seconds.
        timeout: Math.max(1, Math.ceil(this.options.timeoutMs / 1000)),
        execute: [
          enableNonRepudiationChecks,
          ...(this.options.allowInsecureRequests ? [allowInsecureRequests] : []),
        ],
      },
    ).catch((err: unknown) => {
      this.configuration = undefined;
      throw new OAuthProviderError(
        isInsecureTransportRefusal(err) ? 'misconfigured' : 'discovery_failed',
        'google',
        err,
      );
    });

    return this.configuration;
  }
}
