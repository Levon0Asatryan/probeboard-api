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

  it.each(['ESERVFAIL', 'EREFUSED', 'ETIMEOUT', 'EBADRESP', 'ENOTIMP', 'EFORMERR'])(
    'maps the resolver reporting its own failure (%s) to DNS_FAILURE',
    (code) => {
      // #72 defect 1: these are c-ares' documented answers, and the only
      // ones a real resolver raises here. Mapping EAI_AGAIN alone -- a
      // getaddrinfo code c-ares never produces -- stored every one of them
      // as UNKNOWN_ERROR.
      expect(classifyGuardRejection(unresolvable({ code }))).toEqual({
        failureClass: 'DNS_FAILURE',
        code,
      });
    },
  );

  it('reads c-ares ECONNREFUSED as the resolver refusing, not the endpoint', () => {
    // The same spelling means "host up, nothing listening" on the transport
    // path. Here it is "could not contact DNS servers".
    expect(classifyGuardRejection(unresolvable({ code: 'ECONNREFUSED' }))).toEqual({
      failureClass: 'DNS_FAILURE',
      code: 'ECONNREFUSED',
    });
  });

  it('keeps a code the resolver does not document rather than coercing it', () => {
    // Architecture §7.4: never silently coerced. `SERVFAIL` without the E is
    // not a Node code, and ECANCELLED is our own cancellation, not an answer.
    for (const code of ['SERVFAIL', 'ECANCELLED', 'EBADNAME', 'ESOMETHINGNEW']) {
      expect(classifyGuardRejection(unresolvable({ code }))).toEqual({
        failureClass: 'UNKNOWN_ERROR',
        code,
      });
    }
  });

  it('does not pass off an unreadable cause as a clean negative', () => {
    // A cause exists, so something failed -- we just cannot say what. Calling
    // that DNS_NXDOMAIN would invent a diagnosis, which is the same coercion
    // §7.4 forbids, only with a more plausible-looking answer.
    expect(classifyGuardRejection(unresolvable('a string, not an error'))).toEqual({
      failureClass: 'UNKNOWN_ERROR',
      code: 'URL_UNRESOLVABLE',
    });
    expect(classifyGuardRejection(unresolvable({ noCode: true }))).toEqual({
      failureClass: 'UNKNOWN_ERROR',
      code: 'URL_UNRESOLVABLE',
    });
    expect(classifyGuardRejection(unresolvable({ code: 42 }))).toEqual({
      failureClass: 'UNKNOWN_ERROR',
      code: 'URL_UNRESOLVABLE',
    });
  });

  it('reserves DNS_NXDOMAIN for a genuinely absent cause', () => {
    // The clean-negative branch: both families came back empty and nothing
    // was attached, so the name really has no usable record.
    expect(classifyGuardRejection(unresolvable())).toEqual({
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
