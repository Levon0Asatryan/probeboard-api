/**
 * Normalises an email address for storage and lookup.
 *
 * It must be applied on both sides of every comparison. Registering
 * `Alice@Example.com` and looking up `alice@example.com` has to find the same
 * row, or a user can hold two accounts on one address and the unique index
 * never notices.
 *
 * Only case and surrounding whitespace are touched. Provider-specific rules —
 * Gmail ignoring dots, plus-addressing — are deliberately not applied: they
 * are not universal, and silently merging `a+work@` with `a@` would be wrong
 * for the many providers that treat them as distinct addresses.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
