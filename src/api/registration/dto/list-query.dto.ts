import { z } from 'zod';

/**
 * Cursor pagination for the list endpoints (docs/m2-plan.md §5.5): opaque
 * cursor = the last row's `id`, `limit` capped. First list-endpoint pattern
 * in this codebase -- M1 has no precedent, so this establishes the shape
 * `ListServicesOptions`/`ListEndpointsOptions` (core repositories) already
 * expect.
 */
export const MAX_LIST_LIMIT = 100;

export const listQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;
