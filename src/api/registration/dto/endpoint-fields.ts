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

/**
 * A generous structural ceiling on `path`, in JS string length -- not the
 * real cap. The actual byte-length bound is `MAX_ENDPOINT_PATH_BYTES`
 * (`src/core/config/schema.ts`), enforced in `EndpointsService` against
 * `Buffer.byteLength` of the *canonical* path (after URL parsing, which can
 * expand a value through percent-encoding) -- a parameter decorator's
 * schema is built before config injection runs, and `z.string().max()`
 * counts UTF-16 code units, not UTF-8 bytes, so neither check belongs here.
 */
export const STRUCTURAL_MAX_PATH_LENGTH = 8192;
