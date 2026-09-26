import { randomState } from 'openid-client';
import { describe, expect, it } from 'vitest';
import { looksLikeState } from './oauth-callback.js';

describe('looksLikeState', () => {
  it('accepts what the library issues', () => {
    expect(looksLikeState(randomState())).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a NUL byte, which PostgreSQL text rejects', 'a\u0000b'],
    ['a space', 'a b'],
    ['base64 padding and plus, which base64url never produces', 'ab+c/d=='],
  ])('rejects %s', (_label, value) => {
    expect(looksLikeState(value)).toBe(false);
  });
});
