import { z } from 'zod';

/**
 * Request shapes, validated at the trust boundary by the zod pipe.
 *
 * Passwords are bounded above as well as below: Argon2's cost is a function of
 * its parameters, not the input, but hashing a megabyte-long password still
 * reads and copies a megabyte per attempt, which is free work for an attacker
 * to demand.
 */
const MAX_PASSWORD_LENGTH = 256;

export const emailField = z
  .email({ message: 'must be a valid email address' })
  .max(254, { message: 'must be at most 254 characters' });

/**
 * Shape and hard bounds only.
 *
 * The *configured* minimum length is enforced in AuthService, not here: a
 * parameter decorator is evaluated when the class is defined, so a schema built
 * at that point cannot read configuration without reintroducing the
 * module-level singleton that was removed in M0. Policy belongs with the
 * service that can be injected with it.
 */
export const passwordField = z
  .string()
  .min(1)
  .max(MAX_PASSWORD_LENGTH, {
    message: `must be at most ${String(MAX_PASSWORD_LENGTH)} characters`,
  });

export const registerSchema = z
  .object({
    email: emailField,
    password: passwordField,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailField,
    // Not bounded below: a login must not reveal the password policy, and a
    // short password is simply wrong rather than malformed.
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    newPassword: passwordField,
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
