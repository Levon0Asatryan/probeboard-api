import { z } from 'zod';

/** Structural bound on the free-text reason, like a service's name: prose for a human, not data. */
export const MAINTENANCE_REASON_MAX_LENGTH = 500;

/** Same structural ceiling as the other lists; `MAX_LIST_LIMIT` is the real cap. */
const STRUCTURAL_MAX_LIMIT = 1000;

/** An instant with an explicit offset: windows are `timestamptz` pairs, never wall-clock times (Gatus #1274). */
const instant = z.iso.datetime({ offset: true });

const reason = z.string().min(1).max(MAINTENANCE_REASON_MAX_LENGTH);

/**
 * `POST /v1/maintenance-windows` (docs/m6-plan.md §3.7, §3.10).
 *
 * Exactly one target, and `endsAt` after `startsAt`: both cross-field, so both
 * are `.refine()`s, which `z.toJSONSchema` drops -- the OpenAPI document
 * writes the `oneOf` out by hand (AGENTS.md). The rules that need the clock or
 * configuration (`endsAt` in the past, the maximum length, the quota) are the
 * service's, checked under the user row lock.
 */
export const createMaintenanceWindowSchema = z
  .object({
    serviceId: z.uuid().optional(),
    endpointId: z.uuid().optional(),
    startsAt: instant,
    endsAt: instant,
    reason: reason.optional(),
  })
  .strict()
  .refine((w) => (w.serviceId === undefined) !== (w.endpointId === undefined), {
    message: 'exactly one of serviceId and endpointId',
    path: ['serviceId'],
  })
  .refine((w) => Date.parse(w.endsAt) > Date.parse(w.startsAt), {
    message: 'must be after startsAt',
    path: ['endsAt'],
  });

export type CreateMaintenanceWindowRequest = z.infer<typeof createMaintenanceWindowSchema>;

/**
 * `PATCH`: the times and the reason. The target is not editable -- a window
 * moved to another endpoint is a different window. `reason: null` clears it.
 */
export const updateMaintenanceWindowSchema = z
  .object({
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    reason: reason.nullable().optional(),
  })
  .strict();

export type UpdateMaintenanceWindowRequest = z.infer<typeof updateMaintenanceWindowSchema>;

export const maintenanceWindowQuerySchema = z
  .object({
    serviceId: z.uuid().optional(),
    endpointId: z.uuid().optional(),
    /** true: covering now. false: not covering now (ended, or not yet started). */
    active: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(STRUCTURAL_MAX_LIMIT).default(50),
  })
  .strict();

export type MaintenanceWindowQuery = z.infer<typeof maintenanceWindowQuerySchema>;
