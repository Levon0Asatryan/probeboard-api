/**
 * TLS verdicts and certificate expiry, read from a completed handshake.
 *
 * The handshake runs with `rejectUnauthorized: false` and is judged here
 * instead (docs/m3-plan.md D6). Letting Node reject automatically yields one
 * generic thrown error, collapsing TLS_EXPIRED, TLS_UNTRUSTED and
 * TLS_HOSTNAME_MISMATCH into a single row, and it discards the certificate
 * at exactly the moment FR-22 needs it — an expired certificate is where
 * `cert_expires_at` is most useful. The trust boundary does not move: an
 * unauthorised socket is torn down before a single request byte is written.
 */
import type { DetailedPeerCertificate, PeerCertificate } from 'node:tls';
import type { FailureClass } from './failure-classes.js';

/**
 * `socket.authorizationError` values to the taxonomy.
 *
 * The first four are §3.4's own Node-signal column. The chain codes below
 * them are the same operational meaning — "chain incomplete or self-signed" —
 * reached by a different path, and are listed so a routine misconfigured
 * chain is not reported as UNKNOWN_ERROR.
 */
const AUTHORIZATION_ERROR_CLASS: Readonly<Record<string, FailureClass>> = {
  CERT_HAS_EXPIRED: 'TLS_EXPIRED',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS_UNTRUSTED',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS_UNTRUSTED',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS_HOSTNAME_MISMATCH',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS_UNTRUSTED',
  UNABLE_TO_GET_ISSUER_CERT: 'TLS_UNTRUSTED',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS_UNTRUSTED',
};

/**
 * Classifies an `authorizationError`. Anything unlisted is UNKNOWN_ERROR with
 * the code kept by the caller, never coerced into the nearest-looking class.
 */
export function classifyAuthorizationError(code: string): FailureClass {
  return Object.hasOwn(AUTHORIZATION_ERROR_CLASS, code)
    ? AUTHORIZATION_ERROR_CLASS[code]
    : 'UNKNOWN_ERROR';
}

/** Parses Node's `valid_to` ("Mar  1 00:00:00 2030 GMT"). */
function notAfter(cert: PeerCertificate): Date | undefined {
  if (typeof cert.valid_to !== 'string' || cert.valid_to === '') return undefined;
  const parsed = new Date(cert.valid_to);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The earliest `notAfter` across the presented chain — the certificate that
 * will fail first, whichever position it holds (blackbox_exporter's
 * `getEarliestCertExpiry`).
 *
 * The walk has a termination guard, and it is not optional (D56). Node
 * returns the chain as a linked list through `issuerCertificate`, and at a
 * self-signed root that property points at **the same object**. The obvious
 * `while (cert.issuerCertificate)` therefore never ends on an ordinary,
 * correctly trusted chain — and it is synchronous, so no deadline or abort
 * can fire: the worker's whole event loop stops, taking every concurrent
 * probe with it. Go avoids this only because it hands blackbox_exporter a
 * flat slice.
 *
 * The visited set is the whole guard. A self-signed root is just the
 * one-element case of a cycle, so an extra `issuer === current` check would
 * be unreachable — removing it changes no test, which is the reason it is
 * not here.
 */
export function earliestExpiry(
  cert: DetailedPeerCertificate | PeerCertificate | undefined,
): Date | undefined {
  const visited = new Set<unknown>();
  let current: DetailedPeerCertificate | PeerCertificate | undefined = cert;
  let earliest: Date | undefined;

  while (current !== undefined && Object.keys(current).length > 0 && !visited.has(current)) {
    visited.add(current);

    const expiry = notAfter(current);
    if (expiry !== undefined && (earliest === undefined || expiry < earliest)) earliest = expiry;

    current = (current as DetailedPeerCertificate).issuerCertificate;
  }

  return earliest;
}
