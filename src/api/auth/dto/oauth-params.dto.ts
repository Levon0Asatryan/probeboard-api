import { Injectable, type PipeTransform } from '@nestjs/common';
import { OAUTH_PROVIDERS, type OAuthProvider } from '../../../core/db/types.js';
import { NotFoundError } from '../../../core/errors/app-error.js';

/**
 * Validates the `:provider` path segment.
 *
 * A `NotFoundError`, not a `ValidationError`: an unknown provider name is an
 * unknown route, not a request that almost worked. The registry (a
 * provider name with no configured credentials) answers the same way, so a
 * caller cannot tell "made up" from "not configured" -- see
 * `OAuthStrategyRegistry.get`.
 */
@Injectable()
export class OAuthProviderParamPipe implements PipeTransform<string, OAuthProvider> {
  transform(value: string): OAuthProvider {
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(value)) {
      throw new NotFoundError('route');
    }
    return value as OAuthProvider;
  }
}
