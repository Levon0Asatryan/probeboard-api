/**
 * The one definition of the `json_path` assertion's path language.
 *
 * Three consumers need it and none of them may restate it: the API validates
 * a submitted path at save time (`endpoint-fields.ts`), the worker evaluates
 * it on every probe (M3's assertion evaluator), and `openapi.yaml` documents
 * what the API accepts. `api` and `worker` cannot import each other
 * (ADR-0006), so `core` is the only place all three can share — and the
 * pattern is exported as data, not only as a predicate, so the OpenAPI
 * document embeds *this* regex rather than a hand-written copy of it that
 * drifts silently (docs/m3-plan.md D42, D49, D52).
 *
 * The accepted subset is deliberately small: dot-separated names and integer
 * array indices, nothing else. No wildcards, filters, recursive descent, or
 * quoted keys. A monitor whose path the evaluator cannot express would
 * otherwise pass validation and then fail every probe forever, reporting a
 * healthy endpoint as down (docs/m3-plan.md D36) — so the grammar the API
 * accepts and the grammar the worker evaluates are the same function call.
 *
 * `$` may lead the path or be omitted (`$.data.id` and `data.id` are the same
 * path); `$` alone selects the whole document. Index segments reject leading
 * zeros and negatives so one value has one spelling.
 */

const NAME = String.raw`[A-Za-z0-9_-]+`;
const INDEX = String.raw`\[(?:0|[1-9][0-9]*)\]`;
/** Any step after the first: a dotted name, or an index. */
const STEP = String.raw`(?:\.${NAME}|${INDEX})`;
/** The first step may omit the leading dot when the path has no `$` prefix. */
const FIRST = String.raw`(?:${NAME}|${INDEX})`;

/**
 * Anchored, flagless, and safe to share: `.test()` on a non-global RegExp
 * keeps no `lastIndex` state between calls, and this same `.source` is what
 * the DTO validates with and `openapi.yaml` publishes as the field's
 * `pattern` — one string, three consumers, no retyping.
 *
 * Terminated with `(?![\s\S])` rather than `$` for the *consumers*, not for
 * this runtime. Verified, not assumed: in JavaScript `$` without `m` already
 * means end-of-input — `/^a$/.test('a\n')` is `false` — so here the two are
 * equivalent. But this source string is published as the OpenAPI `pattern`,
 * and a validator outside JS reads it with its own engine: Python's `re`,
 * behind the usual `jsonschema` package, treats `$` as "end of input *or*
 * before a final newline", so `re.match(r'^a$', 'a\n')` matches. A generated
 * client would then accept `"data.id\n"` as a valid path while this server
 * rejects it. The negative lookahead says "nothing after this" in every
 * engine, so the published contract and the enforced one stay the same
 * grammar — which is the whole point of exporting one pattern (D52).
 */
export const JSON_PATH_PATTERN = new RegExp(String.raw`^(?:\$${STEP}*|${FIRST}${STEP}*)(?![\s\S])`);

export type JsonPathSegment = { kind: 'name'; name: string } | { kind: 'index'; index: number };

export function isSupportedJsonPath(path: string): boolean {
  return JSON_PATH_PATTERN.test(path);
}

/**
 * The segments an evaluator walks, or `null` for a path outside the subset.
 *
 * Returned rather than re-derived by the caller so the worker's traversal
 * cannot disagree with what validation accepted — the same reason the pattern
 * itself is exported instead of described.
 */
export function parseJsonPath(path: string): JsonPathSegment[] | null {
  if (!isSupportedJsonPath(path)) return null;

  const segments: JsonPathSegment[] = [];
  // `$` is the root, not a segment: `$.a` and `a` address the same value.
  const body = path.startsWith('$') ? path.slice(1) : path;

  for (const [, name, index] of body.matchAll(/\.?([A-Za-z0-9_-]+)|\[(\d+)\]/g)) {
    segments.push(
      name === undefined ? { kind: 'index', index: Number(index) } : { kind: 'name', name },
    );
  }

  return segments;
}

/**
 * The canonical examples of the language above, exported because every
 * consumer's tests iterate this same list rather than each naming a handful
 * of cases of its own. A grammar change that only some consumers follow then
 * fails here first, instead of surviving until one of them accepts a path
 * another rejects (docs/m3-plan.md D52).
 */
export const JSON_PATH_ACCEPTED = [
  '$',
  'a',
  '$.a',
  'data.items',
  '$.data.items',
  'items[0]',
  '$.items[0]',
  'data.items[0].id',
  '$.data.items[0].id',
  'matrix[0][1]',
  '[0]',
  'snake_case.kebab-case.digits2',
  // A response may legitimately carry these as ordinary keys; traversal is
  // own-property-only, so they resolve to the data or to nothing, never to a
  // prototype value (docs/m3-plan.md D55).
  '$.constructor',
  '$.__proto__',
] as const;

export const JSON_PATH_REJECTED = [
  '',
  '.a',
  'a.',
  'a..b',
  '$..a',
  '$.items[*].id',
  'items[*]',
  'a[?(@.x==1)]',
  'a[]',
  'a[-1]',
  'a[01]',
  'a[1.5]',
  "a['b']",
  'a["b"]',
  'a b',
  'a.b c',
  '$$',
  'a$',
  '$a',
] as const;
