import { describe, expect, it } from 'vitest';
import {
  classifyAbort,
  classifyError,
  classifyResolverCode,
  isAbortError,
  transportCode,
  type FailureClass,
} from './failure-classes.js';
import type { Boundaries } from './timing.js';

/** Shapes a `fetch()` transport failure: the real code sits on `.cause`. */
function wrapped(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('underlying'), { code }),
  });
}

describe('transportCode', () => {
  it('reads the code from the cause, not the wrapper', () => {
    // fetch() wraps transport errors: the wrapper's own `code` is undefined,
    // so reading it directly reports every network failure as UNKNOWN_ERROR.
    const error = wrapped('ECONNREFUSED');
    expect((error as { code?: string }).code).toBeUndefined();
    expect(transportCode(error)).toBe('ECONNREFUSED');
  });

  it('reads a code that is already on the error itself', () => {
    expect(transportCode(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe('EPIPE');
  });

  it('walks more than one level of cause', () => {
    const deep = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('mid'), {
        cause: Object.assign(new Error('inner'), { code: 'EAI_AGAIN' }),
      }),
    });
    expect(transportCode(deep)).toBe('EAI_AGAIN');
  });

  it('terminates on a cyclic cause chain instead of hanging', () => {
    // A library-provided linked structure with no termination guard has
    // already bitten this repository once (D56's self-signed certificate,
    // which is its own issuer).
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(transportCode(a)).toBeUndefined();
  });

  it('returns nothing for a non-object or an error with no code', () => {
    expect(transportCode('ECONNREFUSED')).toBeUndefined();
    expect(transportCode(null)).toBeUndefined();
    expect(transportCode(new Error('plain'))).toBeUndefined();
  });
});

