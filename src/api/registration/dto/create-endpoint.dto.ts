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

/**
 * `POST /v1/services/:id/endpoints`.
 *
 * `intervalS`/`timeoutMs`/`maxRedirects` are optional here and defaulted
 * from config in the service layer when absent -- the columns themselves
 * have no database default (FR-7/FR-8/FR-21: system-configurable, not a
 * fixed constant), and `intervalS`'s allowed-value set and the other two
 * fields' system caps are themselves configured
 * (`PROBE_ALLOWED_INTERVALS_S`, `PROBE_MAX_TIMEOUT_MS`,
 * `PROBE_MAX_REDIRECTS_CAP`), so membership/bound checks happen in
 * `EndpointsService`, not this schema -- same reasoning as `header.dto.ts`.
 */
export const createEndpointSchema = z
  .object({
    method: z.enum(HTTP_METHODS).default('GET'),
    path: z.string().min(1).max(STRUCTURAL_MAX_PATH_LENGTH).default('/'),
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

export type CreateEndpointRequest = z.infer<typeof createEndpointSchema>;
