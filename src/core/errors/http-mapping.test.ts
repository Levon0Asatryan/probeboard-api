import { describe, expect, it } from 'vitest';
import { AppError, NotFoundError, QuotaExceededError, ValidationError } from './app-error.js';
import { toErrorResponse } from './http-mapping.js';

describe('toErrorResponse', () => {
  it('passes an AppError through with its code and status', () => {
    const m = toErrorResponse(new AppError('MONITOR_PAUSED', 'monitor is paused', 409));
    expect(m.status).toBe(409);
    expect(m.body).toEqual({ code: 'MONITOR_PAUSED', message: 'monitor is paused' });
    expect(m.isServerFault).toBe(false);
  });

  it('includes details only when there are any', () => {
    expect(toErrorResponse(new ValidationError([{ path: 'url' }])).body.details).toEqual([
      { path: 'url' },
    ]);
    expect(toErrorResponse(new NotFoundError('monitor')).body).not.toHaveProperty('details');
  });

  it('reports another owner̕s resource as 404, not 403', () => {
    // 403 would confirm the id exists, which is a disclosure in itself.
    const m = toErrorResponse(new NotFoundError('monitor'));
    expect(m.status).toBe(404);
    expect(m.body.code).toBe('NOT_FOUND');
  });

  it('maps framework errors by status', () => {
    expect(toErrorResponse({ status: 401, response: 'Unauthorized' }).body.code).toBe(
      'UNAUTHENTICATED',
    );
    expect(toErrorResponse({ status: 429, response: {} }).body.code).toBe('RATE_LIMITED');
    expect(toErrorResponse({ status: 413, response: {} }).body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 503, not 500, when the database cannot be reached (#72, D3)', () => {
    const down = Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), { code: 'ENOTFOUND' });
    const m = toErrorResponse(down);
    expect(m.status).toBe(503);
    // The same body /readyz answers with.
    expect(m.body).toEqual({ code: 'DATABASE_UNAVAILABLE', message: 'database is not reachable' });
    expect(m.logDetail).toContain('ENOTFOUND');
  });

  it('keeps a query the database rejected a 500', () => {
    const bug = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    expect(toErrorResponse(bug)).toMatchObject({
      status: 500,
      body: { code: 'INTERNAL_ERROR' },
    });
  });

  it('falls back for a status it does not know', () => {
    const m = toErrorResponse({ status: 418, response: 'teapot' });
    expect(m.status).toBe(418);
    expect(m.body).toEqual({ code: 'ERROR', message: 'request failed' });
  });

  it('keeps a response that already carries a code', () => {
    const m = toErrorResponse({
      status: 503,
      response: { code: 'DATABASE_UNAVAILABLE', message: 'database is not reachable' },
    });
    expect(m.body).toEqual({ code: 'DATABASE_UNAVAILABLE', message: 'database is not reachable' });
    expect(m.isServerFault).toBe(true);
  });

  it('never leaks an unexpected error to the client', () => {
    const boom = new Error('column "secret_token" does not exist');
    const m = toErrorResponse(boom);

    expect(m.status).toBe(500);
    expect(m.body).toEqual({ code: 'INTERNAL_ERROR', message: 'an unexpected error occurred' });
    expect(JSON.stringify(m.body)).not.toContain('secret_token');
    // ...but an operator can still find out what happened.
    expect(m.logDetail).toContain('secret_token');
    expect(m.isServerFault).toBe(true);
  });

  it('handles a thrown non-error without failing itself', () => {
    expect(toErrorResponse('just a string').status).toBe(500);
    expect(toErrorResponse(undefined).body.code).toBe('INTERNAL_ERROR');
    expect(toErrorResponse(null).body.code).toBe('INTERNAL_ERROR');
  });

  it('separates our faults from the caller̕s', () => {
    expect(toErrorResponse(new QuotaExceededError('too many monitors')).isServerFault).toBe(false);
    expect(toErrorResponse(new AppError('BROKEN', 'we broke', 500)).isServerFault).toBe(true);
  });
});

describe('ConflictError', () => {
  it('carries its own code at 409', async () => {
    const { ConflictError } = await import('./app-error.js');
    const m = toErrorResponse(new ConflictError('EMAIL_TAKEN', 'email already registered'));
    expect(m.status).toBe(409);
    expect(m.body.code).toBe('EMAIL_TAKEN');
  });
});
