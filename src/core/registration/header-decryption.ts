import { decryptSecret } from '../crypto/header-cipher.js';
import type { Header } from '../db/types.js';

/**
 * Decrypts a stored secret header back to its plaintext value -- for M3's
 * probe executor, which must send the actual value on the wire. Lives in
 * `core`, not `api/registration`, because the worker needs it too and
 * `api`/`worker` never depend on each other (AGENTS.md's structure rule);
 * the api layer's own `HeaderStorageService` covers the DTO-facing half
 * (encrypt on write, redact on read), which the worker has no reason to
 * import.
 */
export function decryptHeaderValue(header: Header, key: Buffer): string {
  if (
    !header.is_secret ||
    !header.secret_ciphertext ||
    !header.secret_iv ||
    !header.secret_auth_tag
  ) {
    throw new Error('header is not a secret header');
  }
  return decryptSecret(
    { ciphertext: header.secret_ciphertext, iv: header.secret_iv, authTag: header.secret_auth_tag },
    key,
  );
}
