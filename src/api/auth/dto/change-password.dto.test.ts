import { describe, expect, it } from 'vitest';
import { changePasswordSchema } from './change-password.dto.js';

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
