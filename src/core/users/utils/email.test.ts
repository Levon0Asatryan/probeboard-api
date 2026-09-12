import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('lowercases, so one address cannot become two accounts', () => {
    expect(normalizeEmail('Alice@Example.com')).toBe('alice@example.com');
    expect(normalizeEmail('ALICE@EXAMPLE.COM')).toBe('alice@example.com');
  });

  it('trims surrounding whitespace, which forms paste in', () => {
    expect(normalizeEmail('  alice@example.com \n')).toBe('alice@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmail(' Alice@Example.com ');
    expect(normalizeEmail(once)).toBe(once);
  });

  it('leaves provider-specific aliasing alone', () => {
    // Plus-addressing and dots are distinct addresses at many providers;
    // collapsing them here would merge accounts that should stay separate.
    expect(normalizeEmail('a+work@example.com')).toBe('a+work@example.com');
    expect(normalizeEmail('a.b@example.com')).toBe('a.b@example.com');
  });
});
