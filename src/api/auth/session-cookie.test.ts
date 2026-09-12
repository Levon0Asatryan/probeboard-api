import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../core/config/index.js';
import {
  clearSessionCookieOptions,
  SESSION_COOKIE,
  sessionCookieOptions,
} from './session-cookie.js';

const cfg = (env: Partial<NodeJS.ProcessEnv> = {}) =>
  loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard', ...env });

const expires = new Date('2026-12-01T00:00:00Z');

describe('sessionCookieOptions', () => {
  it('is httpOnly, so no script can read the session', () => {
    // The whole reason for a cookie rather than localStorage.
    expect(sessionCookieOptions(cfg(), expires).httpOnly).toBe(true);
  });

  it('is SameSite=Lax, so it is not attached to cross-site posts', () => {
    expect(sessionCookieOptions(cfg(), expires).sameSite).toBe('lax');
  });

  it('is Secure by default', () => {
    expect(sessionCookieOptions(cfg(), expires).secure).toBe(true);
  });

  it('can drop Secure for plain-HTTP local development', () => {
    // A Secure cookie is never stored over http, so local login would fail.
    expect(sessionCookieOptions(cfg({ COOKIE_SECURE: 'false' }), expires).secure).toBe(false);
  });

  it('expires with the session rather than the browser tab', () => {
    expect(sessionCookieOptions(cfg(), expires).expires).toBe(expires);
  });

  it('is scoped to the whole site', () => {
    expect(sessionCookieOptions(cfg(), expires).path).toBe('/');
  });
});

describe('clearSessionCookieOptions', () => {
  it('repeats every attribute except the expiry', () => {
    // A browser treats a cookie with different flags as a different cookie and
    // leaves the original in place, so logging out would appear to work and
    // not actually clear anything.
    const set = sessionCookieOptions(cfg(), expires);
    const clear = clearSessionCookieOptions(cfg());

    expect(clear.httpOnly).toBe(set.httpOnly);
    expect(clear.secure).toBe(set.secure);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.path).toBe(set.path);
    expect(clear.expires).toBeUndefined();
  });

  it('follows the Secure setting too', () => {
    expect(clearSessionCookieOptions(cfg({ COOKIE_SECURE: 'false' })).secure).toBe(false);
  });
});

describe('SESSION_COOKIE', () => {
  it('has a stable name a client can rely on', () => {
    expect(SESSION_COOKIE).toBe('pb_session');
  });
});
