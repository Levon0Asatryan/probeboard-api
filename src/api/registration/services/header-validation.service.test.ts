import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import {
  HeaderInvalidError,
  HeaderNotAllowedError,
  HeaderValidationService,
} from './header-validation.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  MAX_HEADERS_PER_OWNER: '3',
  MAX_HEADER_NAME_BYTES: '16',
  MAX_HEADER_VALUE_BYTES: '16',
});

const service = new HeaderValidationService(cfg);

const plain = (name: string, value: string) => ({ name, value, isSecret: false });

describe('HeaderValidationService', () => {
  it('accepts a well-formed header list', () => {
    expect(() => service.validate([plain('X-Foo', 'bar')])).not.toThrow();
  });

  it('rejects a forbidden header name, case-insensitively (NFR-15)', () => {
    for (const name of ['Host', 'host', 'CONTENT-LENGTH', 'Transfer-Encoding', 'Connection']) {
      expect(() => service.validate([plain(name, 'x')])).toThrow(HeaderNotAllowedError);
    }
  });

  it('allows a name that merely contains a forbidden word as a substring', () => {
    // "X-Host-Override" is not "Host" -- exact match only, not a substring ban.
    expect(() => service.validate([plain('X-Host-Override', 'x')])).not.toThrow();
  });

  it('rejects CR or LF in the name', () => {
    expect(() => service.validate([plain('X-Foo\r\nX-Injected', 'x')])).toThrow(HeaderInvalidError);
  });

  it('rejects CR or LF in the value', () => {
    expect(() => service.validate([plain('X-Foo', 'bar\r\nX-Injected: evil')])).toThrow(
      HeaderInvalidError,
    );
  });

  it('does not check the value of a secret "keep" entry (no value present)', () => {
    expect(() => service.validate([{ name: 'X-Api-Key', isSecret: true }])).not.toThrow();
  });

  it('rejects a name over the configured byte cap', () => {
    expect(() => service.validate([plain('X'.repeat(17), 'x')])).toThrow(HeaderInvalidError);
  });

  it('rejects a value over the configured byte cap', () => {
    expect(() => service.validate([plain('X-Foo', 'x'.repeat(17))])).toThrow(HeaderInvalidError);
  });

  it('rejects a duplicate header name, case-insensitively', () => {
    expect(() => service.validate([plain('X-Foo', 'a'), plain('x-foo', 'b')])).toThrow(
      HeaderInvalidError,
    );
  });

  it('rejects more headers than the configured per-owner cap', () => {
    expect(() =>
      service.validate([
        plain('X-A', 'a'),
        plain('X-B', 'b'),
        plain('X-C', 'c'),
        plain('X-D', 'd'),
      ]),
    ).toThrow(/at most 3 headers/);
  });

  it('accepts exactly the cap', () => {
    expect(() =>
      service.validate([plain('X-A', 'a'), plain('X-B', 'b'), plain('X-C', 'c')]),
    ).not.toThrow();
  });
});
