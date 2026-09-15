import { z } from 'zod';

/**
 * Cursor pagination for the list endpoints (docs/m2-plan.md §5.5): opaque
 * cursor = the last row's `id` (always a UUID, since that's what every
 * owner table's primary key is -- validated here so a malformed cursor
 * 400s instead of reaching a UUID-typed column comparison and raising a
 * raw SQLSTATE 22P02), `limit` capped.
 *
 * The structural ceiling below is generous and deliberately not the real
 * cap: the actual page-size limit is `MAX_LIST_LIMIT` in
 * `src/core/config/schema.ts`, enforced in the service layer -- a
 * parameter decorator's schema is built before config injection runs, the
 * same reason `PASSWORD_MIN_LENGTH` is enforced in `AuthService` rather
 * than a static zod bound.
 */
const STRUCTURAL_MAX_LIMIT = 1000;

/**
 * B-5: `?tag=key:value` filters either list endpoint. Split on the first
 * `:` only, so a value is free to contain one itself (e.g. `region:us-east:1`
 * splits to key `region`, value `us-east:1`) -- only the key is required to
 * be colon-free.
 */
export const tagFilterSchema = z
  .string()
  .refine((v) => v.includes(':') && v.indexOf(':') > 0, {
    message: 'must be "key:value"',
  })
  .transform((v) => {
    const i = v.indexOf(':');
    return { key: v.slice(0, i), value: v.slice(i + 1) };
  });

export const listQuerySchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(STRUCTURAL_MAX_LIMIT).default(50),
    tag: tagFilterSchema.optional(),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;
