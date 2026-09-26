/**
 * Node error signals and phase boundaries to the failure taxonomy.
 *
 * The taxonomy is not new design: `03-api-health.md` §3.4 specifies all
 * fifteen classes with the exact Node signal that produces each, and
 * architecture §7.4 adds the sixteenth rule — "unmapped codes become
 * `UNKNOWN_ERROR` with the raw code retained — never silently coerced to a
 * generic failure". This module is that table, executable.
 *
 * FR-20 is why it matters: failures must be *distinguishable*. A monitor that
 * reports "it broke" for a refused connection, an expired certificate and a
 * stalled body is telling an operator nothing about which of the three to go
 * and fix.
 */
import type { Boundaries } from './timing.js';

export type FailureClass =
  | 'DNS_NXDOMAIN'
  | 'DNS_FAILURE'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'CONNECTION_RESET'
  | 'TLS_EXPIRED'
  | 'TLS_UNTRUSTED'
  | 'TLS_HOSTNAME_MISMATCH'
  | 'TLS_HANDSHAKE_FAILED'
  | 'RESPONSE_TIMEOUT'
  | 'BODY_TIMEOUT'
  | 'STATUS_MISMATCH'
  | 'ASSERTION_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'BLOCKED_BY_POLICY'
  | 'UNKNOWN_ERROR';

export interface Classification {
  failureClass: FailureClass;
  /**
   * The raw Node/undici code, kept whatever the classification. On
   * `UNKNOWN_ERROR` it is the whole point — the caller reports a code it does
   * not recognise rather than discarding it.
   */
  code?: string;
}

/**
 * `03-api-health.md` §3.4's signal column, plus the rows marked "beyond
 * §3.4" -- each a code measured arriving from a real transport with the same
 * operational meaning as the class it maps to.
 */
const SIGNAL_TO_CLASS: Readonly<Record<string, FailureClass>> = {
  ENOTFOUND: 'DNS_NXDOMAIN',
  EAI_AGAIN: 'DNS_FAILURE',
  ECONNREFUSED: 'CONNECTION_REFUSED',
  UND_ERR_CONNECT_TIMEOUT: 'CONNECTION_TIMEOUT',
  ETIMEDOUT: 'CONNECTION_TIMEOUT',
  // Beyond §3.4's column: the kernel's answer when something on the path
  // *says* the host cannot be reached instead of silently dropping the SYN --
  // an ICMP host/net unreachable, an administratively-prohibited reject, or a
  // local ARP that got no reply. §3.4's CONNECTION_TIMEOUT meaning is exactly
  // that, "firewall or dead host"; only the delivery differs, and a firewall
  // configured to REJECT rather than DROP must not change the class. Not
  // CONNECTION_REFUSED, whose meaning is the opposite ("host up, nothing
  // listening"). Which of the two codes arrives depends on the kernel and its
  // routes, not on the target: the same address measured EHOSTUNREACH on
  // macOS and ENETUNREACH on Linux, so both must mean the same thing here.
  EHOSTUNREACH: 'CONNECTION_TIMEOUT',
  ENETUNREACH: 'CONNECTION_TIMEOUT',
  ECONNRESET: 'CONNECTION_RESET',
  EPIPE: 'CONNECTION_RESET',
  // undici's own wrapper for "the socket closed when we did not expect it".
  // Once the connector has handed the socket over, a peer reset reaches
  // `fetch()` as a `SocketError` carrying this code, and the cause walk stops
  // at the first code it finds -- so without this row an ordinary mid-response
  // reset reports UNKNOWN_ERROR, which M6 excludes from uptime instead of
  // counting as DOWN. Measured against a real local server that destroys the
  // socket after sending headers.
  UND_ERR_SOCKET: 'CONNECTION_RESET',
  CERT_HAS_EXPIRED: 'TLS_EXPIRED',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS_UNTRUSTED',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS_UNTRUSTED',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS_HOSTNAME_MISMATCH',
  EPROTO: 'TLS_HANDSHAKE_FAILED',
  // Beyond §3.4's own column: the same operational meaning as the two
  // TLS_UNTRUSTED codes above — "chain incomplete or self-signed" — reached by
  // a different OpenSSL verify path. They arrive here through
  // `TlsVerificationError.code` (pinned-connect.ts), which is why they are in
  // this one map rather than a second one beside it: two maps over the same
  // codes disagree the first time either is edited.
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS_UNTRUSTED',
  UNABLE_TO_GET_ISSUER_CERT: 'TLS_UNTRUSTED',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS_UNTRUSTED',
  UND_ERR_HEADERS_TIMEOUT: 'RESPONSE_TIMEOUT',
  UND_ERR_BODY_TIMEOUT: 'BODY_TIMEOUT',
};

