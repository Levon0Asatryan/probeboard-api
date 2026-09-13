import type { CookieOptions } from 'express';
import type { AppConfig } from '../../../core/config/schema.js';

const BASE_NAME = 'pb_oauth';

/**
 * The pending-authorization cookie's name, following the same rule as the
 * session cookie (D7): `__Host-` only when it can actually carry the prefix.
 *
 * Reusing `sessionCookieName`'s contract rather than restating it, because a
 * `__Host-` name without `Secure` is not a weaker cookie, it is no cookie at
 * all -- the browser refuses to store it, and every callback then fails at
 * the state check with a cause that reads like a broken comparison rather
 * than a cookie that was never set.
 */
export function oauthCookieName(cfg: Pick<AppConfig, 'COOKIE_SECURE'>): string {
  return cfg.COOKIE_SECURE ? `__Host-${BASE_NAME}` : BASE_NAME;
}

/**
 * How the pending-authorization cookie is set.
 *
 * `sameSite: 'lax'` is not the usual CSRF-hardening default here, it is a
 * requirement: the callback is a top-level cross-site GET navigation (the
 * provider redirects the browser back to us), which `Lax` permits and
 * `Strict` does not. A provider added later that uses `response_mode=form_post`
 * would turn that into a cross-site POST, which `Lax` does not send the
 * cookie on either -- noted here because that failure looks exactly like a
 * broken state check.
 *
 * `maxAge` rather than `expires`, keyed to `OAUTH_STATE_TTL_MS`: the cookie
 * and the pending row it points at should expire together.
 */
export function oauthCookieOptions(
  cfg: Pick<AppConfig, 'COOKIE_SECURE' | 'OAUTH_STATE_TTL_MS'>,
): CookieOptions {
  return {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: cfg.OAUTH_STATE_TTL_MS,
  };
}

/** Clearing must repeat the attributes the cookie was set with (see session-cookie.ts). */
export function clearOauthCookieOptions(cfg: Pick<AppConfig, 'COOKIE_SECURE'>): CookieOptions {
  return {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  };
}
