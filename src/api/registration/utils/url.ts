import { effectiveUrl } from '../../../core/registration/url.js';
import { ValidationError } from '../../../core/errors/app-error.js';

export { effectiveUrl };

/** Origin only -- scheme + host [+ port], never a path (docs/m2-plan.md §3). */
export function toOrigin(rawUrl: string): string {
  return new URL(rawUrl).origin;
}

/**
 * The canonical form of `path`, derived from the same parse `effectiveUrl`
 * validates -- `orders`, `/orders`, and `/a/../orders` all resolve to the
 * same target, but the unique index on `(service_id, method, path)`
 * compares the raw stored string, so storing `path` verbatim would let
 * these variants each register their own duplicate, independently
 * scheduled endpoint for the one HTTP resource. Storing the canonical form
 * instead makes the constraint mean what it says.
 */
export function canonicalPath(baseUrl: string, path: string): string {
  const url = new URL(effectiveUrl(baseUrl, path));
  return url.pathname + url.search;
}

/**
 * `MAX_ENDPOINT_PATH_BYTES` is a save-time-only bound (no worker reader
 * needs it), so this stays in `api` -- unlike `effectiveUrl`, checked
 * identically by every path a stored path can be set through: an
 * endpoint's own create/update, and B-3's implicit service+endpoint
 * creation.
 */
export function assertPathBytes(path: string, maxBytes: number): void {
  if (Buffer.byteLength(path, 'utf8') > maxBytes) {
    throw new ValidationError([
      { path: 'path', message: `must be at most ${String(maxBytes)} bytes` },
    ]);
  }
}
