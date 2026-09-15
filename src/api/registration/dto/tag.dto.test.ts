import { describe, expect, it } from 'vitest';
import { tagInputSchema, tagListSchema, toTagDto } from './tag.dto.js';
import type { Tag } from '../../../core/db/types.js';

describe('tagInputSchema', () => {
  it('accepts a valid key:value pair', () => {
    expect(tagInputSchema.safeParse({ key: 'env', value: 'prod' }).success).toBe(true);
  });

  it('rejects an empty key or value', () => {
    expect(tagInputSchema.safeParse({ key: '', value: 'prod' }).success).toBe(false);
    expect(tagInputSchema.safeParse({ key: 'env', value: '' }).success).toBe(false);
  });

  it('bounds key and value length', () => {
    expect(tagInputSchema.safeParse({ key: 'a'.repeat(129), value: 'prod' }).success).toBe(false);
    expect(tagInputSchema.safeParse({ key: 'env', value: 'a'.repeat(257) }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(tagInputSchema.safeParse({ key: 'env', value: 'prod', extra: 1 }).success).toBe(false);
  });
});

describe('tagListSchema', () => {
  it('accepts an array, including empty', () => {
    expect(tagListSchema.safeParse([]).success).toBe(true);
    expect(tagListSchema.safeParse([{ key: 'env', value: 'prod' }]).success).toBe(true);
  });

  it('rejects a duplicate key, before it reaches the database unique index', () => {
    const result = tagListSchema.safeParse([
      { key: 'env', value: 'prod' },
      { key: 'env', value: 'staging' },
    ]);
    expect(result.success).toBe(false);
  });

  it('allows the same key on separate calls -- only within one list is it a duplicate', () => {
    expect(
      tagListSchema.safeParse([
        { key: 'env', value: 'a' },
        { key: 'team', value: 'b' },
      ]).success,
    ).toBe(true);
  });
});

describe('toTagDto', () => {
  it('maps a stored tag row to {key, value}, dropping ownership columns', () => {
    const row: Tag = { id: 'id', service_id: 'svc', endpoint_id: null, key: 'env', value: 'prod' };
    expect(toTagDto(row)).toEqual({ key: 'env', value: 'prod' });
  });
});
