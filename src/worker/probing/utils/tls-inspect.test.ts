import type { DetailedPeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { earliestExpiry } from './tls-inspect.js';

/**
 * A chain node carries only what `earliestExpiry` reads. The cast is to the
 * full `DetailedPeerCertificate` because Node's type has ~20 further fields
 * that no branch here touches.
 */
function cert(validTo: string, issuer?: DetailedPeerCertificate): DetailedPeerCertificate {
  const node = { valid_to: validTo } as unknown as DetailedPeerCertificate;
  node.issuerCertificate = issuer ?? node; // self-signed root by default
  return node;
}

describe('earliestExpiry', () => {
  it('returns the leaf expiry for a single self-signed certificate', () => {
    expect(earliestExpiry(cert('Mar 1 00:00:00 2030 GMT'))).toEqual(
      new Date('Mar 1 00:00:00 2030 GMT'),
    );
  });

  it('returns the earliest across the chain, not the leaf', () => {
    // blackbox_exporter's getEarliestCertExpiry: an intermediate that expires
    // before the leaf is what actually breaks the endpoint first, so that is
    // the date FR-22 has to show.
    const root = cert('Jan 1 00:00:00 2040 GMT');
    const intermediate = cert('Feb 1 00:00:00 2026 GMT', root);
    const leaf = cert('Dec 1 00:00:00 2030 GMT', intermediate);

    expect(earliestExpiry(leaf)).toEqual(new Date('Feb 1 00:00:00 2026 GMT'));
  });

  it('terminates on a self-signed root (D56)', () => {
    // The guard this whole walk exists for: Node points a root's
    // `issuerCertificate` at the same object, so `while (c.issuerCertificate)`
    // spins forever -- synchronously, so no deadline or abort can fire and
    // the worker's event loop stops with every concurrent probe on it.
    const root = cert('Jan 1 00:00:00 2040 GMT');
    const leaf = cert('Dec 1 00:00:00 2030 GMT', root);

    expect(earliestExpiry(leaf)).toEqual(new Date('Dec 1 00:00:00 2030 GMT'));
  });

  it('terminates on a chain that cycles through more than one certificate', () => {
    // Identity alone does not cover a cross-signed pair pointing at each
    // other; the visited set does.
    const a = cert('Jun 1 00:00:00 2031 GMT');
    const b = cert('Jun 1 00:00:00 2032 GMT', a);
    a.issuerCertificate = b;

    expect(earliestExpiry(b)).toEqual(new Date('Jun 1 00:00:00 2031 GMT'));
  });

  it('returns undefined when there is no certificate to read', () => {
    // `getPeerCertificate` returns `{}` when the peer sent nothing, which is
    // not an error -- there is simply no expiry to record.
    expect(earliestExpiry(undefined)).toBeUndefined();
    expect(earliestExpiry({} as DetailedPeerCertificate)).toBeUndefined();
  });

  it('skips an unparseable valid_to rather than recording an Invalid Date', () => {
    const root = cert('Jan 1 00:00:00 2040 GMT');
    const leaf = cert('not a date', root);

    expect(earliestExpiry(leaf)).toEqual(new Date('Jan 1 00:00:00 2040 GMT'));
    expect(earliestExpiry(cert('not a date'))).toBeUndefined();
  });
});
