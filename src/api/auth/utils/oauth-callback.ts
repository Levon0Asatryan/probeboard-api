import type { AuthorizationCallback, ProviderFailure } from '../interfaces/oauth-provider.js';

/**
 * The registered callback URL with the provider's query appended.
 *
 * Built from the registered URL rather than the URL the request arrived on,
 * so the redirect_uri presented to the token endpoint cannot come from an
 * attacker-controlled Host header.
 */
export function callbackUrl(callback: AuthorizationCallback): URL {
  const url = new URL(callback.redirectUri);
  for (const [key, value] of callback.query) url.searchParams.append(key, value);
  return url;
}

/**
 * The code the library attaches when it refuses a plain-HTTP endpoint.
 *
 * Matched by code rather than by message, which is prose and can change in any
 * release.
 */
const HTTP_REQUEST_FORBIDDEN = 'OAUTH_HTTP_REQUEST_FORBIDDEN';

/** Whether the library refused to talk to a provider over plain HTTP. */
export function isInsecureTransportRefusal(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === HTTP_REQUEST_FORBIDDEN
  );
}

/**
 * Where a flow failed, from what the library threw.
 *
 * The provider's own error text is not copied out: it stays on `cause`, which
 * is logged and never rendered.
 */
export function classifyProviderFailure(
  err: unknown,
): Extract<ProviderFailure, 'misconfigured' | 'authorization_error' | 'exchange_failed'> {
  // Our deployment, not their outage.
  if (isInsecureTransportRefusal(err)) return 'misconfigured';

  // An error the provider put in the redirect itself -- the user declined, or
  // the request was malformed -- arrives before any token request is made.
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'AuthorizationResponseError'
  ) {
    return 'authorization_error';
  }
  return 'exchange_failed';
}
