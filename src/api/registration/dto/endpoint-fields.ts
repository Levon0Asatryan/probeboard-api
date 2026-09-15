import { z, type ZodType } from 'zod';

/** `EndpointsTable.expected_status` (docs/m2-plan.md §3): `[{min,max}, ...]`, default `[{200,299}]`. */
export const statusRangeSchema = z
  .object({
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  })
  .strict()
  .refine((r) => r.min <= r.max, { message: 'min must not exceed max', path: ['min'] });

/**
 * Every value JSON can actually represent, recursively -- `equals` is
 * compared against a value M3 parses back out of `JSON.parse`d response
 * data, so it must round-trip through `JSON.stringify` unchanged.
 * `z.unknown()` would accept `Infinity`/`NaN`/`-Infinity`: JSON has no
 * token for them, so `JSON.stringify` silently emits `null` in their
 * place, and the assertion actually stored and later evaluated is not the
 * one the caller submitted.
 */
const jsonValueSchema: ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * `EndpointsTable.assertions` (docs/m2-plan.md §3): structured and versioned
 * (architecture ADR-5), never a string DSL. M2 stores these opaquely; M3's
 * assertion evaluator (chapter 7.9) is their first real reader.
 */
export const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('body_contains'), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal('body_not_contains'), value: z.string().min(1) }).strict(),
  z
    .object({ type: z.literal('json_path'), path: z.string().min(1), equals: jsonValueSchema })
    .strict(),
]);

/** PostgreSQL `integer` column range -- `latency_warn_ms` has no other bound. */
export const POSTGRES_INT4_MAX = 2_147_483_647;

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
