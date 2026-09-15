import { describe, expect, it } from 'vitest';
import { encryptSecret, parseHeaderEncryptionKey } from '../crypto/header-cipher.js';
import type { Header } from '../db/types.js';
import { decryptHeaderValue } from './header-decryption.js';

const key = parseHeaderEncryptionKey('ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=');

function secretHeader(plaintext: string): Header {
  const enc = encryptSecret(plaintext, key);
  return {
    id: 'h1',
    service_id: 'svc',
    endpoint_id: null,
    name: 'X-Api-Key',
    is_secret: true,
    value: null,
    secret_ciphertext: enc.ciphertext,
    secret_iv: enc.iv,
    secret_auth_tag: enc.authTag,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('decryptHeaderValue', () => {
  it('recovers the original plaintext', () => {
    expect(decryptHeaderValue(secretHeader('round-trip-me'), key)).toBe('round-trip-me');
  });

  it('rejects a non-secret header', () => {
    const plain: Header = {
      id: 'h1',
      service_id: 'svc',
      endpoint_id: null,
      name: 'X-Foo',
      is_secret: false,
      value: 'bar',
      secret_ciphertext: null,
      secret_iv: null,
      secret_auth_tag: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    expect(() => decryptHeaderValue(plain, key)).toThrow('header is not a secret header');
  });

  it('throws rather than decrypting with the wrong key', () => {
    const other = parseHeaderEncryptionKey('VGfyiTyeff5ZbLltgSFvbqwopxVg6IdJIkAe9dX55XU=');
    expect(() => decryptHeaderValue(secretHeader('x'), other)).toThrow();
  });
});
