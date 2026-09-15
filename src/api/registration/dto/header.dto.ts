import { z } from 'zod';

/**
 * One header entry in a create/update request (docs/m2-plan.md §5.4).
 *
 * `value` is optional only because a secret "keep" entry omits it entirely --
 * `{name, isSecret: true}` with no `value` key means "leave the existing
 * ciphertext untouched", the only way a client can round-trip a secret
 * header it was never shown the plaintext of. A non-secret header, or a
 * secret being replaced, must carry `value`.
 *
 * Name/value byte-length and per-owner count caps are enforced in
 * `HeaderValidationService`, not here -- they are configured
 * (`MAX_HEADER_NAME_BYTES` etc.), and a parameter decorator's schema is
 * built before config injection runs (the same reason `PASSWORD_MIN_LENGTH`
 * is enforced in `AuthService` rather than `dto/fields.ts`).
 */
export const headerInputSchema = z
  .object({
    name: z.string().min(1),
    value: z.string().optional(),
    isSecret: z.boolean().default(false),
  })
  .strict()
  .refine((h) => h.isSecret || h.value !== undefined, {
    message: 'value is required unless isSecret is true (an existing secret being kept)',
    path: ['value'],
  });

export type HeaderInput = z.infer<typeof headerInputSchema>;

export const headerListSchema = z.array(headerInputSchema);
