import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config/schema.js';
import { requestSerializer } from './request-serializer.js';
import { REDACT_CENSOR, REDACT_PATHS } from './redaction.js';

export { REDACT_CENSOR, REDACT_PATHS } from './redaction.js';
export { requestUrlPath } from './request-serializer.js';

export type ServiceName = 'api' | 'worker';

/**
 * Structured logging. The message is a static string and variable data goes in
 * fields, so logs stay greppable and aggregatable.
 *
 * Configuration is passed in rather than read from a singleton, which keeps
 * this a pure function of its inputs.
 */
export function loggerOptions(service: ServiceName, cfg: AppConfig): Params {
  const pretty = cfg.NODE_ENV === 'development';

  return {
    pinoHttp: {
      level: cfg.LOG_LEVEL,
      base: { service },
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
      // The default request serializer logs the full url, querystring
      // included, plus a duplicate `query` object -- neither is a field a
      // redaction list can match, so the OAuth callback's authorization code
      // would otherwise reach every ordinary request log line.
      serializers: { req: requestSerializer },
      // Pretty output is for a human reading a terminal. Production logs stay
      // machine-parseable.
      transport: pretty ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  };
}
