import { z } from 'zod';
import { headerListSchema } from './header.dto.js';
import { tagListSchema } from './tag.dto.js';

/**
 * `PATCH /v1/services/:id`. Every field is optional and touched only when
 * present -- `headers`/`tags` omitted means "leave as is" (the repository's
 * `replaceForService` is only called when the array is present), matching
 * `undefined`-means-untouched semantics used throughout this module.
 *
 * `baseUrl`, if present, is re-validated by the SSRF guard (D10: every save,
 * not only create) even though this looks like "the URL didn't change" from
 * the client's point of view -- a PATCH that replays an old, now-private
 * `baseUrl` must still be caught.
 */
export const updateServiceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    baseUrl: z.string().min(1).optional(),
    headers: headerListSchema.optional(),
    tags: tagListSchema.optional(),
  })
  .strict();

export type UpdateServiceRequest = z.infer<typeof updateServiceSchema>;
