/**
 * Reads a value out of a parsed JSON body by path.
 *
 * The grammar itself lives in `core` and is *not* reimplemented here
 * (docs/m3-plan.md D42). `api` cannot import from `worker` (ADR-0006), so when
 * the save-time schema and this evaluator each owned a copy of the accepted
 * syntax, the two could drift — and a path the DTO accepted but the evaluator
 * could not express would fail every probe forever, reporting permanent
 * downtime for a monitor the operator believes is configured correctly. That
 * is the exact failure ADR-0005 exists to prevent, so both call
 * `parseJsonPath`. This module owns only the traversal.
 *
 * The subset is deliberately minimal — dot names and integer array indices,
 * no wildcards, filters or recursive descent. FR-15 is a could-have, and
 * gatus calls its own hand-rolled JSONPath "half-baked" in its source; there
 * is no reason to over-build a feature this system does not need.
 */
import { parseJsonPath } from '../../../core/assertions/json-path-grammar.js';

/**
 * Found-ness is separate from the value, because `undefined` and `null` are
 * legitimate values in a response. A missing path must be distinguishable
 * from a path whose value happens to be null.
 */
export type PathLookup = { found: true; value: unknown } | { found: false };

const MISSING: PathLookup = { found: false };

function isTraversableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walks `path` through `root`.
 *
 * Every object step is an **own-property** check, never a plain `value[key]`
 * lookup (D55). Ordinary property access walks the prototype chain, so
 * `$.constructor.name` resolves against any object whatsoever — an assertion
 * whose path is entirely absent from the response would find a value the API
 * never sent and report the endpoint healthy. `$.__proto__.x` is the same
 * shape. Array indices get an explicit bounds check for the same reason:
 * `arr[5]` on a three-element array is `undefined`, not an error, and
 * `undefined === undefined` would quietly satisfy an `equals` comparison.
 *
 * A path the shared grammar does not accept is a miss rather than a throw —
 * the evaluator turns that into `ASSERTION_FAILED`, which is the honest
 * answer: nothing was verified.
 */
export function readJsonPath(root: unknown, path: string): PathLookup {
  const segments = parseJsonPath(path);
  if (segments === null) return MISSING;

  let current: unknown = root;

  for (const segment of segments) {
    if (segment.kind === 'name') {
      if (!isTraversableObject(current)) return MISSING;
      if (!Object.hasOwn(current, segment.name)) return MISSING;
      current = current[segment.name];
      continue;
    }

    if (!Array.isArray(current)) return MISSING;
    if (segment.index < 0 || segment.index >= current.length) return MISSING;
    current = current[segment.index];
  }

  return { found: true, value: current };
}

/**
 * Structural equality for `json_path`'s `equals` (D33).
 *
 * `EndpointAssertion` types `equals` as `unknown` and the request schema
 * accepts nested objects and arrays, so the comparison cannot be `===`, which
 * is reference equality and would fail against an identical object every
 * time. Nor can it be `JSON.stringify(a) === JSON.stringify(b)`: that is
 * sensitive to key order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` — the same
 * value by any reasonable reading — would compare unequal and turn a correct
 * response into a false report of downtime.
 *
 * So: primitives by value, arrays element-by-element in order, objects by key
 * set and per-key recursion regardless of insertion order.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // NaN is the one primitive that is not `===` itself. Treating two NaNs as
  // different would make an assertion unsatisfiable rather than merely false.
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => structurallyEqual(item, b[i]));
  }

  if (!isTraversableObject(a) || !isTraversableObject(b)) return false;

  // Own keys only, matching the traversal rule above: an inherited key is not
  // part of the value the API sent.
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]));
}
