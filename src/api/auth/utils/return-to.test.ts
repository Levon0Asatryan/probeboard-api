import { describe, expect, it } from 'vitest';
import { validateReturnTo } from './return-to.js';

describe('validateReturnTo', () => {
  it('accepts an ordinary path', () => {
    expect(validateReturnTo('/services')).toBe('/services');
  });

  it('accepts a path with a query string', () => {
    expect(validateReturnTo('/services?tab=incidents')).toBe('/services?tab=incidents');
  });

  it('defaults when missing', () => {
    expect(validateReturnTo(undefined)).toBe('/');
    expect(validateReturnTo(null)).toBe('/');
    expect(validateReturnTo('')).toBe('/');
  });

  it('defaults a value that is not a string', () => {
    expect(validateReturnTo(42)).toBe('/');
    expect(validateReturnTo(['/services'])).toBe('/');
  });

  it('defaults a value with no leading slash', () => {
    expect(validateReturnTo('services')).toBe('/');
  });

  it('defaults a protocol-relative path (//evil.com)', () => {
    expect(validateReturnTo('//evil.com')).toBe('/');
  });

  it('defaults a backslash-protocol-relative path (/\\evil.com)', () => {
    expect(validateReturnTo('/\\evil.com')).toBe('/');
  });

  it('defaults an absolute URL to another origin', () => {
    expect(validateReturnTo('https://evil.com')).toBe('/');
  });

  it('accepts a colon that appears after the path, not as a scheme', () => {
    // A leading '/' means this is never interpretable as a scheme by
    // anything that consumes the resulting redirect -- schemes are
    // recognised only at the very start of a URL. Refusing it would be
    // rejecting a harmless path for a resemblance that cannot bite.
    expect(validateReturnTo('/services?returnAt=12:30')).toBe('/services?returnAt=12:30');
    expect(validateReturnTo('/javascript:alert(1)')).toBe('/javascript:alert(1)');
  });

  it.each([
    ['a tab', '/\t/evil.com'],
    ['a line feed', '/\n/evil.com'],
    ['a carriage return', '/\r/evil.com'],
  ])('defaults a path smuggling %s before a protocol-relative host', (_label, value) => {
    // The WHATWG URL parser strips ASCII tab and newline from the whole
    // input before parsing anything else, so this is "//evil.com" by the
    // time origin comparison would see it if these were not caught first --
    // proof that origin comparison alone, without stripping first, is not
    // enough; the parser's own stripping step is what does the work here,
    // and comparing the origin it produces is what catches it.
    expect(validateReturnTo(value)).toBe('/');
  });

  it('preserves the query and fragment on an accepted path', () => {
    expect(validateReturnTo('/services?tab=incidents#section')).toBe(
      '/services?tab=incidents#section',
    );
  });

  it.each([
    ['a leading dot segment', '/.//evil.com'],
    ['a percent-encoded dot segment', '/%2e//evil.com'],
    ['a dot-dot segment', '/a/..//evil.com'],
  ])(
    'defaults a returnTo whose dot-segment resolution produces a protocol-relative path (%s)',
    (_label, value) => {
      // The origin comparison alone is not enough here: dot-segment
      // resolution happens on the path, before the origin is fixed, so
      // url.origin never moves even though the resolved pathname is
      // "//evil.com" -- exactly as dangerous once the caller does its own
      // new URL(returnTo, WEB_BASE_URL), one level down.
      expect(validateReturnTo(value)).toBe('/');
    },
  );

  it('is idempotent: validating an already-accepted value returns it unchanged', () => {
    for (const value of [
      '/services',
      '/services?tab=incidents#section',
      '/javascript:alert(1)',
      '/',
    ]) {
      const once = validateReturnTo(value);
      expect(validateReturnTo(once)).toBe(once);
    }
  });

  it('is idempotent for every rejected value too: the default survives re-validation', () => {
    for (const value of [
      '//evil.com',
      '/\\evil.com',
      '/.//evil.com',
      '/%2e//evil.com',
      '/a/..//evil.com',
    ]) {
      const once = validateReturnTo(value);
      expect(validateReturnTo(once)).toBe(once);
    }
  });
});
