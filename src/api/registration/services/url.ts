import { ValidationError } from '../../../core/errors/app-error.js';

/** Origin only -- scheme + host [+ port], never a path (docs/m2-plan.md §3). */
export function toOrigin(rawUrl: string): string {
  return new URL(rawUrl).origin;
}

/**
 * Joins an endpoint's `path` onto its service's `baseUrl` for SSRF
 * re-validation (D10). `new URL(path, base)` ignores `base` entirely when
 * `path` itself parses as an absolute URL (e.g. `http://169.254.169.254/`),
 * which the SSRF guard would still catch on the resulting host -- but
 * silently probing a different origin than the one the endpoint is
 * organized under is a product-correctness bug even when the host is
 * public, so it is rejected outright rather than allowed through.
 */
export function effectiveUrl(baseUrl: string, path: string): string {
  const joined = new URL(path, baseUrl);
  if (joined.origin !== baseUrl) {
    throw new ValidationError([
      {
        path: 'path',
        message: "must be relative to the endpoint's service, not a different origin",
      },
    ]);
  }
  return joined.toString();
}
