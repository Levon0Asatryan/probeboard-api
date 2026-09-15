import { describe, expect, it } from 'vitest';
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
});
