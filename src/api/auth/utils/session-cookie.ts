import type { CookieOptions } from 'express';
import type { AppConfig } from '../../../core/config/schema.js';

const BASE_NAME = 'pb_session';

/**
 * The cookie's name, which depends on whether it can carry the `__Host-`
 * prefix.
 *
 * `__Host-` is enforced by the browser rather than by us: it refuses the cookie
 * unless it is Secure, scoped to `Path=/`, and carries no `Domain`. That
 * removes a class of attack a same-site subdomain otherwise has — setting a
 * cookie of the same name that ours cannot be distinguished from, which is
 * session fixation by another route.
 *
 * The prefix requires Secure, so it cannot be used over plain HTTP. Local
 * development falls back to the bare name rather than setting a cookie every
 * browser will silently drop.
 */
export function sessionCookieName(cfg: AppConfig): string {
  return cfg.COOKIE_SECURE ? `__Host-${BASE_NAME}` : BASE_NAME;
}

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
    // Path '/' and no Domain: required by the __Host- prefix, and correct
    // without it.
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
