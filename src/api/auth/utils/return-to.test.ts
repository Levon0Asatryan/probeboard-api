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

  it('defaults a value carrying a scheme', () => {
    expect(validateReturnTo('/javascript:alert(1)')).toBe('/');
    expect(validateReturnTo('https://evil.com')).toBe('/');
  });

  it('accepts a colon that appears after the path, not as a scheme', () => {
    expect(validateReturnTo('/services?returnAt=12:30')).toBe('/services?returnAt=12:30');
  });
});
