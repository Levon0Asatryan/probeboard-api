import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../../core/errors/app-error.js';
import { OAuthProviderParamPipe } from './oauth-params.dto.js';

describe('OAuthProviderParamPipe', () => {
  const pipe = new OAuthProviderParamPipe();

  it('accepts a known provider', () => {
    expect(pipe.transform('google')).toBe('google');
    expect(pipe.transform('github')).toBe('github');
  });

  it('refuses an unknown provider as a 404, not a validation error', () => {
    // An unknown provider is an unknown route, not a request that almost
    // worked -- and answers the same way as a real provider with no
    // configured credentials (OAuthStrategyRegistry.get), so a caller cannot
    // tell "made up" from "not configured".
    expect(() => pipe.transform('bitbucket')).toThrow(NotFoundError);
  });
});
