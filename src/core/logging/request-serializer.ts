import type { IncomingMessage } from 'node:http';
import { stdSerializers } from 'pino-http';

/**
 * Drops the query string from every logged request, keeping the path.
 *
 * A field-redaction list is not enough here: pino-http's default request
 * serializer logs the whole `url` -- Express's `originalUrl`, querystring and
 * all -- plus a separate `query` object carrying the same data again. Neither
 * is a field named `code`, so `REDACT_PATHS` never sees them, and the OAuth
 * callback's authorization code would otherwise reach the log twice on every
 * ordinary request: `GET /v1/auth/oauth/google/callback?code=...&state=...`.
 *
 * Confirmed against a live log line from the M1 verification run before this
 * existed: `"req":{...,"url":"/readyz","query":{},...}` -- the shape this
 * strips down to `{ url: "/v1/auth/oauth/google/callback" }`, no `query` key
 * at all.
 */
export function requestSerializer(req: IncomingMessage): Record<string, unknown> {
  const serialized = stdSerializers.req(req) as unknown as Record<string, unknown>;
  const { query: _query, ...rest } = serialized;
  const url = typeof rest.url === 'string' ? rest.url.split('?')[0] : rest.url;
  return { ...rest, url };
}

/**
 * The same treatment for callers that only have the raw URL string, not a
 * whole request to serialize -- `ErrorFilter` logs `path: req.url` on every
 * failure, which is the same leak on the failure path rather than the success
 * one.
 */
export function requestUrlPath(url: string): string {
  return url.split('?')[0];
}
