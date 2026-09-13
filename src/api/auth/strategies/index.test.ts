import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { NotFoundError } from '../../../core/errors/app-error.js';
import { GitHubStrategy } from './github.strategy.js';
import { GoogleStrategy } from './google.strategy.js';
import { OAuthStrategyRegistry } from './index.js';

const cfg = (env: Partial<NodeJS.ProcessEnv> = {}) =>
  loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard', ...env });

const enabled = (env: Partial<NodeJS.ProcessEnv> = {}) =>
  cfg({
    OAUTH_ENABLED: 'true',
    OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
    WEB_BASE_URL: 'https://app.example.com',
    ...env,
  });

describe('OAuthStrategyRegistry', () => {
  it('builds no strategy for a provider with no credentials', () => {
    const registry = new OAuthStrategyRegistry(cfg());
    expect(() => registry.get('google')).toThrow(NotFoundError);
    expect(() => registry.get('github')).toThrow(NotFoundError);
  });

  it('builds only the configured provider', () => {
    const registry = new OAuthStrategyRegistry(
      enabled({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }),
    );
    expect(registry.get('google')).toBeInstanceOf(GoogleStrategy);
    expect(() => registry.get('github')).toThrow(NotFoundError);
  });

  it('builds both when both are configured', () => {
    const registry = new OAuthStrategyRegistry(
      enabled({
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
      }),
    );
    expect(registry.get('google')).toBeInstanceOf(GoogleStrategy);
    expect(registry.get('github')).toBeInstanceOf(GitHubStrategy);
  });

  it('refuses an unknown provider name the same way as an unconfigured one', () => {
    const registry = new OAuthStrategyRegistry(cfg());
    expect(() => registry.get('bitbucket')).toThrow(NotFoundError);
  });

  it('builds nothing when OAUTH_ENABLED is off, however the providers are configured', () => {
    // OAUTH_ENABLED is the master switch (social-login-plan.md §6): a
    // deployment may hold credentials in its environment without the surface
    // actually existing.
    const registry = new OAuthStrategyRegistry(
      cfg({
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
      }),
    );
    expect(() => registry.get('google')).toThrow(NotFoundError);
    expect(() => registry.get('github')).toThrow(NotFoundError);
  });
});
