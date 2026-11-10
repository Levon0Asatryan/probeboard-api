import { z } from 'zod';

/** Same structural ceiling as `listQuerySchema`; `MAX_LIST_LIMIT` is the real cap, applied in the service. */
const STRUCTURAL_MAX_LIMIT = 1000;

/**
 * `?status=open|closed&cursor&limit` on every incident list (docs/m6-plan.md
 * §3.10). The cursor is the last incident's `id`, resolved to its
 * `(opened_at, id)` inside the owner-scoped query -- a UUID, so a malformed
 * one is a 400 rather than a raw 22P02.
 */
export const incidentQuerySchema = z
  .object({
    status: z.enum(['open', 'closed']).optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(STRUCTURAL_MAX_LIMIT).default(50),
  })
  .strict();

export type IncidentQuery = z.infer<typeof incidentQuerySchema>;
