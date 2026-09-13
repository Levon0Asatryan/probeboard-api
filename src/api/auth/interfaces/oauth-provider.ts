import type { OAuthProvider } from '../../../core/db/types.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ProviderAccount } from '../repositories/oauth-identity.repository.js';

/** What a strategy needs to start a flow. The caller generates every secret. */
export interface AuthorizationRequest {
  /** Exact registered callback URL. Never derived from a request's Host header. */
  redirectUri: string;
  state: string;
  /** S256 of the verifier the caller keeps. */
  codeChallenge: string;
  /** Required by OIDC providers, ignored by the others. */
  nonce?: string;
}

/** What a strategy needs to finish a flow. */
export interface AuthorizationCallback {
  /**
   * The registered callback URL, not the URL the request arrived on.
   *
   * The strategy rebuilds the callback from this plus `query` rather than
   * accepting a full URL, so a controller cannot pass through something built
   * from an attacker-controlled Host header: the redirect_uri sent to the token
   * endpoint is always the one registered with the provider.
   */
  redirectUri: string;
  /** The query string the provider redirected back with. */
  query: URLSearchParams;
  expectedState: string;
  codeVerifier: string;
  nonce?: string;
}

/**
 * One identity provider.
 *
 * Deliberately narrow: build the URL to send the browser to, and turn the
 * callback into a provider account. Everything about *which probeboard
 * account* that is belongs to OAuthIdentityService, and nothing about sessions
 * or cookies belongs here at all.
 */
export interface OAuthProviderStrategy {
  readonly provider: OAuthProvider;
  /** Whether the flow must carry a nonce. True for OIDC, false for bare OAuth 2.0. */
  readonly usesNonce: boolean;
  authorizationUrl(request: AuthorizationRequest): Promise<URL>;
  complete(callback: AuthorizationCallback): Promise<ProviderAccount>;
}

/** Credentials and limits every strategy takes. */
export interface StrategyOptions {
  clientId: string;
  clientSecret: string;
  /** Bounds every outbound call to the provider. */
  timeoutMs: number;
  /**
   * Permits plain-HTTP provider endpoints.
   *
   * Exists for the local test double and nothing else. In production an
   * http:// endpoint means the authorization code, the client secret and the
   * identity assertion all cross the network in the clear, so the library
   * refuses them unless this is set, and nothing in configuration sets it.
   */
  allowInsecureRequests?: boolean;
}

/**
 * Why a sign-in failed at the provider, for the log.
 *
 * Coarse on purpose: these name where it failed, not what the provider said.
 * A provider's own error description is attacker-influenceable text and never
 * reaches a response.
 */
export type ProviderFailure =
  /**
   * The strategy cannot be used as configured -- in practice, a provider
   * endpoint that is not HTTPS. A deployment mistake, not a provider outage,
   * and named separately so the log does not send anyone to check Google's
   * status page.
   */
  | 'misconfigured'
  | 'discovery_failed'
  | 'authorization_error'
  | 'exchange_failed'
  | 'invalid_identity'
  | 'profile_failed';

/**
 * Every provider-side failure, as one error.
 *
 * 502 because the fault is upstream of us. The client sees a fixed message and
 * code; `reason` and `cause` are for the log.
 */
export class OAuthProviderError extends AppError {
  constructor(
    readonly reason: ProviderFailure,
    readonly provider: OAuthProvider,
    cause?: unknown,
  ) {
    super('OAUTH_PROVIDER_ERROR', 'sign-in with the provider failed', 502);
    this.name = 'OAuthProviderError';
    if (cause !== undefined) this.cause = cause;
  }
}
