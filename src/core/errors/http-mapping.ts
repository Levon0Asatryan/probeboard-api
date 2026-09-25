import { AppError, RateLimitedError } from './app-error.js';
import { isDatabaseUnavailable } from './database-unavailable.js';
import { describeError } from './describe.js';

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}

export interface MappedError {
  status: number;
  body: ErrorResponse;
  /** Detail for the log only. Never sent to the client. */
  logDetail: string;
  /** 5xx means we broke; 4xx means the caller did. Only the former is our bug. */
  isServerFault: boolean;
  /** Response headers the status needs, e.g. `Retry-After` on a 429. */
  headers?: Record<string, string>;
}

/** Messages for statuses raised by the framework rather than by our code. */
const STATUS_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'request could not be understood' },
  401: { code: 'UNAUTHENTICATED', message: 'authentication required' },
  403: { code: 'FORBIDDEN', message: 'not permitted' },
  404: { code: 'NOT_FOUND', message: 'resource not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' },
  409: { code: 'CONFLICT', message: 'request conflicts with current state' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'request body is too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'unsupported content type' },
  429: { code: 'RATE_LIMITED', message: 'too many requests' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'service is not available' },
};

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
  );
}

interface HttpErrorLike {
  status: number;
  response: unknown;
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return (
    typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
  );
}

/**
 * Maps any thrown value to what the client sees and what the log records.
 *
 * Pure, so every branch is testable without a running HTTP server. The filter
 * that uses it is a thin adapter.
 */
export function toErrorResponse(err: unknown): MappedError {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      logDetail: describeError(err),
      isServerFault: err.status >= 500,
      ...(err instanceof RateLimitedError
        ? { headers: { 'Retry-After': String(err.retryAfterSeconds) } }
        : {}),
    };
  }

  if (isHttpErrorLike(err)) {
    const { status, response } = err;

    // A handler that already produced {code, message} is passed through.
    if (isErrorResponse(response)) {
      return {
        status,
        body: response,
        logDetail: describeError(err),
        isServerFault: status >= 500,
      };
    }

    const known = STATUS_CODES[status];
    return {
      status,
      body: known ?? { code: 'ERROR', message: 'request failed' },
      logDetail: describeError(err),
      isServerFault: status >= 500,
    };
  }

  // The database being down is an outage, not a bug: 503, the same body
  // /readyz answers with, so a client knows to retry (#72, D3).
  if (isDatabaseUnavailable(err)) {
    return {
      status: 503,
      body: { code: 'DATABASE_UNAVAILABLE', message: 'database is not reachable' },
      logDetail: describeError(err),
      isServerFault: true,
    };
  }

  // Anything else is a bug in this service. The client learns nothing beyond
  // that it failed; the cause goes to the log.
  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: 'an unexpected error occurred' },
    logDetail: describeError(err),
    isServerFault: true,
  };
}
