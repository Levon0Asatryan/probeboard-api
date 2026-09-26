/**
 * Whether a thrown value means the database cannot be reached, rather than a
 * fault in this service (#72, D3).
 *
 * The distinction is the status a client acts on. `500` says "our bug, do not
 * retry"; `503` says "try again". With PostgreSQL stopped, every
 * authenticated route answered `500 INTERNAL_ERROR` while `/readyz` answered
 * `503 DATABASE_UNAVAILABLE`, so a client could not tell an outage from a
 * defect.
 *
 * Only shapes measured arriving from `pg` and `pg-pool` during an outage are
 * listed, each read from the top-level error, never a `cause` chain: the api's
 * only other outbound calls -- the OAuth providers -- are wrapped in
 * `OAuthProviderError` before they can reach the error filter, so a bare
 * socket code at the top can only have come from the database driver.
 * Anything else stays a `500`: calling a real bug an outage would hide it
 * behind "try again".
 */

/**
 * Socket failures opening or holding a connection. Measured: in the compose
 * stack a stopped `postgres` service is `ENOTFOUND` (its name leaves Docker's
 * DNS), against a host port `ECONNREFUSED`.
 */
const SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * PostgreSQL's own refusals (Appendix A, "PostgreSQL Error Codes"): class 08
 * is `connection_exception` as a whole; `57P01` admin_shutdown -- measured,
 * a backend terminated mid-query -- `57P02` crash_shutdown, `57P03`
 * cannot_connect_now (starting up or shutting down), and `53300`
 * too_many_connections.
 */
const SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

/**
 * `pg`/`pg-pool` failures that carry no code at all, matched by their exact
 * text (pg 8.23 `lib/client.js`, pg-pool 3.14 `index.js`). Measured: the
 * connect timeout and the query on a client whose connection died.
 * "Connection terminated" alone is deliberately absent -- that is this
 * process ending the client itself.
 */
const PG_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
]);

export function isDatabaseUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (SOCKET_CODES.has(code) || SQLSTATES.has(code)) return true;
    if (/^08[0-9A-Z]{3}$/.test(code)) return true;
  }
  return PG_MESSAGES.has(err.message);
}
