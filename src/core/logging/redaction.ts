/**
 * Paths pino replaces before a line is written.
 *
 * `*.headers` is the one that matters most and the one easiest to omit: a
 * monitor's request headers are supplied by the user and routinely carry their
 * API keys, so they must never be logged -- not only the headers of incoming
 * requests to this service.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.headers',
  // OAuth secrets that arrive as fields rather than in a URL -- the code
  // itself is covered by the request serializer and ErrorFilter instead,
  // since it arrives inside req.url, which no field-redaction path matches.
  '*.code',
  '*.codeVerifier',
  '*.code_verifier',
  '*.accessToken',
  '*.access_token',
  '*.idToken',
  '*.id_token',
  '*.clientSecret',
  '*.client_secret',
] as const;

export const REDACT_CENSOR = '[redacted]';
