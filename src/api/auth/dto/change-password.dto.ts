import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, passwordField } from './fields.js';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    newPassword: passwordField,
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
