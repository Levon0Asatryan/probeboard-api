import { describe, expect, it } from 'vitest';
import { loginSchema } from './login.dto.js';

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
