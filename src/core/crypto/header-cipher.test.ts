import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  parseHeaderEncryptionKey,
  type EncryptedSecret,
} from './header-cipher.js';

const key = randomBytes(32);
const otherKey = randomBytes(32);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plaintext value', () => {
    const secret = encryptSecret('sk_live_abc123', key);
    expect(decryptSecret(secret, key)).toBe('sk_live_abc123');
  });

  it('round-trips an empty string', () => {
    const secret = encryptSecret('', key);
    expect(decryptSecret(secret, key)).toBe('');
  });

  it('round-trips unicode', () => {
    const secret = encryptSecret('Bearer 秘密トークン', key);
    expect(decryptSecret(secret, key)).toBe('Bearer 秘密トークン');
  });

  it('never stores the plaintext in the ciphertext, IV or auth tag bytes', () => {
    const plaintext = 'sk_live_abc123';
    const secret = encryptSecret(plaintext, key);
    expect(secret.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(secret.iv.toString('utf8')).not.toContain(plaintext);
    expect(secret.authTag.toString('utf8')).not.toContain(plaintext);
  });

  it('uses a fresh IV every call, even for the same plaintext', () => {
    const a = encryptSecret('same value', key);
    const b = encryptSecret('same value', key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('fails closed on the wrong key -- proves the fix by removal: decrypting with the encrypting key still works', () => {
    const secret = encryptSecret('sk_live_abc123', key);
    expect(() => decryptSecret(secret, otherKey)).toThrow();
    expect(decryptSecret(secret, key)).toBe('sk_live_abc123');
  });

  it('fails closed on a tampered ciphertext, rather than decrypting to garbage', () => {
    const secret = encryptSecret('sk_live_abc123', key);
    const tampered: EncryptedSecret = {
      ...secret,
      ciphertext: Buffer.from(secret.ciphertext).fill(secret.ciphertext[0] ^ 0xff, 0, 1),
    };
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('fails closed on a tampered auth tag', () => {
    const secret = encryptSecret('sk_live_abc123', key);
    const tampered: EncryptedSecret = {
      ...secret,
      authTag: Buffer.from(secret.authTag).fill(secret.authTag[0] ^ 0xff, 0, 1),
    };
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('the thrown error on decryption failure carries no plaintext and no key material', () => {
    const secret = encryptSecret('sk_live_abc123', key);
    try {
      decryptSecret(secret, otherKey);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('sk_live_abc123');
      expect(message).not.toContain(key.toString('base64'));
      expect(message).not.toContain(otherKey.toString('base64'));
    }
  });
});

describe('parseHeaderEncryptionKey', () => {
  it('decodes a valid base64 key to 32 bytes', () => {
    const encoded = key.toString('base64');
    expect(parseHeaderEncryptionKey(encoded).equals(key)).toBe(true);
  });
});
