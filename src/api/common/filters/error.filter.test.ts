import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppError, NotFoundError } from '../../../core/errors/app-error.js';
import { ErrorFilter } from './error.filter.js';

function host(method = 'POST', url = '/v1/monitors') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });

  const args = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method, url }),
    }),
  } as unknown as ArgumentsHost;

  return { args, status, json };
}

function filter() {
  const logger = { error: vi.fn(), warn: vi.fn() };
  return { f: new ErrorFilter(logger as never), logger };
}

describe('ErrorFilter', () => {
  it('sends the mapped status and body', () => {
    const { f } = filter();
    const { args, status, json } = host();

    f.catch(new NotFoundError('monitor'), args);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ code: 'NOT_FOUND', message: 'monitor not found' });
  });

  it('logs a caller mistake at warn, not error', () => {
    // A 404 is not an incident. Logging it at error trains the reader to
    // ignore errors.
    const { f, logger } = filter();
    f.catch(new NotFoundError('monitor'), host().args);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]?.[1]).toBe('request rejected');
  });

  it('logs our own fault at error', () => {
    const { f, logger } = filter();
    f.catch(new Error('column does not exist'), host().args);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error.mock.calls[0]?.[1]).toBe('request failed');
  });

  it('records the route so a failure can be located', () => {
    const { f, logger } = filter();
    f.catch(
      new AppError('QUOTA_EXCEEDED', 'too many monitors', 409),
      host('POST', '/v1/monitors').args,
    );

    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      status: 409,
      code: 'QUOTA_EXCEEDED',
      method: 'POST',
      path: '/v1/monitors',
    });
  });

  it('never puts internal detail in the response', () => {
    const { f, logger } = filter();
    const { args, json } = host();

    f.catch(new Error('relation "users_secret_tokens" does not exist'), args);

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'an unexpected error occurred',
    });
    expect(JSON.stringify(json.mock.calls[0])).not.toContain('users_secret_tokens');
    // ...but an operator can still find it.
    expect(logger.error.mock.calls[0]?.[0].cause).toContain('users_secret_tokens');
  });

  it('strips the query string from the logged path', () => {
    // D12: an OAuth callback that fails would otherwise write
    // ?code=...&state=... straight into the log via this path field, with a
    // fully configured redaction list -- the code arrives inside req.url,
    // which no field-redaction path matches.
    const { f, logger } = filter();
    f.catch(
      new AppError('OAUTH_STATE_INVALID', 'sign-in failed', 400),
      host('GET', '/v1/auth/oauth/google/callback?code=super-secret-code&state=abc').args,
    );

    const logged = JSON.stringify(logger.warn.mock.calls[0]);
    expect(logged).not.toContain('super-secret-code');
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      path: '/v1/auth/oauth/google/callback',
    });
  });

  it('handles a thrown non-error without failing itself', () => {
    const { f } = filter();
    const { args, status } = host();
    expect(() => {
      f.catch('a bare string', args);
    }).not.toThrow();
    expect(status).toHaveBeenCalledWith(500);
  });
});
