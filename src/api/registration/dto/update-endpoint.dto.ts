import { z } from 'zod';
import {
  assertionSchema,
  HTTP_METHODS,
  INCIDENT_THRESHOLD_MAX,
  POSTGRES_INT4_MAX,
  STRUCTURAL_MAX_PATH_LENGTH,
  statusRangeSchema,
} from './endpoint-fields.js';
import { headerListSchema } from './header.dto.js';
import { tagListSchema } from './tag.dto.js';

/** `PATCH /v1/endpoints/:id`. Every field optional; omitted means unchanged. */
export const updateEndpointSchema = z
  .object({
    method: z.enum(HTTP_METHODS).optional(),
    path: z.string().min(1).max(STRUCTURAL_MAX_PATH_LENGTH).optional(),
    intervalS: z.number().int().positive().optional(),
    // Cross-field, so checked in EndpointsService, not here; described so the
    // generated document states it (z.toJSONSchema cannot express it).
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe(
        'Milliseconds. Must be less than the interval (PRD §6.5), checked against the ' +
          'stored interval when only one of the two is sent, and at most PROBE_MAX_TIMEOUT_MS.',
      )
      .optional(),
    expectedStatus: z.array(statusRangeSchema).min(1).optional(),
    latencyWarnMs: z.number().int().positive().max(POSTGRES_INT4_MAX).nullable().optional(),
    failureThreshold: z.number().int().min(1).max(INCIDENT_THRESHOLD_MAX).optional(),
    successThreshold: z.number().int().min(1).max(INCIDENT_THRESHOLD_MAX).optional(),
    followRedirects: z.boolean().optional(),
    maxRedirects: z.number().int().min(0).optional(),
    assertions: z.array(assertionSchema).optional(),
    headers: headerListSchema.optional(),
    tags: tagListSchema.optional(),
  })
  .strict();

export type UpdateEndpointRequest = z.infer<typeof updateEndpointSchema>;
