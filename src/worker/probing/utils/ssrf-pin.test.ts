import { describe, expect, it } from 'vitest';
import { SsrfValidationError } from '../../../core/ssrf/host-validator.js';
import { classifyGuardRejection, isGuardRejection } from './ssrf-pin.js';

function unresolvable(cause?: unknown): SsrfValidationError {
  const error = new SsrfValidationError('URL_UNRESOLVABLE', 'the hostname does not resolve');
  if (cause !== undefined) error.cause = cause;
  return error;
}

describe('classifyGuardRejection', () => {
  it.each([
    'SCHEME_NOT_ALLOWED',
    'CREDENTIALS_IN_URL',
    'PORT_NOT_ALLOWED',
    'ADDRESS_NOT_ALLOWED',
  ] as const)('maps %s to BLOCKED_BY_POLICY', (code) => {
    const result = classifyGuardRejection(new SsrfValidationError(code, 'nope'));
    expect(result).toEqual({ failureClass: 'BLOCKED_BY_POLICY', code });
  });

  it('maps a cleanly-empty resolve to DNS_NXDOMAIN, not BLOCKED_BY_POLICY', () => {
    // The distinction that matters: an earlier draft called this a policy
    // refusal, which would have told M6 to record UNKNOWN for what is really
    // the endpoint's own DNS being wrong.
    expect(classifyGuardRejection(unresolvable())).toEqual({
      failureClass: 'DNS_NXDOMAIN',
      code: 'URL_UNRESOLVABLE',
    });
  });

  it('maps a resolver EAI_AGAIN to DNS_FAILURE', () => {
    const result = classifyGuardRejection(unresolvable({ code: 'EAI_AGAIN' }));
    expect(result).toEqual({ failureClass: 'DNS_FAILURE', code: 'EAI_AGAIN' });
  });

  it('keeps an unrecognised resolver code rather than coercing it', () => {
    // Architecture §7.4: never silently coerced. SERVFAIL is not EAI_AGAIN
    // and pretending otherwise would send an operator to the wrong system.
    for (const code of ['SERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED']) {
      expect(classifyGuardRejection(unresolvable({ code }))).toEqual({
        failureClass: 'UNKNOWN_ERROR',
        code,
      });
    }
  });

  it('treats a cause without a usable code as a clean negative', () => {
    expect(classifyGuardRejection(unresolvable('a string, not an error'))).toEqual({
      failureClass: 'DNS_NXDOMAIN',
      code: 'URL_UNRESOLVABLE',
    });
    expect(classifyGuardRejection(unresolvable({ noCode: true }))).toEqual({
      failureClass: 'DNS_NXDOMAIN',
      code: 'URL_UNRESOLVABLE',
    });
  });

  it('never returns BLOCKED_BY_POLICY for any URL_UNRESOLVABLE shape', () => {
    // The regression this mapping exists to prevent, stated once directly.
    const shapes = [
      unresolvable(),
      unresolvable({ code: 'EAI_AGAIN' }),
      unresolvable({ code: 'SERVFAIL' }),
    ];
    for (const error of shapes) {
      expect(classifyGuardRejection(error).failureClass).not.toBe('BLOCKED_BY_POLICY');
    }
  });
});

describe('isGuardRejection', () => {
  it('recognises a guard rejection', () => {
    expect(isGuardRejection(new SsrfValidationError('PORT_NOT_ALLOWED', 'nope'))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isGuardRejection(new Error('transport'))).toBe(false);
    expect(isGuardRejection(null)).toBe(false);
    expect(isGuardRejection({ code: 'PORT_NOT_ALLOWED' })).toBe(false);
  });
});
