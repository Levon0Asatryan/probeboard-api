import { describe, expect, it } from 'vitest';
import { changePasswordSchema, loginSchema, registerSchema } from '../http/auth.schemas.js';

const register = registerSchema;

describe('registerSchema', () => {
  it('accepts a valid registration', () => {
    expect(
      register.safeParse({ email: 'alice@example.com', password: 'correct horse' }).success,
    ).toBe(true);
  });

  it('rejects a malformed address', () => {
    for (const email of ['', 'alice', 'alice@', '@example.com', 'a b@example.com']) {
      expect(register.safeParse({ email, password: 'correct horse' }).success).toBe(false);
    }
  });

  it('leaves the configured minimum length to the service', () => {
    // A parameter decorator cannot read injected configuration, so the policy
    // lives with the service that can be. The schema only bounds the shape.
    expect(register.safeParse({ email: 'a@example.com', password: 'short' }).success).toBe(true);
    expect(register.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
  });

  it('bounds the password above, so hashing is not free work to demand', () => {
    const huge = 'a'.repeat(257);
    expect(register.safeParse({ email: 'a@example.com', password: huge }).success).toBe(false);
  });

  it('rejects unknown fields rather than ignoring them', () => {
    // An extra field must not reach a handler that might trust it.
    const result = register.safeParse({
      email: 'a@example.com',
      password: 'correct horse',
      isAdmin: true,
    });
    expect(result.success).toBe(false);
  });

  it('reports every bad field, not just the first', () => {
    const result = register.safeParse({ email: 'nope', password: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(['email', 'password']);
  });
});

describe('loginSchema', () => {
  it('accepts any non-empty password', () => {
    // A login must not reveal the password policy by rejecting a short one
    // differently from a wrong one.
    expect(loginSchema.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(true);
  });

  it('still requires an address and a password', () => {
    expect(loginSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: '', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({}).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  const schema = changePasswordSchema;

  it('requires both the current and the new password', () => {
    expect(schema.safeParse({ newPassword: 'correct horse' }).success).toBe(false);
    expect(schema.safeParse({ currentPassword: 'old' }).success).toBe(false);
  });

  it('bounds the new password above', () => {
    expect(schema.safeParse({ currentPassword: 'old', newPassword: 'correct horse' }).success).toBe(
      true,
    );
    expect(schema.safeParse({ currentPassword: 'old', newPassword: 'a'.repeat(257) }).success).toBe(
      false,
    );
  });
});
