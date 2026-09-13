import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { parseByteSize } from '../../../core/config/byte-size.js';
import type { OAuthProvider } from '../../../core/db/types.js';
import { NotFoundError } from '../../../core/errors/app-error.js';
import type { OAuthProviderStrategy } from '../interfaces/oauth-provider.js';
import { GitHubStrategy } from './github.strategy.js';
import { GoogleStrategy } from './google.strategy.js';

/**
 * Name -> strategy, built once from configuration.
 *
 * A provider is usable when its own client id and secret are both set
 * (enforced at boot by the config schema's cross-field rule); there is no
 * separate enable flag per provider. `allowInsecureRequests` is never set
 * here -- it exists only for the local test double, and nothing in this
 * factory is capable of turning it on.
 *
 * Discovery for Google happens lazily inside GoogleStrategy on first use, not
 * here and not at boot: an outage at Google must never take probeboard out of
 * the load balancer.
 */
@Injectable()
export class OAuthStrategyRegistry {
  private readonly strategies = new Map<OAuthProvider, OAuthProviderStrategy>();

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) {
      this.strategies.set(
        'google',
        new GoogleStrategy({
          clientId: cfg.GOOGLE_CLIENT_ID,
          clientSecret: cfg.GOOGLE_CLIENT_SECRET,
          timeoutMs: cfg.OAUTH_HTTP_TIMEOUT_MS,
        }),
      );
    }

    if (cfg.GITHUB_CLIENT_ID && cfg.GITHUB_CLIENT_SECRET) {
      this.strategies.set(
        'github',
        new GitHubStrategy({
          clientId: cfg.GITHUB_CLIENT_ID,
          clientSecret: cfg.GITHUB_CLIENT_SECRET,
          timeoutMs: cfg.OAUTH_HTTP_TIMEOUT_MS,
          maxResponseBytes: parseByteSizeOrThrow(cfg.OAUTH_PROVIDER_MAX_RESPONSE_BYTES),
        }),
      );
    }
  }

  /**
   * The strategy for a provider name, or refuses.
   *
   * `NotFoundError` rather than a dedicated "provider disabled" error: an
   * unconfigured provider and an unknown one look identical to a caller, and
   * should -- a half-configured provider must not appear to exist any more
   * than a made-up one does.
   */
  get(provider: string): OAuthProviderStrategy {
    const strategy = this.strategies.get(provider as OAuthProvider);
    if (!strategy) throw new NotFoundError('provider');
    return strategy;
  }
}

/**
 * The schema already validated this string at boot, so a failure here would
 * mean the schema and this parser disagree -- a defect worth crashing loudly
 * for, not a runtime condition to handle gracefully a second time.
 */
function parseByteSizeOrThrow(value: string): number {
  const bytes = parseByteSize(value);
  if (bytes === undefined) {
    throw new Error(
      `OAUTH_PROVIDER_MAX_RESPONSE_BYTES passed config validation but did not parse: ${value}`,
    );
  }
  return bytes;
}
