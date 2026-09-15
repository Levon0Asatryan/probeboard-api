import { describe, expect, it } from 'vitest';
import { listQuerySchema } from './list-query.dto.js';

describe('listQuerySchema', () => {
  it('defaults limit and leaves cursor/tag unset', () => {
    const result = listQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.cursor).toBeUndefined();
      expect(result.data.tag).toBeUndefined();
    }
  });

  it('caps limit at the structural ceiling -- the real, configured cap is enforced in the service layer', () => {
    expect(listQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: '1000' }).success).toBe(true);
    // A value comfortably under the structural ceiling but over a typical
    // configured MAX_LIST_LIMIT (default 100) is still schema-valid --
    // clamping that is ServicesService/EndpointsService.list's job.
    expect(listQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
  });

  it('rejects a malformed cursor -- not a UUID', () => {
    expect(listQuerySchema.safeParse({ cursor: 'not-a-uuid' }).success).toBe(false);
  });

  it('accepts a UUID cursor', () => {
    expect(
      listQuerySchema.safeParse({ cursor: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });

  it('parses "key:value" into {key, value} (B-5)', () => {
    const result = listQuerySchema.safeParse({ tag: 'env:prod' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tag).toEqual({ key: 'env', value: 'prod' });
  });

  it('splits only on the first colon, so a value may contain one', () => {
    const result = listQuerySchema.safeParse({ tag: 'region:us-east:1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tag).toEqual({ key: 'region', value: 'us-east:1' });
  });

  it('rejects a tag filter with no colon', () => {
    expect(listQuerySchema.safeParse({ tag: 'noSeparator' }).success).toBe(false);
  });

  it('rejects a tag filter with an empty key', () => {
    expect(listQuerySchema.safeParse({ tag: ':prod' }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(listQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
