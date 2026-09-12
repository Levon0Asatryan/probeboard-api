import { z } from 'zod';

/**
 * Bounds shared by every request carrying a password.
 *
 * Passwords are bounded above as well as below: Argon2's cost is a function of
 * its parameters rather than its input, but hashing a megabyte-long password
 * still reads and copies a megabyte per attempt, which is free work for an
 * attacker to demand.
 *
 * The *configured* minimum length is enforced in AuthService, not here. A
 * parameter decorator is evaluated when the class is defined, so a schema built
 * at that point cannot read injected configuration without reintroducing the
 * module-level config singleton removed in M0.
 */
export const MAX_PASSWORD_LENGTH = 256;

export const passwordField = z
  .string()
  .min(1)
  .max(MAX_PASSWORD_LENGTH, {
    message: `must be at most ${String(MAX_PASSWORD_LENGTH)} characters`,
  });

export const emailField = z
  .email({ message: 'must be a valid email address' })
  .max(254, { message: 'must be at most 254 characters' });
