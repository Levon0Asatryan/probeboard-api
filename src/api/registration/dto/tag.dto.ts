import { z } from 'zod';
import type { Tag } from '../../../core/db/types.js';

/**
 * key:value tag (B-5). Bounds are structural, not configured -- no reason
 * to make these tunable.
 *
 * `key` may not contain a colon: the `?tag=key:value` filter always splits
 * on the *first* colon, so a tag written as `{key: "team:region", value:
 * "west"}` would be stored but could never be matched by that filter --
 * `?tag=team:region:west` parses as key `team`, value `region:west`.
 */
export const tagInputSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(128)
      .refine((v) => !v.includes(':'), { message: 'must not contain a colon' }),
    value: z.string().min(1).max(256),
  })
  .strict();

export type TagInput = z.infer<typeof tagInputSchema>;

/**
 * Rejected here, not left to the database: `tags_service_key_key`/
 * `tags_endpoint_key_key` would reject a duplicate key too, but as a raw
 * unique-violation error with no `.catch` mapping it to a client error --
 * the same class of gap `HeaderValidationService` closes for header names
 * at the boundary instead of relying on a DB constraint to fail loudly.
 */
export const tagListSchema = z
  .array(tagInputSchema)
  .refine((tags) => new Set(tags.map((t) => t.key)).size === tags.length, {
    message: 'duplicate tag key',
  });

export interface TagDto {
  key: string;
  value: string;
}

export function toTagDto(tag: Tag): TagDto {
  return { key: tag.key, value: tag.value };
}
