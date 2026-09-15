import { z } from 'zod';
import type { Tag } from '../../../core/db/types.js';

/** key:value tag (B-5). Bounds are structural, not configured -- no reason to make these tunable. */
export const tagInputSchema = z
  .object({
    key: z.string().min(1).max(128),
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