describe('classifyError', () => {
  // Every row of 03-api-health.md §3.4 that a thrown Node signal produces.
  const rows: readonly [string, FailureClass][] = [
    ['ENOTFOUND', 'DNS_NXDOMAIN'],
    ['EAI_AGAIN', 'DNS_FAILURE'],
    ['ECONNREFUSED', 'CONNECTION_REFUSED'],
    ['UND_ERR_CONNECT_TIMEOUT', 'CONNECTION_TIMEOUT'],
    ['ETIMEDOUT', 'CONNECTION_TIMEOUT'],
    // Not in §3.4's column: the path saying the host cannot be reached, which
    // is §3.4's CONNECTION_TIMEOUT meaning delivered actively (#72, defect 2).
    ['EHOSTUNREACH', 'CONNECTION_TIMEOUT'],
    ['ENETUNREACH', 'CONNECTION_TIMEOUT'],
    ['ECONNRESET', 'CONNECTION_RESET'],
    ['EPIPE', 'CONNECTION_RESET'],
    ['CERT_HAS_EXPIRED', 'TLS_EXPIRED'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_UNTRUSTED'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_UNTRUSTED'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_HOSTNAME_MISMATCH'],
    // Not in §3.4's column, but the same meaning as the two TLS_UNTRUSTED
    // rows above by a different OpenSSL verify path. They reach here as
    // TlsVerificationError.code, and without these rows an ordinary
    // misconfigured chain -- a server omitting its intermediate -- reports
    // UNKNOWN_ERROR instead of TLS_UNTRUSTED.
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_UNTRUSTED'],
    ['UNABLE_TO_GET_ISSUER_CERT', 'TLS_UNTRUSTED'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS_UNTRUSTED'],
    ['EPROTO', 'TLS_HANDSHAKE_FAILED'],
    ['UND_ERR_HEADERS_TIMEOUT', 'RESPONSE_TIMEOUT'],
    ['UND_ERR_BODY_TIMEOUT', 'BODY_TIMEOUT'],
  ];

  it.each(rows)('classifies %s as %s', (code, expected) => {
    expect(classifyError(wrapped(code))).toEqual({ failureClass: expected, code });
  });

  it('keeps the raw code when the signal is unmapped, never coercing it', () => {
    // Architecture §7.4: "never silently coerced to a generic failure". A
    // wrong-but-plausible class sends an operator to the wrong system.
    expect(classifyError(wrapped('ESOMETHINGNEW'))).toEqual({
      failureClass: 'UNKNOWN_ERROR',
      code: 'ESOMETHINGNEW',
    });
  });

  it('reports UNKNOWN_ERROR with no code when there is nothing to read', () => {
    expect(classifyError(new Error('no code at all'))).toEqual({ failureClass: 'UNKNOWN_ERROR' });
  });

  it('is not fooled by a `code` inherited from the prototype chain', () => {
    const parent = { code: 'ECONNREFUSED' };
    const child = Object.create(parent) as object;
    expect(classifyError(child)).toEqual({ failureClass: 'UNKNOWN_ERROR' });
  });
});

describe('classifyResolverCode', () => {
  // Node's dns error-code list, the rows a failing resolver can produce. Each
  // is also driven through a real c-ares resolver in probe.test.ts.
  const rows: readonly [string, FailureClass][] = [
    ['ENOTFOUND', 'DNS_NXDOMAIN'],
    ['ENODATA', 'DNS_NXDOMAIN'],
    ['ESERVFAIL', 'DNS_FAILURE'],
    ['EREFUSED', 'DNS_FAILURE'],
    ['ETIMEOUT', 'DNS_FAILURE'],
    ['ECONNREFUSED', 'DNS_FAILURE'],
    ['EBADRESP', 'DNS_FAILURE'],
    ['ENOTIMP', 'DNS_FAILURE'],
    ['EFORMERR', 'DNS_FAILURE'],
    ['EAI_AGAIN', 'DNS_FAILURE'],
  ];

  it.each(rows)('classifies %s as %s', (code, expected) => {
    expect(classifyResolverCode(code)).toBe(expected);
  });

  it('does not read the resolver vocabulary through the transport table', () => {
    // The collision the second table exists for: the same code, two meanings.
    expect(classifyResolverCode('ECONNREFUSED')).toBe('DNS_FAILURE');
    expect(classifyError(wrapped('ECONNREFUSED')).failureClass).toBe('CONNECTION_REFUSED');
  });

  it('leaves an undocumented or inherited code UNKNOWN_ERROR', () => {
    expect(classifyResolverCode('ECANCELLED')).toBe('UNKNOWN_ERROR');
    expect(classifyResolverCode('toString')).toBe('UNKNOWN_ERROR');
  });
});

describe('classifyAbort', () => {
  const at = (...reached: (keyof Boundaries)[]): Boundaries =>
    Object.fromEntries(reached.map((b, i) => [b, i + 1]));

  it('reports DNS_FAILURE while resolution is still outstanding', () => {
    // Checked first on purpose: an earlier draft tested connect_done first and
    // called a deadline firing mid-resolve a CONNECTION_TIMEOUT.
    expect(classifyAbort(at('dns_start'), { https: true })).toBe('DNS_FAILURE');
  });

  it('reports CONNECTION_TIMEOUT once DNS is done but the socket is not', () => {
    expect(classifyAbort(at('dns_start', 'dns_done', 'connect_start'), { https: true })).toBe(
      'CONNECTION_TIMEOUT',
    );
  });

  it('reports CONNECTION_TIMEOUT for a handshake that never completes', () => {
    // D25: the peer accepted TCP and never sent a ServerHello, so no HTTP
    // request could have been sent -- calling it RESPONSE_TIMEOUT would imply
    // the server was asked something and stayed silent.
    const b = at('dns_start', 'dns_done', 'connect_start', 'connect_done', 'tls_start');
    expect(classifyAbort(b, { https: true })).toBe('CONNECTION_TIMEOUT');
  });

  it('does not wait for TLS on a plain http target', () => {
    const b = at('dns_start', 'dns_done', 'connect_start', 'connect_done');
    expect(classifyAbort(b, { https: false })).toBe('RESPONSE_TIMEOUT');
  });

  it('reports RESPONSE_TIMEOUT when connected but no headers arrived', () => {
    const b = at('dns_start', 'dns_done', 'connect_start', 'connect_done', 'tls_start', 'tls_done');
    expect(classifyAbort(b, { https: true })).toBe('RESPONSE_TIMEOUT');
  });

  it('reports BODY_TIMEOUT when headers arrived and the body stalled', () => {
    const b = at(
      'dns_start',
      'dns_done',
      'connect_start',
      'connect_done',
      'tls_start',
      'tls_done',
      'first_byte',
    );
    expect(classifyAbort(b, { https: true })).toBe('BODY_TIMEOUT');
  });

  it('treats an IP-literal target as resolved, not as a DNS failure', () => {
    // §3.4 sets dns_start/dns_done together for a literal, so dns_ms reads 0
    // honestly -- and an abort mid-connect is not mistaken for DNS.
    const b = at('dns_start', 'dns_done', 'connect_start');
    expect(classifyAbort(b, { https: false })).toBe('CONNECTION_TIMEOUT');
  });

  it('invents no phase when every boundary was already reached', () => {
    const b = at(
      'dns_start',
      'dns_done',
      'connect_start',
      'connect_done',
      'tls_start',
      'tls_done',
      'first_byte',
      'transfer_done',
    );
    expect(classifyAbort(b, { https: true })).toBe('UNKNOWN_ERROR');
  });
});

describe('isAbortError', () => {
  it('recognises an AbortError raised as a DOMException', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('recognises a TimeoutError', () => {
    expect(isAbortError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it('rejects an ordinary transport error', () => {
    expect(isAbortError(wrapped('ECONNRESET'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
