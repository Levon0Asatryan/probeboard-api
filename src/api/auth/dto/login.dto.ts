import { z } from 'zod';
import { emailField, MAX_PASSWORD_LENGTH } from './fields.js';

export const loginSchema = z
  .object({
    email: emailField,
    // Not bounded below: a login must not reveal the password policy, and must
    // not answer differently for an address that exists.
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginSchema>;
