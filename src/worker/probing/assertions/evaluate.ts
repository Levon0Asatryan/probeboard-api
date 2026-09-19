/**
 * Evaluates the three `EndpointAssertion` variants against a probe response.
 *
 * The governing idea is that an assertion may only report success from
 * evidence that actually supports it. The body this sees can be truncated
 * (NFR-13 caps it), and truncation is not a detail the assertions can ignore:
 * two of the three become unsound on a partial read, and both fail closed
 * rather than guessing.
 */
import type { EndpointAssertion } from '../../../core/db/types.js';
import { readJsonPath, structurallyEqual } from './json-path.js';

export interface ResponseBody {
  /** The retained bytes, decoded as UTF-8. Possibly a prefix of the real body. */
  text: string;
  /** Whether the body cap cut the read short (§3.6). */
  truncated: boolean;
}

export type AssertionResult =
  | { passed: true }
  /** `reason` is diagnostic only; the caller reports `ASSERTION_FAILED`. */
  | { passed: false; reason: string };

const PASSED: AssertionResult = { passed: true };

export function evaluateAssertion(
  assertion: EndpointAssertion,
  body: ResponseBody,
): AssertionResult {
  switch (assertion.type) {
    case 'body_contains':
      // Sound on a truncated body: "the string is not in what we read" is a
      // legitimate reason to fail a *positive* claim. The target might have
      // been in the unread tail, and failing is the conservative answer.
      return body.text.includes(assertion.value)
        ? PASSED
        : { passed: false, reason: 'body does not contain the expected substring' };

    case 'body_not_contains':
      // D23: the same check is unsound in the negative direction. A truncated
      // body that happens not to contain the string *in its read prefix*
      // would report "absent" from data that provably did not cover the whole
      // response -- the string could be sitting in the tail. Absence cannot be
      // proven from an incomplete read, so it is never asserted.
      if (body.truncated) {
        return {
          passed: false,
          reason: 'body was truncated, so absence of the substring cannot be proven',
        };
      }
      return body.text.includes(assertion.value)
        ? { passed: false, reason: 'body contains the forbidden substring' }
        : PASSED;

    case 'json_path':
      return evaluateJsonPath(assertion, body);
  }
}

function evaluateJsonPath(
  assertion: Extract<EndpointAssertion, { type: 'json_path' }>,
  body: ResponseBody,
): AssertionResult {
  // D28: checked *before* parsing, not after. A cut that lands just after a
  // complete, well-formed value -- `{"a":1}` truncated before trailing bytes
  // that would have made the full body invalid -- lets JSON.parse succeed on
  // the prefix and report a path value from data that does not represent the
  // real response. A coincidental parse success is exactly what a truncation
  // check exists to prevent.
  if (body.truncated) {
    return { passed: false, reason: 'body was truncated, so it was not parsed as JSON' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    // A genuine syntax error on the *full* body is an assertion failure, not
    // a crash: the endpoint answered with something that is not JSON, which
    // is a finding about the endpoint.
    return { passed: false, reason: 'body is not valid JSON' };
  }

  const lookup = readJsonPath(parsed, assertion.path);
  if (!lookup.found) {
    // Also the answer for a path outside the supported grammar: nothing was
    // verified, so nothing may be claimed.
    return { passed: false, reason: `no value at path ${assertion.path}` };
  }

  return structurallyEqual(lookup.value, assertion.equals)
    ? PASSED
    : {
        passed: false,
        reason: `value at path ${assertion.path} does not equal the expected value`,
      };
}

/**
 * Evaluates every assertion, stopping at the first failure.
 *
 * Short-circuiting is safe because the outcome is the same either way — one
 * failure means `ASSERTION_FAILED` — and it avoids parsing the body again for
 * assertions whose verdict cannot change the result.
 */
export function evaluateAssertions(
  assertions: readonly EndpointAssertion[],
  body: ResponseBody,
): AssertionResult {
  for (const assertion of assertions) {
    const result = evaluateAssertion(assertion, body);
    if (!result.passed) return result;
  }
  return PASSED;
}
