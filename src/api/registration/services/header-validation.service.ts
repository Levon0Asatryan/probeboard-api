import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { HeaderInput } from '../dto/header.dto.js';

export class HeaderNotAllowedError extends AppError {
  constructor(name: string) {
    super('HEADER_NOT_ALLOWED', `header "${name}" is not allowed`, 400);
  }
}

export class HeaderInvalidError extends AppError {
  constructor(name: string, reason: string) {
    super('HEADER_INVALID', `header "${name}" is invalid: ${reason}`, 400);
  }
}

/**
 * Headers whose only effect is smuggling or overriding transport-level
 * behavior the probe executor (M3) controls itself -- NFR-15
 * (docs/m2-plan.md §5.2). Case-insensitive, matching HTTP's own header-name
 * comparison rule.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'expect',
  'te',
  'trailer',
]);

/**
 * RFC 7230 §3.2.6 `token`: what Node's own outbound HTTP client accepts as a
 * header name (`http.validateHeaderName`, internally the same grammar).
 * CR/LF alone is not enough to reject -- a name with a space or a non-ASCII
 * character is not smuggling, but Node throws `ERR_INVALID_HTTP_TOKEN` when
 * M3 actually tries to send it, so a monitor that passed validation here
 * would fail every probe before a request ever reached the endpoint.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * RFC 7230 §3.2 `field-value`: HTAB, SP, VCHAR (0x21-0x7E), or obs-text
 * (0x80-0xFF) only -- a positive allow-list, not a control-character
 * deny-list, because Node's outbound client accepts obs-text strictly
 * through U+00FF and throws `ERR_INVALID_CHAR` above it: a deny-list of
 * control characters alone would still let a value with e.g. an emoji or
 * a CJK character (both far above U+00FF) through validation only to fail
 * every probe once M3 tries to send it.
 */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Validates a full header list against static and configured rules, at
 * save time -- create and update alike (D10). Independent of the SSRF
 * guard: headers are not URLs, but run at the same moment.
 */
@Injectable()
export class HeaderValidationService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  validate(headers: HeaderInput[]): void {
    if (headers.length > this.cfg.MAX_HEADERS_PER_OWNER) {
      throw new AppError(
        'HEADER_INVALID',
        `at most ${String(this.cfg.MAX_HEADERS_PER_OWNER)} headers are allowed`,
        400,
        { limit: this.cfg.MAX_HEADERS_PER_OWNER, count: headers.length },
      );
    }

    const seen = new Set<string>();
    for (const header of headers) {
      const lower = header.name.toLowerCase();

      if (FORBIDDEN_HEADER_NAMES.has(lower)) {
        throw new HeaderNotAllowedError(header.name);
      }
      if (seen.has(lower)) {
        throw new HeaderInvalidError(header.name, 'duplicate header name (case-insensitive)');
      }
      seen.add(lower);

      if (!HEADER_NAME.test(header.name)) {
        throw new HeaderInvalidError(header.name, 'name must be a valid HTTP header token');
      }
      if (Buffer.byteLength(header.name, 'utf8') > this.cfg.MAX_HEADER_NAME_BYTES) {
        throw new HeaderInvalidError(
          header.name,
          `name must be at most ${String(this.cfg.MAX_HEADER_NAME_BYTES)} bytes`,
        );
      }

      // The "keep" case (secret, no value) has nothing to check here -- the
      // ciphertext it keeps was already validated when it was written.
      if (header.value === undefined) continue;

      if (!HEADER_VALUE.test(header.value)) {
        throw new HeaderInvalidError(
          header.name,
          'value contains a disallowed or non-Latin-1 character',
        );
      }
      if (Buffer.byteLength(header.value, 'utf8') > this.cfg.MAX_HEADER_VALUE_BYTES) {
        throw new HeaderInvalidError(
          header.name,
          `value must be at most ${String(this.cfg.MAX_HEADER_VALUE_BYTES)} bytes`,
        );
      }
    }
  }
}
