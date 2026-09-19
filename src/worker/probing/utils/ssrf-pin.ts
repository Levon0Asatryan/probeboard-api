/**
 * Turns an SSRF guard rejection into a failure class.
 *
 * `core/ssrf` exists to answer a save-time question — "may this URL be
 * stored?" — so its errors are shaped for an HTTP 400 body. The probe
 * executor asks the same guard a different question at connect time, and has
 * to report the answer in the failure taxonomy instead (docs/m3-plan.md D14).
 *
 * The translation is not one-to-one, and that is the whole point. An earlier
 * draft mapped every `SsrfValidationError` to `BLOCKED_BY_POLICY`, including
 * `URL_UNRESOLVABLE` — which is thrown for a genuine DNS failure, not a
 * policy decision. That would have made `DNS_NXDOMAIN` and `DNS_FAILURE`
 * unreachable through the real resolve path, and told M6 to treat a real
 * outage as `UNKNOWN` rather than `DOWN`: probeboard reporting "we declined
 * to check" when the truth was "their name server is broken".
 */
import { SsrfValidationError } from '../../../core/ssrf/host-validator.js';
import type { Classification } from './failure-classes.js';

/**
 * What `core/ssrf` attached, if anything.
 *
 * Three states, not two — collapsing the last two is a real misreport:
 *
 * - `absent`: no cause at all. Both address families came back cleanly
 *   empty, so the name genuinely has no usable record.
 * - `{ code }`: the resolver failed and said why.
 * - `unreadable`: a cause exists but carries no own string `code` — a plain
 *   `Error` from an unexpected resolver failure, say. Something went wrong
 *   and we do not know what, which is not the same as knowing the name does
 *   not resolve.
 */
type Cause = { kind: 'absent' } | { kind: 'code'; code: string } | { kind: 'unreadable' };

function causeOf(error: SsrfValidationError): Cause {
  const cause: unknown = error.cause;
  if (cause === undefined || cause === null) return { kind: 'absent' };
  if (typeof cause !== 'object') return { kind: 'unreadable' };
  if (!Object.hasOwn(cause, 'code')) return { kind: 'unreadable' };
  const code = (cause as { code: unknown }).code;
  return typeof code === 'string' ? { kind: 'code', code } : { kind: 'unreadable' };
}

/**
 * Classifies a rejection from `assertSaveableUrl`.
 *
 * `URL_UNRESOLVABLE` is the interesting one: `core/ssrf` throws it from two
 * different branches, and only the `cause` distinguishes them.
 *
 * - No `cause` — both address families came back cleanly empty, so the name
 *   exists as far as the resolver is concerned but has no usable record.
 *   `DNS_NXDOMAIN` is the closest class. `resolveAll` does not preserve
 *   whether the per-family code was `ENOTFOUND` or `ENODATA`, which is a
 *   small information loss inside `core/ssrf` worth naming rather than
 *   silently working around (§9).
 * - A `cause` — the resolver itself failed. `EAI_AGAIN` is the taxonomy's
 *   `DNS_FAILURE` signal; anything else (`SERVFAIL`, a timeout, `EREFUSED`)
 *   is reported as `UNKNOWN_ERROR` with the raw code retained, because
 *   architecture §7.4 forbids coercing an unrecognised signal into a
 *   plausible-looking class.
 */
export function classifyGuardRejection(error: SsrfValidationError): Classification {
  switch (error.code) {
    case 'SCHEME_NOT_ALLOWED':
    case 'CREDENTIALS_IN_URL':
    case 'PORT_NOT_ALLOWED':
    case 'ADDRESS_NOT_ALLOWED':
      // probeboard refused, per NFR-11. Excluded from uptime arithmetic by
      // the caller: it is not the endpoint's outage.
      return { failureClass: 'BLOCKED_BY_POLICY', code: error.code };

    case 'URL_UNRESOLVABLE': {
      const cause = causeOf(error);
      // Only a genuinely absent cause is a clean negative. A cause we cannot
      // read means the resolver failed in a way nobody anticipated, and
      // reporting that as "the name does not exist" would be inventing a
      // diagnosis -- the same coercion architecture §7.4 forbids, just with a
      // more plausible-looking answer.
      if (cause.kind === 'absent') return { failureClass: 'DNS_NXDOMAIN', code: error.code };
      if (cause.kind === 'unreadable') return { failureClass: 'UNKNOWN_ERROR', code: error.code };
      if (cause.code === 'EAI_AGAIN') return { failureClass: 'DNS_FAILURE', code: cause.code };
      return { failureClass: 'UNKNOWN_ERROR', code: cause.code };
    }

    default:
      // `SsrfRejectionCode` is a closed union, so this is unreachable today.
      // It stays as an honest fallback rather than a cast: a code added to
      // `core/ssrf` later must not silently acquire a wrong class here.
      return { failureClass: 'UNKNOWN_ERROR', code: error.code };
  }
}

/** Whether a thrown value came from the SSRF guard at all. */
export function isGuardRejection(error: unknown): error is SsrfValidationError {
  return error instanceof SsrfValidationError;
}
