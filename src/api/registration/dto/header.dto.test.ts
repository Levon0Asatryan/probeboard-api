import { describe, expect, it } from 'vitest';
import { headerInputSchema, headerListSchema } from './header.dto.js';

describe('headerInputSchema', () => {
  it('accepts a plain header with a value', () => {
    expect(
      headerInputSchema.safeParse({ name: 'X-Foo', value: 'bar', isSecret: false }).success,
    ).toBe(true);
  });

  it('accepts a secret header replaced with a value', () => {
    expect(
      headerInputSchema.safeParse({ name: 'X-Api-Key', value: 'secret', isSecret: true }).success,
    ).toBe(true);
  });

  it('accepts a secret "keep" entry with no value key at all', () => {
    const result = headerInputSchema.safeParse({ name: 'X-Api-Key', isSecret: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.value).toBeUndefined();
  });

  it('rejects a plain header with no value -- only a secret may omit it', () => {
    const result = headerInputSchema.safeParse({ name: 'X-Foo', isSecret: false });
    expect(result.success).toBe(false);
  });

  it('rejects a header with no name', () => {
    expect(headerInputSchema.safeParse({ value: 'v', isSecret: false }).success).toBe(false);
  });

  it('defaults isSecret to false when omitted', () => {
    const result = headerInputSchema.safeParse({ name: 'X-Foo', value: 'bar' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isSecret).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      headerInputSchema.safeParse({ name: 'X-Foo', value: 'bar', isSecret: false, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('headerListSchema', () => {
  it('accepts an array of valid headers', () => {
    expect(
      headerListSchema.safeParse([
        { name: 'X-Foo', value: 'bar', isSecret: false },
        { name: 'X-Api-Key', isSecret: true },
      ]).success,
    ).toBe(true);
  });

  it('accepts an empty array', () => {
    expect(headerListSchema.safeParse([]).success).toBe(true);
  });
});
