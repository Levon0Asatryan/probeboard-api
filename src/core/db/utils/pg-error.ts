/**
 * Detects a Postgres unique-violation error (SQLSTATE 23505), optionally
 * scoped to a specific constraint name. `pg`/`node-postgres` throws a plain
 * `DatabaseError` with these fields rather than a typed class, so this is a
 * type guard over the field shape rather than an `instanceof` check.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== '23505') return false;
  return constraint === undefined || e.constraint === constraint;
}
