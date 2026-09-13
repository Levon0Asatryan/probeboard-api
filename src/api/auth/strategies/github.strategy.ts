import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  Configuration,
  type CustomFetch,
  customFetch,
} from 'openid-client';
import type { ProviderAccount } from '../repositories/oauth-identity.repository.js';
import {
  type AuthorizationCallback,
  type AuthorizationRequest,
  OAuthProviderError,
  type OAuthProviderStrategy,
  type StrategyOptions,
} from '../interfaces/oauth-provider.js';
import {
  callbackUrl,
  classifyProviderFailure,
  isInsecureTransportRefusal,
} from '../utils/oauth-callback.js';

export interface GitHubStrategyOptions extends StrategyOptions {
  /** Where authorize and the token endpoint live. Overridable for the test double. */
  webBaseUrl?: string;
  /** Where the REST API lives. Overridable for the test double. */
  apiBaseUrl?: string;
}

/**
 * Sign-in with GitHub, which is a bare OAuth 2.0 server, not OpenID Connect.
 *
 * There is no ID token and no `sub`. The token proves nothing by itself; the
 * identity is whatever `api.github.com` answers when that token is used, over
 * TLS, immediately after we obtained it. So this strategy makes two more calls
 * than Google's, and each is a place it can fail.
 *
 * The account id is GitHub's numeric `id`, never the `login`: a username
 * released by a rename can be claimed by somebody else.
 */
export class GitHubStrategy implements OAuthProviderStrategy {
  readonly provider = 'github' as const;
  readonly usesNonce = false;

  private readonly configuration: Configuration;
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GitHubStrategyOptions) {
    const web = options.webBaseUrl ?? 'https://github.com';
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';

    // No discovery document exists, so the metadata is written out.
    this.configuration = new Configuration(
      {
        issuer: 'https://github.com',
        authorization_endpoint: `${web}/login/oauth/authorize`,
        token_endpoint: `${web}/login/oauth/access_token`,
      },
      options.clientId,
      options.clientSecret,
    );
    this.configuration.timeout = Math.max(1, Math.ceil(options.timeoutMs / 1000));
    if (options.allowInsecureRequests) allowInsecureRequests(this.configuration);

    this.configuration[customFetch] = standardiseTokenErrors(`${web}/login/oauth/access_token`);
  }

  authorizationUrl(request: AuthorizationRequest): Promise<URL> {
    // Throws synchronously for a plain-HTTP endpoint, before any request. Left
    // unwrapped that escapes as a 500 rather than the provider error it is --
    // which is exactly what the first version of this method did.
    try {
      return Promise.resolve(
        buildAuthorizationUrl(this.configuration, {
          redirect_uri: request.redirectUri,
          response_type: 'code',
          // Identity and nothing else: the profile for the id, the address
          // list for a verified address. Not repo, not gist.
          scope: 'read:user user:email',
          state: request.state,
          code_challenge: request.codeChallenge,
          code_challenge_method: 'S256',
          prompt: 'select_account',
        }),
      );
    } catch (err) {
      return Promise.reject(
        new OAuthProviderError(
          isInsecureTransportRefusal(err) ? 'misconfigured' : 'authorization_error',
          'github',
          err,
        ),
      );
    }
  }

  async complete(callback: AuthorizationCallback): Promise<ProviderAccount> {
    let accessToken: string;
    try {
      const tokens = await authorizationCodeGrant(this.configuration, callbackUrl(callback), {
        pkceCodeVerifier: callback.codeVerifier,
        expectedState: callback.expectedState,
      });
      accessToken = tokens.access_token;
    } catch (err) {
      throw new OAuthProviderError(classifyProviderFailure(err), 'github', err);
    }

    // The token is used for these two calls and then dropped. It is never
    // stored and never logged, so there is nothing to leak, rotate or revoke.
    const user = await this.api('/user', accessToken);
    const emails = await this.api('/user/emails?per_page=100', accessToken);

    const id = (user as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new OAuthProviderError('invalid_identity', 'github');
    }

    // Primary *and* verified. /user carries only the public profile address,
    // which is often null and says nothing about verification.
    const primary = Array.isArray(emails)
      ? (emails as unknown[]).find(
          (e): e is { email: string } =>
            typeof e === 'object' &&
            e !== null &&
            (e as { primary?: unknown }).primary === true &&
            (e as { verified?: unknown }).verified === true &&
            typeof (e as { email?: unknown }).email === 'string',
        )
      : undefined;

    return {
      provider: 'github',
      accountId: String(id),
      email: primary?.email ?? null,
      emailVerified: primary !== undefined,
    };
  }

  private async api(path: string, accessToken: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // GitHub rejects API requests without one.
          'user-agent': 'probeboard',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      throw new OAuthProviderError('profile_failed', 'github', err);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new OAuthProviderError(
        'profile_failed',
        'github',
        new Error(`GitHub API ${path} answered ${String(response.status)}`),
      );
    }

    try {
      return await response.json();
    } catch (err) {
      throw new OAuthProviderError('profile_failed', 'github', err);
    }
  }
}

/**
 * Turns GitHub's token-endpoint errors into standard ones.
 *
 * GitHub answers a bad, expired or reused code with HTTP **200** and an
 * `error` member in the body, where RFC 6749 requires a 4xx. The library only
 * inspects the body for an error when the status is not 200, so left alone the
 * response fails later and by accident -- as a missing `access_token` -- and
 * the log says the response was malformed rather than that the code was bad.
 *
 * Rewritten here, at the one place the quirk enters, so everything downstream
 * sees an ordinary OAuth error response.
 */
function standardiseTokenErrors(tokenEndpoint: string): CustomFetch {
  return async (url, options) => {
    const response = await fetch(url, options);
    if (url !== tokenEndpoint || response.status !== 200) return response;

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(text, { status: response.status, headers: response.headers });
    }

    const isError =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'string';

    return new Response(text, {
      status: isError ? 400 : 200,
      headers: response.headers,
    });
  };
}
