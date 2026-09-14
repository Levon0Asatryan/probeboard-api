const DEFAULT_RETURN_TO = '/';

/**
 * A syntactically invalid origin, so a value that resolves back to exactly
 * this one really did stay a same-origin path -- and one nobody could
 * register, so a same-origin match can only mean the input never carried an
 * origin of its own.
 */
const DUMMY_ORIGIN = 'https://return-to.invalid';

/**
 * Validates a `returnTo` path (D9).
 *
 * An invalid value falls back to the default silently rather than answering
 * with an error page -- a malformed or hostile `returnTo` is not worth
 * interrupting the sign-in for, and the caller stores whatever this returns
 * rather than the raw input, so nothing unvalidated ever survives.
 *
 * Resolved against a dummy origin with the WHATWG `URL` parser, rather than
 * pattern-matched, and accepted only if the origin comes back unchanged.
 * Pattern-matching lost to exactly the parser it was trying to out-guess:
 * `/\t/evil.com`, `/\n/evil.com` and `/\r/evil.com` all begin with a literal
 * `/`, so a check for a leading `/` and no leading `//` or `/\` passes every
 * one of them -- but the URL parser strips ASCII tab and newline from the
 * *whole* input before doing anything else, so what it actually parses is
 * `//evil.com`, a protocol-relative reference to another origin entirely.
 * A leading `/\` is the same failure by another route: for a special scheme
 * (`https:` among them) the parser treats `\` exactly like `/`, so it is
 * already two slashes before the origin check ever runs. Comparing the
 * parsed origin catches every variant of both at once, including ones this
 * comment does not enumerate, instead of a blacklist that only ever grows by
 * one confirmed bypass at a time.
 *
 * The origin comparison alone is not sufficient, though: dot-segment
 * resolution happens on the *path*, before the origin is fixed, and can
 * produce a resolved path that itself begins with `//` or `/\` even though
 * the parse-time origin never moved -- `/.//evil.com`, `/%2e//evil.com` and
 * `/a/..//evil.com` all resolve to a pathname of `//evil.com` while
 * `url.origin` stays `DUMMY_ORIGIN` the whole time. That pathname is exactly
 * as dangerous as the inputs above once the caller does its own
 * `new URL(returnTo, WEB_BASE_URL)`: a leading `//` there is protocol-relative
 * again, one level down. So the *result*, not only the input, is checked for
 * the same leading pattern before it is accepted.
 */
export function validateReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return DEFAULT_RETURN_TO;
  if (!value.startsWith('/')) return DEFAULT_RETURN_TO;

  let url: URL;
  try {
    url = new URL(value, DUMMY_ORIGIN);
  } catch {
    return DEFAULT_RETURN_TO;
  }

  if (url.origin !== DUMMY_ORIGIN) return DEFAULT_RETURN_TO;
  if (url.pathname.startsWith('//') || url.pathname.startsWith('/\\')) return DEFAULT_RETURN_TO;

  // Never the parsed href: that would carry DUMMY_ORIGIN itself. Path, query
  // and fragment are the only parts a same-origin return target needs.
  return `${url.pathname}${url.search}${url.hash}`;
}