/**
 * The resolver's own error codes, for the guard path.
 *
 * A second vocabulary, not a second copy of the one above. `SIGNAL_TO_CLASS`
 * reads what undici's connect raises, and with the guard off that resolves
 * through `dns.lookup` -- `getaddrinfo`, whose failures are `ENOTFOUND` and
 * `EAI_AGAIN`. The guard resolves with `resolve4`/`resolve6` instead, which
 * is c-ares, and c-ares reports Node's `dns` error constants
 * (https://nodejs.org/docs/latest-v22.x/api/dns.html#error-codes). It never
 * produces `EAI_AGAIN`, so reading its codes through the table above sent
 * every real resolver failure to UNKNOWN_ERROR -- a DNS outage excluded from
 * uptime, and under D-7 unable to open an incident.
 *
 * The two tables also cannot be merged, because they collide: c-ares'
 * `ECONNREFUSED` is "could not contact DNS servers" -- the *resolver*
 * refused -- while the transport's `ECONNREFUSED` is the endpoint refusing.
 * Read through the table above, a dead name server would report the
 * endpoint's process as down.
 *
 * Each row below is a documented c-ares answer, with Node's own description,
 * and each was produced against a real resolver on the pinned Node 22 before
 * it was added. This is reading, not the coercion architecture §7.4 forbids:
 * §3.4 defines DNS_FAILURE as "resolver itself is failing", and these are the
 * resolver saying so in its own words. A code off this list -- `ECANCELLED`,
 * `EBADNAME`, `ENOMEM`, anything new -- still stays UNKNOWN_ERROR with the
 * code retained, which is what §7.4 actually asks for.
 */
const RESOLVER_CODE_TO_CLASS: Readonly<Record<string, FailureClass>> = {
  // "Domain name not found" / "DNS server returned an answer with no data":
  // a definitive negative, the same pair `core/ssrf`'s NO_RECORD_CODES
  // already trusts.
  ENOTFOUND: 'DNS_NXDOMAIN',
  ENODATA: 'DNS_NXDOMAIN',
  // "DNS server returned general failure" -- SERVFAIL, a DNSSEC break, a
  // lapsed delegation.
  ESERVFAIL: 'DNS_FAILURE',
  // "DNS server refused query."
  EREFUSED: 'DNS_FAILURE',
  // "Timeout while contacting DNS servers."
  ETIMEOUT: 'DNS_FAILURE',
  // "Could not contact DNS servers." The resolver's refusal, not the endpoint's.
  ECONNREFUSED: 'DNS_FAILURE',
  // "Bad DNS reply."
  EBADRESP: 'DNS_FAILURE',
  // "DNS server does not implement the requested operation."
  ENOTIMP: 'DNS_FAILURE',
  // "DNS server claims query was misformatted." c-ares built the query, so
  // the fault is the server's.
  EFORMERR: 'DNS_FAILURE',
  // `getaddrinfo`'s spelling of a failing resolver, §3.4's own signal. c-ares
  // never raises it, but an injected resolver may, and it means the same.
  EAI_AGAIN: 'DNS_FAILURE',
};

/**
 * Classifies a resolver failure the SSRF guard attached as its `cause`.
 * UNKNOWN_ERROR for a code the resolver does not document.
 */
export function classifyResolverCode(code: string): FailureClass {
  return Object.hasOwn(RESOLVER_CODE_TO_CLASS, code)
    ? RESOLVER_CODE_TO_CLASS[code]
    : 'UNKNOWN_ERROR';
}

/** How far to walk a `cause` chain before giving up. */
const MAX_CAUSE_DEPTH = 8;

function hasOwnString(value: object, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Finds the transport code, walking `cause` (D34).
 *
 * `fetch()` does not throw transport errors directly: it wraps them in a
 * `TypeError` whose own `code` is `undefined` and whose `.cause` carries the
 * real one. Reading `error.code` alone therefore classifies every genuine
 * network failure as `UNKNOWN_ERROR` — which is how the first draft of this
 * plan would have reported a plain refused connection.
 *
 * Bounded, and tracking what it has seen: a `cause` chain is a
 * library-provided linked structure, and this repository has already been
 * bitten by walking one with no termination guard (D56, where a self-signed
 * certificate is its own issuer). A cyclic chain here would hang the worker.
 */
export function transportCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);

    const code = hasOwnString(current, 'code');
    if (code !== undefined) return code;

    current = Object.hasOwn(current, 'cause') ? (current as { cause: unknown }).cause : undefined;
  }
  return undefined;
}

