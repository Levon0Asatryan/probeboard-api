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

export const tagListSchema = z.array(tagInputSchema);

export interface TagDto {
  key: string;
  value: string;
}

export function toTagDto(tag: Tag): TagDto {
  return { key: tag.key, value: tag.value };
}
