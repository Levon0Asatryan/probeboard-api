/**
 * The decisions a redirect hop needs, as pure functions.
 *
 * probeboard runs its own redirect loop instead of letting the HTTP client
 * follow them, because every CVE in the plan's §2.5 corpus — MLflow, Papra,
 * Budibase, Squidex — is the same bug: the original URL is validated, the
 * client auto-follows a `3xx`, and the redirect target is never re-checked.
 * Following manually is what makes re-validating each hop possible at all.
 *
 * The loop itself (which owns response bodies and per-hop dispatchers) lives
 * with `probe()`. These are the rules it applies.
 */

/**
 * Statuses that are followed, per the Fetch spec's HTTP-redirect-fetch.
 *
 * Not "any 3xx with a Location". `300`, `305` and `306` are not
 * follow-and-retry redirects, and `304 Not Modified` is a legitimate *final*
 * answer — chasing a `Location` it may happen to carry would hide the real
 * response from status and assertion evaluation.
 */
const FOLLOWED_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isFollowedRedirect(status: number): boolean {
  return FOLLOWED_STATUSES.has(status);
}

/**
 * Headers describing a request body, dropped when the method becomes `GET`.
 *
 * Lower-cased for comparison: M2 validates header names case-insensitively
 * but stores whatever casing the user submitted, so an exact-string match
 * would strip `Content-Type` and miss `content-type` — an inconsistency with
 * no relation to what the header actually is.
 */
const BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
]);

/**
 * The method for the next hop, per the Fetch spec.
 *
 * Replaying the configured method unconditionally would issue a second
 * `POST`/`PUT` against the monitored API — something no browser, curl or
 * standard library does, which also makes the probe's result incomparable to
 * the user's own experience of their API.
 */
export function methodForRedirect(status: number, method: string): string {
  const current = method.toUpperCase();

  // 303 always becomes GET, except for GET/HEAD which are already safe.
  if (status === 303) return current === 'GET' || current === 'HEAD' ? current : 'GET';

  // 301/302 rewrite only POST. 307/308 preserve the method by definition.
  if ((status === 301 || status === 302) && current === 'POST') return 'GET';

  return current;
}

/** Scheme, host and port together — the origin an HTTP client compares. */
function originOf(url: URL): string {
  return `${url.protocol}//${url.hostname}:${url.port === '' ? defaultPort(url) : url.port}`;
}

function defaultPort(url: URL): string {
  return url.protocol === 'https:' ? '443' : '80';
}

export function sameOrigin(a: URL, b: URL): boolean {
  return originOf(a) === originOf(b);
}

export interface HopHeaderInput {
  /** The effective headers as configured, already decrypted. */
  headers: Readonly<Record<string, string>>;
  /** Where this hop is going. */
  target: URL;
  /** The URL the probe originally requested — not the previous hop. */
  origin: URL;
  /** Whether any earlier hop already dropped them. */
  alreadyDropped: boolean;
  /** Whether this hop's method was rewritten to GET. */
  rewrittenToGet: boolean;
}

export interface HopHeaders {
  headers: Record<string, string>;
  /** Sticky: once the map has been dropped it stays dropped for later hops. */
  dropped: boolean;
}

/**
 * The headers to send on the next hop.
 *
 * Two independent rules, both of which can fire on the same hop:
 *
 * 1. **Origin change drops everything** (D15). The map can hold the monitor's
 *    own API key for the intended origin, and a redirect to an unrelated host
 *    would otherwise send that key there. Compared against the *original*
 *    request, not the previous hop, so a chain that returns to the original
 *    origin cannot re-admit headers already stripped — and a scheme downgrade
 *    counts as a change. Mainstream clients do this for `Authorization`;
 *    probeboard applies it to every configured header, because any of them
 *    can carry a secret.
 * 2. **A rewrite to `GET` drops the body headers** (D31). This fires on
 *    *same-origin* hops too, where rule 1 does not apply, so a bodyless `GET`
 *    never carries a `Content-Type` describing a body that no longer exists.
 */
export function headersForHop(input: HopHeaderInput): HopHeaders {
  if (input.alreadyDropped || !sameOrigin(input.target, input.origin)) {
    return { headers: {}, dropped: true };
  }

  if (!input.rewrittenToGet) {
    return { headers: { ...input.headers }, dropped: false };
  }

  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!BODY_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return { headers: kept, dropped: false };
}
