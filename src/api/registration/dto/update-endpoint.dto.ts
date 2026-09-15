import { z } from 'zod';
import {
  assertionSchema,
  HTTP_METHODS,
  MAX_ENDPOINT_PATH_BYTES,
  statusRangeSchema,
} from './endpoint-fields.js';
import { headerListSchema } from './header.dto.js';
import { tagListSchema } from './tag.dto.js';

/** `PATCH /v1/endpoints/:id`. Every field optional; omitted means unchanged. */
export const updateEndpointSchema = z
  .object({
    method: z.enum(HTTP_METHODS).optional(),
    path: z.string().min(1).max(MAX_ENDPOINT_PATH_BYTES).optional(),
    intervalS: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    expectedStatus: z.array(statusRangeSchema).min(1).optional(),
    latencyWarnMs: z.number().int().positive().nullable().optional(),
    failureThreshold: z.number().int().min(1).max(100).optional(),
    successThreshold: z.number().int().min(1).max(100).optional(),
    followRedirects: z.boolean().optional(),
    maxRedirects: z.number().int().min(0).optional(),
    assertions: z.array(assertionSchema).optional(),
    headers: headerListSchema.optional(),
    tags: tagListSchema.optional(),
  })
  .strict();

export type UpdateEndpointRequest = z.infer<typeof updateEndpointSchema>;
