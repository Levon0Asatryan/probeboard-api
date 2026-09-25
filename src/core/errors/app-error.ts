/**
 * Domain errors carry a stable machine-readable code, so a client can branch
 * on the failure without parsing prose and without the message becoming an
 * accidental API contract.
 *
 * Lives in core because the worker raises these too -- a probe refused by the
 * SSRF guard and a monitor quota exceeded are the same kind of thing.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    // 404 rather than 403 for a resource owned by someone else: telling an
    // attacker that an id exists but is not theirs is itself a disclosure.
    super('NOT_FOUND', `${what} not found`, 404);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super('VALIDATION_FAILED', 'request failed validation', 400, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

export class QuotaExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super('QUOTA_EXCEEDED', message, 409, details);
  }
}

/**
 * A rate limit refused the request. Carries how long to wait, which the HTTP
 * layer sends as `Retry-After` (RFC 9110 §10.2.3) -- without it a client
 * refused with 429 can only guess, and guessing short burns the next attempt
 * too (#72).
 */
export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 'too many attempts, try again later', 429);
  }
}
