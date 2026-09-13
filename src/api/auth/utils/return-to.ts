const DEFAULT_RETURN_TO = '/';

/**
 * Validates a `returnTo` path (D9).
 *
 * An invalid value falls back to the default silently rather than answering
 * with an error page -- a malformed or hostile `returnTo` is not worth
 * interrupting the sign-in for, and the caller stores whatever this returns
 * rather than the raw input, so nothing unvalidated ever survives.
 *
 * Accepted only when it begins with a single `/`. Refused:
 * - `//evil.com` and `/\evil.com` -- both are open-redirect-by-parser: some
 *   browsers and some URL parsers treat a leading `//` or `/\` as
 *   protocol-relative, so what looks like a path is actually a redirect to
 *   another origin.
 * - anything containing a scheme (`:`) before the first `/` or `?` -- a
 *   defence in depth against a value that is not path-shaped at all.
 */
export function validateReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return DEFAULT_RETURN_TO;
  if (!value.startsWith('/')) return DEFAULT_RETURN_TO;
  if (value.startsWith('//') || value.startsWith('/\\')) return DEFAULT_RETURN_TO;

  // A scheme would need a ':' before the path/query actually starts. A path
  // that happens to contain a literal ':' later (a query value, say) is fine.
  const rest = value.slice(1);
  const boundary = rest.search(/[/?]/);
  const beforeBoundary = boundary === -1 ? rest : rest.slice(0, boundary);
  if (beforeBoundary.includes(':')) return DEFAULT_RETURN_TO;

  return value;
}
