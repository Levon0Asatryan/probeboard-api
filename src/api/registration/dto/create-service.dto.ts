import { z } from 'zod';
import { headerListSchema } from './header.dto.js';
import { tagListSchema } from './tag.dto.js';

/**
 * `POST /v1/services`, in either of B-3's two forms (docs/m2-plan.md §5.5,
 * §10): explicit (`baseUrl` + required `name`) or implicit (`url` alone,
 * `name` optional -- the service is found-or-created by origin and one
 * endpoint is attached in the same transaction). One schema with a
 * discriminating refine, not a `z.union` of two shapes: a union's error
 * message on a malformed body is the union of both branches' failures,
 * which reads worse than naming the actual rule broken.
 *
 * `baseUrl`/`url` are re-validated by the SSRF guard in the service layer
 * (§5.1) -- this schema only checks they are non-empty strings, not that
 * they parse as a URL, so a malformed value reaches the guard's own
 * `SCHEME_NOT_ALLOWED`/etc. codes rather than a generic `VALIDATION_FAILED`.
 */
export const createServiceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    baseUrl: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    headers: headerListSchema.optional(),
    tags: tagListSchema.optional(),
  })
  .strict()
  .refine((b) => (b.baseUrl !== undefined) !== (b.url !== undefined), {
    message: 'exactly one of baseUrl (explicit form) or url (implicit form, B-3) must be present',
    path: ['baseUrl'],
  })
  .refine((b) => b.baseUrl === undefined || b.name !== undefined, {
    message: 'name is required in the explicit form',
    path: ['name'],
  });

export type CreateServiceRequest = z.infer<typeof createServiceSchema>;
