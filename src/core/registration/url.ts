import { ValidationError } from '../errors/app-error.js';

/**
 * Joins an endpoint's `path` onto its service's `baseUrl` to get the actual
 * probed target -- the same construction rule both M2's save-time SSRF
 * re-validation (D10) and M3's probe executor need, so it lives in `core`
 * rather than `api/registration` (`api`/`worker` never depend on each
 * other, AGENTS.md's structure rule).
 *
 * `new URL(path, base)` ignores `base` entirely when `path` itself parses
 * as an absolute URL (e.g. `http://169.254.169.254/`), which the SSRF
 * guard would still catch on the resulting host -- but silently probing a
 * different origin than the one the endpoint is organized under is a
 * product-correctness bug even when the host is public, so it is rejected
 * outright rather than allowed through.
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
