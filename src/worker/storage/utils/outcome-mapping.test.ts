import { describe, expect, it } from 'vitest';
import type { FailureClass, ProbeOutcome } from '../../probing/index.js';
import { outcomeLabel, toResultRow, type ResultContext } from './outcome-mapping.js';

const ctx: ResultContext = {
  endpointId: 'e1',
  slot: '2026-09-21 08:45:12.178512+00',
  intervalS: 60,
  workerId: 'w1',
  attemptId: '11111111-1111-4111-8111-111111111111',
};

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    monitorId: 'e1',
    startedAt: Date.parse('2026-09-21T08:45:12.200Z'),
    success: true,
    timings: { totalMs: 10 },
    truncated: false,
    redirects: 0,
    ...over,
  };
}

// Exhaustive by type: a new FailureClass is a compile error here until it is mapped.
const EXPECTED: Record<FailureClass, 'down' | 'unknown'> = {
  DNS_NXDOMAIN: 'down',
  DNS_FAILURE: 'down',
  CONNECTION_REFUSED: 'down',
  CONNECTION_TIMEOUT: 'down',
  CONNECTION_RESET: 'down',
  TLS_EXPIRED: 'down',
  TLS_UNTRUSTED: 'down',
  TLS_HOSTNAME_MISMATCH: 'down',
  TLS_HANDSHAKE_FAILED: 'down',
  RESPONSE_TIMEOUT: 'down',
  BODY_TIMEOUT: 'down',
  STATUS_MISMATCH: 'down',
  ASSERTION_FAILED: 'down',
  TOO_MANY_REDIRECTS: 'down',
  BLOCKED_BY_POLICY: 'unknown',
  UNKNOWN_ERROR: 'unknown',
};

describe('outcomeLabel', () => {
  it('is up for a success', () => {
    expect(outcomeLabel({ success: true })).toBe('up');
  });

  it.each(Object.entries(EXPECTED))('maps %s to %s', (cls, label) => {
    expect(outcomeLabel({ success: false, failureClass: cls as FailureClass })).toBe(label);
  });

  it('never manufactures an outage from a failure it cannot classify', () => {
    expect(outcomeLabel({ success: false })).toBe('unknown');
  });
});

describe('toResultRow', () => {
  it('lowercases the class to the label the 0001 enum defines, and keeps the raw code', () => {
    const row = toResultRow(
      outcome({
        success: false,
        failureClass: 'TLS_HOSTNAME_MISMATCH',
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      }),
      ctx,
    );
    expect(row).toMatchObject({
      outcome: 'down',
      failure_class: 'tls_hostname_mismatch',
      failure_code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });

  it('keeps class and code on the two rows that are not counted down', () => {
    for (const cls of ['BLOCKED_BY_POLICY', 'UNKNOWN_ERROR'] as const) {
      const row = toResultRow(outcome({ success: false, failureClass: cls, code: 'X' }), ctx);
      expect(row).toMatchObject({
        outcome: 'unknown',
        failure_class: cls.toLowerCase(),
        failure_code: 'X',
      });
    }
  });

  it('carries the slot as the text it arrived as, never a Date', () => {
    expect(toResultRow(outcome(), ctx).scheduled_at).toBe('2026-09-21 08:45:12.178512+00');
  });

  it('rounds fractional milliseconds -- the columns are integers and a fraction would be rejected', () => {
    const row = toResultRow(
      outcome({ timings: { totalMs: 12.6, dnsMs: 0.4, connectMs: 1.5, ttfbMs: 7.49 } }),
      ctx,
    );
    expect(row).toMatchObject({ total_ms: 13, dns_ms: 0, connect_ms: 2, ttfb_ms: 7 });
  });

  it('stores an absent phase as null, not as zero', () => {
    const row = toResultRow(outcome({ timings: { totalMs: 5 } }), ctx);
    expect(row).toMatchObject({
      dns_ms: null,
      connect_ms: null,
      tls_ms: null,
      ttfb_ms: null,
      transfer_ms: null,
      status_code: null,
      failure_class: null,
      failure_code: null,
      cert_expires_at: null,
    });
  });

  it('keeps a real zero phase distinct from an absent one', () => {
    expect(toResultRow(outcome({ timings: { totalMs: 5, dnsMs: 0 } }), ctx).dns_ms).toBe(0);
  });

  it('passes the attempt, worker, interval and start time through', () => {
    const row = toResultRow(outcome(), ctx);
    expect(row).toMatchObject({
      attempt_id: ctx.attemptId,
      worker_id: 'w1',
      interval_s: 60,
      endpoint_id: 'e1',
    });
    expect((row.started_at as Date).toISOString()).toBe('2026-09-21T08:45:12.200Z');
  });

  it('writes only the allow-listed columns -- no header, body or response text can reach a row', () => {
    expect(Object.keys(toResultRow(outcome(), ctx)).sort()).toEqual(
      [
        'endpoint_id',
        'started_at',
        'scheduled_at',
        'interval_s',
        'outcome',
        'failure_class',
        'failure_code',
        'status_code',
        'total_ms',
        'dns_ms',
        'connect_ms',
        'tls_ms',
        'ttfb_ms',
        'transfer_ms',
        'redirects',
        'truncated',
        'cert_expires_at',
        'worker_id',
        'attempt_id',
      ].sort(),
    );
  });
});
