import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateToken,
  hashToken,
  looksLikeToken,
  TOKEN_PREFIX,
  tokenHashesEqual,
} from '../sessions/session-token.js';

describe('generateToken', () => {
  it('carries a prefix, so a leaked token is recognisable', () => {
    expect(generateToken().startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it('is 256 bits of entropy in base64url', () => {
    const body = generateToken().slice(TOKEN_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(body, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const many = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(many.size).toBe(1000);
  });

  it('is url-safe, so it survives a cookie and a header unescaped', () => {
    for (let i = 0; i < 200; i++) {
      const token = generateToken();
      expect(encodeURIComponent(token)).toBe(token);
    }
  });
});

describe('hashToken', () => {
  it('is SHA-256 of the token', () => {
    const token = generateToken();
    expect(hashToken(token)).toEqual(createHash('sha256').update(token, 'utf8').digest());
  });

  it('is stable for one token and different for another', () => {
    const token = generateToken();
    expect(hashToken(token)).toEqual(hashToken(token));
    expect(hashToken(token)).not.toEqual(hashToken(generateToken()));
  });

  it('does not contain the token, which is the point of storing it', () => {
    const token = generateToken();
    expect(hashToken(token).toString('base64url')).not.toContain(token.slice(TOKEN_PREFIX.length));
  });
});

describe('looksLikeToken', () => {
  it('accepts what generateToken produces', () => {
    for (let i = 0; i < 100; i++) expect(looksLikeToken(generateToken())).toBe(true);
  });

  it('rejects anything that cannot be a token', () => {
    for (const bad of [
      '',
      'pbs_',
      'pbs_short',
      'nope_' + 'a'.repeat(43),
      'a'.repeat(47),
      `${TOKEN_PREFIX}${'a'.repeat(42)}`,
      `${TOKEN_PREFIX}${'a'.repeat(44)}`,
      `${TOKEN_PREFIX}${'+'.repeat(43)}`,
      `${TOKEN_PREFIX}${'a'.repeat(42)}=`,
    ]) {
      expect(looksLikeToken(bad)).toBe(false);
    }
  });
});

describe('tokenHashesEqual', () => {
  it('matches a hash against itself and rejects another', () => {
    const a = hashToken(generateToken());
    expect(tokenHashesEqual(a, Buffer.from(a))).toBe(true);
    expect(tokenHashesEqual(a, hashToken(generateToken()))).toBe(false);
  });

  it('rejects a different length without throwing', () => {
    // timingSafeEqual throws on mismatched lengths; the guard must come first.
    expect(() => tokenHashesEqual(Buffer.alloc(32), Buffer.alloc(16))).not.toThrow();
    expect(tokenHashesEqual(Buffer.alloc(32), Buffer.alloc(16))).toBe(false);
  });
});