/**
 * Classifies a thrown transport error.
 *
 * An unmapped code is `UNKNOWN_ERROR` *with the code retained*, never coerced
 * into the nearest-looking class: a wrong-but-plausible class is worse than an
 * honest "unrecognised", because it sends an operator to the wrong system.
 */
export function classifyError(error: unknown): Classification {
  const code = transportCode(error);
  if (code === undefined) return { failureClass: 'UNKNOWN_ERROR' };

  const mapped = Object.hasOwn(SIGNAL_TO_CLASS, code)
    ? SIGNAL_TO_CLASS[code]
    : sslProtocolFailure(code);
  return { failureClass: mapped ?? 'UNKNOWN_ERROR', code };
}

/**
 * OpenSSL protocol-level failures, which do not arrive as `EPROTO`.
 *
 * §3.5 named `EPROTO` as the TLS_HANDSHAKE_FAILED signal, and that row stays
 * — but measured against real handshakes, Node reports the specific OpenSSL
 * code instead: `ERR_SSL_WRONG_VERSION_NUMBER` for https against a plain HTTP
 * port, `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION` for a version both ends cannot
 * agree on. Neither is `EPROTO`, so TLS_HANDSHAKE_FAILED was unreachable for
 * the two commonest real causes and both reported UNKNOWN_ERROR.
 *
 * A prefix rule rather than a list, because the `ERR_SSL_` family is open and
 * every member of it means the same thing at this level: the TLS layer failed
 * before any HTTP was exchanged. This is not the coercion §7.4 forbids — the
 * raw code is still returned alongside, so an operator sees exactly which
 * OpenSSL error it was. Certificate verdicts do not come through here at all;
 * they arrive as `authorizationError` codes (`CERT_HAS_EXPIRED`,
 * `ERR_TLS_CERT_ALTNAME_INVALID`) and keep their own distinct classes above.
 */
function sslProtocolFailure(code: string): FailureClass | undefined {
  return code.startsWith('ERR_SSL_') ? 'TLS_HANDSHAKE_FAILED' : undefined;
}

/**
 * Classifies the *overall* deadline firing, by the last boundary reached.
 *
 * The outer `AbortSignal` bounds the whole probe (D4) so a slow early phase
 * cannot let a later phase's own timer consume a second full budget. But when
 * it fires, undici raises a plain `AbortError` carrying none of
 * `UND_ERR_CONNECT_TIMEOUT`/`_HEADERS_TIMEOUT`/`_BODY_TIMEOUT` — so the error
 * itself says nothing about *where* the probe was. The boundaries do.
 *
 * Checked in temporal order, which is load-bearing: an earlier unfinished
 * phase must never be read as a later one. An earlier draft checked
 * `connect_done` first and misclassified a deadline firing mid-DNS-resolve as
 * `CONNECTION_TIMEOUT` instead of `DNS_FAILURE`.
 *
 * `dns_done` is set even for an IP-literal target (§3.4 defines it as the
 * moment the guard reaches that check, so `dns_ms` reads `0` honestly), so a
 * literal target aborting mid-connect is not mistaken for a DNS failure.
 */
export function classifyAbort(boundaries: Boundaries, options: { https: boolean }): FailureClass {
  if (boundaries.dns_done === undefined) return 'DNS_FAILURE';
  if (boundaries.connect_done === undefined) return 'CONNECTION_TIMEOUT';
  // D25: a peer that accepts the TCP connection and never completes the
  // handshake has not answered an HTTP request -- none could have been sent.
  // The taxonomy has no "handshake stalled" class (TLS_HANDSHAKE_FAILED is
  // EPROTO, a cipher/protocol mismatch), so this folds into the closest
  // existing one rather than inventing an undocumented class.
  if (options.https && boundaries.tls_done === undefined) return 'CONNECTION_TIMEOUT';
  if (boundaries.first_byte === undefined) return 'RESPONSE_TIMEOUT';
  if (boundaries.transfer_done === undefined) return 'BODY_TIMEOUT';

  // Every boundary reached: the probe had finished, so a deadline firing now
  // describes nothing. Reporting a phase would be inventing one.
  return 'UNKNOWN_ERROR';
}

/** Whether a thrown value is the outer deadline rather than a transport fault. */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = hasOwnString(error, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  // Node's AbortController rejects with a DOMException whose `name` lives on
  // the prototype, not as an own property.
  const proto = (error as { name?: unknown }).name;
  return proto === 'AbortError' || proto === 'TimeoutError';
}
