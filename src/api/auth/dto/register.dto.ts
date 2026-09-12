import { z } from 'zod';
import { emailField, passwordField } from './fields.js';

export const registerSchema = z
  .object({
    email: emailField,
    password: passwordField,
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerSchema>;
