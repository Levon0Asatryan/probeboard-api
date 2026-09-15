import { z } from 'zod';

/** `EndpointsTable.expected_status` (docs/m2-plan.md §3): `[{min,max}, ...]`, default `[{200,299}]`. */
export const statusRangeSchema = z
  .object({
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  })
  .strict()
  .refine((r) => r.min <= r.max, { message: 'min must not exceed max', path: ['min'] });

/**
 * `EndpointsTable.assertions` (docs/m2-plan.md §3): structured and versioned
 * (architecture ADR-5), never a string DSL. M2 stores these opaquely; M3's
 * assertion evaluator (chapter 7.9) is their first real reader.
 */
export const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('body_contains'), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal('body_not_contains'), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal('json_path'), path: z.string().min(1), equals: z.unknown() }).strict(),
]);

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** `path` bound (docs/m2-plan.md §3): joined with a validated `base_url` to form the probed URL. */
export const MAX_ENDPOINT_PATH_BYTES = 2048;
