import { describe, expect, it } from 'vitest';
import {
  JSON_PATH_ACCEPTED,
  JSON_PATH_REJECTED,
} from '../../../core/assertions/json-path-grammar.js';
import { assertionSchema, statusRangeSchema } from './endpoint-fields.js';

describe('statusRangeSchema', () => {
  it('accepts a valid range', () => {
    expect(statusRangeSchema.safeParse({ min: 200, max: 299 }).success).toBe(true);
  });

  it('accepts min === max', () => {
    expect(statusRangeSchema.safeParse({ min: 200, max: 200 }).success).toBe(true);
  });

  it('rejects min > max', () => {
    expect(statusRangeSchema.safeParse({ min: 300, max: 200 }).success).toBe(false);
  });

  it('bounds both to valid HTTP status codes', () => {
    expect(statusRangeSchema.safeParse({ min: 99, max: 200 }).success).toBe(false);
    expect(statusRangeSchema.safeParse({ min: 200, max: 600 }).success).toBe(false);
  });
});

describe('assertionSchema', () => {
  it('accepts a body_contains assertion', () => {
    expect(assertionSchema.safeParse({ type: 'body_contains', value: 'ok' }).success).toBe(true);
  });

  it('accepts a body_not_contains assertion', () => {
    expect(assertionSchema.safeParse({ type: 'body_not_contains', value: 'error' }).success).toBe(
      true,
    );
  });

  it('accepts a json_path assertion with an arbitrary equals value', () => {
    expect(
      assertionSchema.safeParse({ type: 'json_path', path: '$.status', equals: 'ok' }).success,
    ).toBe(true);
    expect(
      assertionSchema.safeParse({ type: 'json_path', path: '$.count', equals: 5 }).success,
    ).toBe(true);
  });

  it('rejects an unknown assertion type', () => {
    expect(assertionSchema.safeParse({ type: 'header_equals', value: 'x' }).success).toBe(false);
  });

  it('rejects a body_contains with no value', () => {
    expect(assertionSchema.safeParse({ type: 'body_contains' }).success).toBe(false);
  });

  it('accepts an object/array/boolean/null equals value, recursively', () => {
    expect(
      assertionSchema.safeParse({
        type: 'json_path',
        path: '$.x',
        equals: { a: [1, 'b', true, null, { c: 2 }] },
      }).success,
    ).toBe(true);
  });

  it('rejects Infinity/-Infinity/NaN -- JSON has no token for them', () => {
    // JSON.parse never actually produces these (a request body containing
    // "Infinity" fails to parse at all), but a caller could still construct
    // one via a large exponent like 1e400 -- JSON.parse turns that into
    // Infinity, and z.unknown() would have accepted it silently.
    for (const equals of [Infinity, -Infinity, NaN]) {
      expect(assertionSchema.safeParse({ type: 'json_path', path: '$.x', equals }).success).toBe(
        false,
      );
    }
  });

  it('rejects Infinity nested inside an object or array', () => {
    expect(
      assertionSchema.safeParse({ type: 'json_path', path: '$.x', equals: { a: Infinity } })
        .success,
    ).toBe(false);
    expect(
      assertionSchema.safeParse({ type: 'json_path', path: '$.x', equals: [1, Infinity] }).success,
    ).toBe(false);
  });

  it.each([...JSON_PATH_ACCEPTED])('accepts the supported json_path %j', (path) => {
    expect(assertionSchema.safeParse({ type: 'json_path', path, equals: 1 }).success).toBe(true);
  });

  it.each([...JSON_PATH_REJECTED])('rejects the unsupported json_path %j', (path) => {
    expect(assertionSchema.safeParse({ type: 'json_path', path, equals: 1 }).success).toBe(false);
  });

  it('rejects a wildcard path rather than storing one every probe would fail', () => {
    // The case this constraint exists for: `$.items[*].id` is a perfectly
    // ordinary JSONPath expression, and the evaluator cannot express it, so
    // accepting it here would store a monitor that reports permanent false
    // downtime from its first probe (docs/m3-plan.md D36).
    const result = assertionSchema.safeParse({
      type: 'json_path',
      path: '$.items[*].id',
      equals: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a value JSON cannot represent at all, such as undefined or a function', () => {
    expect(
      assertionSchema.safeParse({ type: 'json_path', path: '$.x', equals: undefined }).success,
    ).toBe(false);
    expect(
      assertionSchema.safeParse({ type: 'json_path', path: '$.x', equals: () => undefined })
        .success,
    ).toBe(false);
  });
});
