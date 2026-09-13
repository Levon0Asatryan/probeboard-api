import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { clearOauthCookieOptions, oauthCookieName, oauthCookieOptions } from './oauth-cookie.js';

const cfg = (env: Partial<NodeJS.ProcessEnv> = {}) =>
  loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard', ...env });

describe('oauthCookieOptions', () => {
  it('is httpOnly', () => {
    expect(oauthCookieOptions(cfg()).httpOnly).toBe(true);
  });

  it('is SameSite=Lax, which the callback -- a top-level cross-site GET -- requires', () => {
    expect(oauthCookieOptions(cfg()).sameSite).toBe('lax');
  });

  it('is Secure by default', () => {
    expect(oauthCookieOptions(cfg()).secure).toBe(true);
  });

  it('can drop Secure for plain-HTTP local development', () => {
    expect(oauthCookieOptions(cfg({ COOKIE_SECURE: 'false' })).secure).toBe(false);
  });

  it('expires with the configured state ttl', () => {
    expect(oauthCookieOptions(cfg({ OAUTH_STATE_TTL_MS: '120000' })).maxAge).toBe(120_000);
  });

  it('is scoped to the whole site, with no Domain', () => {
    const opts = oauthCookieOptions(cfg());
    expect(opts.path).toBe('/');
    expect(opts).not.toHaveProperty('domain');
  });
});

describe('clearOauthCookieOptions', () => {
  it('repeats every attribute the cookie was set with', () => {
    const set = oauthCookieOptions(cfg());
    const clear = clearOauthCookieOptions(cfg());

    expect(clear.httpOnly).toBe(set.httpOnly);
    expect(clear.secure).toBe(set.secure);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.path).toBe(set.path);
  });
});

describe('oauthCookieName', () => {
  it('carries the __Host- prefix when the cookie is Secure', () => {
    expect(oauthCookieName(cfg())).toBe('__Host-pb_oauth');
  });

  it('drops the prefix when Secure is off, since the browser would refuse it', () => {
    expect(oauthCookieName(cfg({ COOKIE_SECURE: 'false' }))).toBe('pb_oauth');
  });

  it('matches the attributes __Host- requires', () => {
    const opts = oauthCookieOptions(cfg());
    expect(opts.secure).toBe(true);
    expect(opts.path).toBe('/');
    expect(opts).not.toHaveProperty('domain');
  });
});
