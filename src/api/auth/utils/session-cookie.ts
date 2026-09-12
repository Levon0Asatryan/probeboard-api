import type { CookieOptions } from 'express';
import type { AppConfig } from '../../../core/config/schema.js';

export const SESSION_COOKIE = 'pb_session';

/**
 * How the session cookie is set.
 *
 * `httpOnly` because script must never read it: A-3 requires the session to
 * survive a reload, which means persistence, and anything a script can read is
 * readable by any XSS on the page. That is the reason for a cookie rather than
 * a token in `localStorage`.
 *
 * `sameSite: 'lax'` so the cookie is not attached to cross-site POSTs, which
 * is what would make this API CSRF-able. `lax` rather than `strict` so an
 * ordinary link into the dashboard still arrives authenticated.
 *
 * `secure` is configuration only because a Secure cookie is never stored over
 * plain HTTP, so local development could not log in at all.
 */
export function sessionCookieOptions(cfg: AppConfig, expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

/**
 * Clearing must repeat the attributes the cookie was set with. A browser
 * treats a cookie with different flags as a different cookie and leaves the
 * original in place — so logging out would appear to work and not.
 */
export function clearSessionCookieOptions(cfg: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  };
}
