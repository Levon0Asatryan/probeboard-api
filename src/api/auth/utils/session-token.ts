import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens.
 *
 * The token is 256 bits of CSPRNG output, so it has no structure to guess and
 * needs no slow hash. Only its SHA-256 is stored: a database leak must not
 * hand over live sessions, for the same reason passwords are not stored in the
 * clear. Argon2 here would be wrong — it would run on every authenticated
 * request, which is a self-inflicted denial of service.
 */

const TOKEN_BYTES = 32;

/**
 * Marks a probeboard session token wherever it surfaces — a log, a bug report,
 * a secret scanner. The same reason providers prefix their API keys.
 */
export const TOKEN_PREFIX = 'pbs_';

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Rejects anything that cannot be a token before it reaches the database, so a
 * malformed cookie costs an index lookup rather than a round trip.
 */
export function looksLikeToken(value: string): boolean {
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  const body = value.slice(TOKEN_PREFIX.length);
  // 32 bytes of base64url, unpadded.
  return /^[A-Za-z0-9_-]{43}$/.test(body);
}

/**
 * Constant-time comparison of two token hashes.
 *
 * The lookup is by unique index, so this is belt and braces rather than the
 * primary defence — but a length-dependent or short-circuiting comparison in
 * an authentication path is the kind of thing that is cheap to get right and
 * expensive to notice later.
 */
export function tokenHashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
