import { describe, expect, it } from 'vitest';
import { effectiveUrl, toOrigin } from './url.js';

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

describe('effectiveUrl', () => {
  it('joins a relative path onto the base origin', () => {
    expect(effectiveUrl('https://example.com', '/orders')).toBe('https://example.com/orders');
  });

  it('defaults to the base itself when path is just "/"', () => {
    expect(effectiveUrl('https://example.com', '/')).toBe('https://example.com/');
  });

  it('rejects a path that resolves to a different origin', () => {
    // new URL(path, base) ignores base entirely when path is itself absolute.
    expect(() => effectiveUrl('https://example.com', 'http://169.254.169.254/')).toThrow();
  });

  it('rejects a path with a different scheme via a schema-relative form', () => {
    expect(() => effectiveUrl('https://example.com', '//evil.example.net/x')).toThrow();
  });
});
