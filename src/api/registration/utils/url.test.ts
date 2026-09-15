import { describe, expect, it } from 'vitest';
import { assertPathBytes, canonicalPath, toOrigin } from './url.js';

describe('toOrigin', () => {
  it('strips a path down to scheme + host', () => {
    expect(toOrigin('https://example.com/v1/orders')).toBe('https://example.com');
  });

  it('keeps a non-default port', () => {
    expect(toOrigin('http://example.com:8080/x')).toBe('http://example.com:8080');
  });

  it('drops query and fragment', () => {
    expect(toOrigin('https://example.com/x?a=1#frag')).toBe('https://example.com');
  });
});

describe('canonicalPath', () => {
  it('adds a leading slash to a path missing one', () => {
    expect(canonicalPath('https://example.com', 'orders')).toBe('/orders');
  });

  it('resolves dot-segments to the same canonical form', () => {
    expect(canonicalPath('https://example.com', '/a/../orders')).toBe('/orders');
    expect(canonicalPath('https://example.com', '/orders')).toBe('/orders');
  });

  it('keeps the query string', () => {
    expect(canonicalPath('https://example.com', '/orders?status=open')).toBe('/orders?status=open');
  });

  it('propagates the off-origin rejection effectiveUrl already enforces', () => {
    expect(() => canonicalPath('https://example.com', 'http://169.254.169.254/')).toThrow();
  });
});

describe('assertPathBytes', () => {
  it('accepts a path at or under the cap', () => {
    expect(() => assertPathBytes('/orders', 16)).not.toThrow();
  });

  it('rejects a path over the cap in bytes, not JS string length', () => {
    // 8 é characters: 8 UTF-16 code units, but 16 UTF-8 bytes -- plus the
    // leading slash, 17 bytes, over a 16-byte cap.
    expect(() => assertPathBytes(`/${'é'.repeat(8)}`, 16)).toThrow();
  });
});
