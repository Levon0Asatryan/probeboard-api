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
});
