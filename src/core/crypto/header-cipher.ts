import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Reversible encryption for secret header values (docs/m2-plan.md §5.4).
 *
 * Unlike the session token's hash (`session-token.ts`), this must be
 * reversible: M3's probe executor has to send the actual header value on the
 * wire. There is no encryption utility anywhere else in this repository to
 * reuse -- everything else stores a value that only ever needs comparing,
 * never recovering.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * rather than decrypting to garbage the caller might mistake for the real
 * value. A fresh random 12-byte IV per value -- GCM's recommended width --
 * because reusing an IV with the same key breaks GCM's confidentiality
 * guarantee entirely, not just degrades it.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Decodes `HEADER_ENCRYPTION_KEY` into the raw key bytes `encrypt`/`decrypt` need. */
export function parseHeaderEncryptionKey(base64Key: string): Buffer {
  return Buffer.from(base64Key, 'base64');
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/**
 * Throws if `key` is wrong or `secret` was tampered with -- GCM's tag check
 * fails closed. The thrown error carries no plaintext and no key material;
 * callers must not include `secret` itself in whatever they log or respond
 * with (docs/m2-plan.md §5.4's "never logged, never in an error response").
 */
export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, secret.iv);
  decipher.setAuthTag(secret.authTag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}
