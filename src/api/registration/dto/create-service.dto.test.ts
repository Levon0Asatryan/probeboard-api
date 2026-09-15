import { describe, expect, it } from 'vitest';
import { createServiceSchema } from './create-service.dto.js';

describe('createServiceSchema', () => {
  it('accepts the explicit form: name + baseUrl', () => {
    expect(
      createServiceSchema.safeParse({ name: 'My API', baseUrl: 'https://example.com' }).success,
    ).toBe(true);
  });

  it('accepts the implicit form (B-3): url alone', () => {
    expect(createServiceSchema.safeParse({ url: 'https://example.com/orders' }).success).toBe(true);
  });

  it('accepts the implicit form with an optional name', () => {
    expect(
      createServiceSchema.safeParse({ url: 'https://example.com/orders', name: 'Orders' }).success,
    ).toBe(true);
  });

  it('rejects both baseUrl and url present at once', () => {
    const result = createServiceSchema.safeParse({
      name: 'x',
      baseUrl: 'https://example.com',
      url: 'https://example.com/orders',
    });
    expect(result.success).toBe(false);
  });

  it('rejects neither baseUrl nor url present', () => {
    expect(createServiceSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('rejects the explicit form with no name', () => {
    expect(createServiceSchema.safeParse({ baseUrl: 'https://example.com' }).success).toBe(false);
  });

  it('accepts optional headers and tags', () => {
    const result = createServiceSchema.safeParse({
      name: 'x',
      baseUrl: 'https://example.com',
      headers: [{ name: 'X-Foo', value: 'bar', isSecret: false }],
      tags: [{ key: 'env', value: 'prod' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(
      createServiceSchema.safeParse({ name: 'x', baseUrl: 'https://example.com', extra: 1 })
        .success,
    ).toBe(false);
  });
});
