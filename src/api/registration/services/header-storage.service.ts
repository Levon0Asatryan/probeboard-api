import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { AppError } from '../../../core/errors/app-error.js';
import { encryptSecret, parseHeaderEncryptionKey } from '../../../core/crypto/header-cipher.js';
import type { Header } from '../../../core/db/types.js';
import { mergeHeaderRows } from '../../../core/registration/header-merge.js';
import type { NewOwnedHeader } from '../../../core/registration/repositories/header.repository.js';
import type { HeaderInput } from '../dto/header.dto.js';

export class HeaderKeepWithoutExistingError extends AppError {
  constructor(name: string) {
    super(
      'HEADER_INVALID',
      `header "${name}" has no existing secret to keep -- provide a value`,
      400,
    );
  }
}

/** `{name, isSecret, value?}` -- never a `value` for a secret header (docs/m2-plan.md §5.4). */
export interface HeaderDto {
  name: string;
  isSecret: boolean;
  value?: string;
}

/**
 * Encrypts/serializes headers at the write-only boundary (docs/m2-plan.md
 * §5.4). The only place a secret header's plaintext exists outside a
 * request body: an encrypted row in, a redacted DTO out.
 */
@Injectable()
export class HeaderStorageService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private get key(): Buffer {
    return parseHeaderEncryptionKey(this.cfg.HEADER_ENCRYPTION_KEY);
  }

  /**
   * Turns a validated `HeaderInput[]` into storage rows, resolving each
   * secret entry's keep/replace semantics against `existing` (the owner's
   * current header rows, case-insensitively matched by name).
   */
  toStorageRows(inputs: HeaderInput[], existing: Header[]): NewOwnedHeader[] {
    const existingByName = new Map(existing.map((h) => [h.name.toLowerCase(), h]));

    return inputs.map((input) => {
      const lower = input.name.toLowerCase();

      if (!input.isSecret) {
        return {
          name: input.name,
          is_secret: false,
          value: input.value ?? '',
          secret_ciphertext: null,
          secret_iv: null,
          secret_auth_tag: null,
        };
      }

      if (input.value !== undefined) {
        const encrypted = encryptSecret(input.value, this.key);
        return {
          name: input.name,
          is_secret: true,
          value: null,
          secret_ciphertext: encrypted.ciphertext,
          secret_iv: encrypted.iv,
          secret_auth_tag: encrypted.authTag,
        };
      }

      // Keep: reuse the existing ciphertext verbatim -- never decrypt and
      // re-encrypt, which would need the plaintext to pass through this
      // process for no reason and would mint a new IV for no change.
      const current = existingByName.get(lower);
      if (!current?.is_secret) {
        throw new HeaderKeepWithoutExistingError(input.name);
      }
      return {
        name: input.name,
        is_secret: true,
        value: null,
        secret_ciphertext: current.secret_ciphertext,
        secret_iv: current.secret_iv,
        secret_auth_tag: current.secret_auth_tag,
      };
    });
  }
}

/** `{name, isSecret: true}` for a secret row, `{name, isSecret: false, value}` otherwise. Never a value for a secret. */
export function toHeaderDto(header: Header): HeaderDto {
  return header.is_secret
    ? { name: header.name, isSecret: true }
    : { name: header.name, isSecret: false, value: header.value ?? '' };
}

/** DTO wrapper over `mergeHeaderRows` (core) -- the redacted view an HTTP response needs. */
export function mergeHeaders(serviceHeaders: Header[], endpointHeaders: Header[]): HeaderDto[] {
  return mergeHeaderRows(serviceHeaders, endpointHeaders).map(toHeaderDto);
}
