import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { loggerOptions } from './index.js';

/**
 * Configuration is an argument now, so these tests no longer mutate
 * process.env or reset a module cache to change it.
 */
function cfg(env: Partial<NodeJS.ProcessEnv> = {}) {
  return loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
    ...env,
  });
}

describe('loggerOptions', () => {
  it('tags every line with the service that produced it', () => {
    expect(loggerOptions('api', cfg()).pinoHttp).toMatchObject({ base: { service: 'api' } });
    expect(loggerOptions('worker', cfg()).pinoHttp).toMatchObject({ base: { service: 'worker' } });
  });

  it('redacts credentials and monitor headers', () => {
    // A monitor's request headers are user-supplied and routinely carry the
    // user's API keys, so `*.headers` must be redacted, not only the incoming
    // request's.
    const opts = loggerOptions('api', cfg()) as {
      pinoHttp: { redact: { paths: string[]; censor: string } };
    };
    const paths = opts.pinoHttp.redact.paths;

    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
      '*.headers',
      // OAuth secrets that arrive as fields, not inside a URL (the code
      // itself is handled by the request serializer instead).
      '*.codeVerifier',
      '*.accessToken',
      '*.idToken',
      '*.clientSecret',
    ]) {
      expect(paths).toContain(path);
    }
    expect(opts.pinoHttp.redact.censor).toBe('[redacted]');
  });

  it('serializes requests through the query-stripping serializer', () => {
    const opts = loggerOptions('api', cfg()) as {
      pinoHttp: { serializers?: { req?: unknown } };
    };
    expect(opts.pinoHttp.serializers?.req).toBeTypeOf('function');
  });

  it('pretty-prints only in development, so production logs stay parseable', () => {
    const dev = loggerOptions('api', cfg({ NODE_ENV: 'development' })) as {
      pinoHttp: { transport?: unknown };
    };
    expect(dev.pinoHttp.transport).toBeDefined();

    const prod = loggerOptions('api', cfg({ NODE_ENV: 'production' })) as {
      pinoHttp: { transport?: unknown };
    };
    expect(prod.pinoHttp.transport).toBeUndefined();
  });

  it('honours the configured level', () => {
    const opts = loggerOptions('api', cfg({ LOG_LEVEL: 'warn' })) as {
      pinoHttp: { level: string };
    };
    expect(opts.pinoHttp.level).toBe('warn');
  });

  it('is a pure function of its arguments', () => {
    // No module cache to reset, no process.env to mutate.
    const a = loggerOptions('api', cfg({ LOG_LEVEL: 'debug' })) as { pinoHttp: { level: string } };
    const b = loggerOptions('api', cfg({ LOG_LEVEL: 'error' })) as { pinoHttp: { level: string } };
    expect(a.pinoHttp.level).toBe('debug');
    expect(b.pinoHttp.level).toBe('error');
  });
});
