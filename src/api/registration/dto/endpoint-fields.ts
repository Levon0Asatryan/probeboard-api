import { z, type ZodType } from 'zod';
import { JSON_PATH_PATTERN } from '../../../core/assertions/json-path-grammar.js';

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
export const jsonValueSchema: ZodType<unknown> = z.lazy(() =>
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
    .object({
      type: z.literal('json_path'),
      // The one grammar `core` defines, not a second spelling of it: the
      // worker evaluates exactly this subset, so a path accepted here that
      // the evaluator cannot express would pass validation and then fail
      // every probe forever, reporting a healthy endpoint as down
      // (docs/m3-plan.md D36/D42). A regex rather than `.refine()` for the
      // same reason `tag.dto.ts` uses one: `z.toJSONSchema` drops an
      // arbitrary predicate silently but converts a regex to `pattern`, so
      // `openapi.yaml` publishes the real bound instead of advertising any
      // non-empty string while the server answers 400 (D49/D52).
      path: z
        .string()
        .min(1)
        .regex(JSON_PATH_PATTERN, 'must be a supported JSON path: names and [0] indices only'),
      equals: jsonValueSchema,
    })
    .strict(),
]);

/** PostgreSQL `integer` column range -- `latency_warn_ms` has no other bound. */
export const POSTGRES_INT4_MAX = 2_147_483_647;

/**
 * PRD §6.5's list, exactly. `OPTIONS` was accepted too until #72 (defect 5)
 * found the schema wider than the specification; a monitor asks whether an
 * API serves its requests, and a preflight is not one of them.
 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/**
 * PRD §6.5: failures to open an incident and successes to close one are
 * each 1-10. Wider values reach M6's hysteresis unread today, which is why
 * the gap was harmless until now and why it closes before M6 reads them.
 */
export const INCIDENT_THRESHOLD_MAX = 10;

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
