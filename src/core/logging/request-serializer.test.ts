import type { IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { requestSerializer, requestUrlPath } from './request-serializer.js';

/**
 * D12: a field-redaction list cannot catch the OAuth authorization code,
 * because it arrives inside `req.url`, not as a field. Proved against a real
 * pino instance, not only the plain function, because pino-http's own default
 * serializer is what actually produces `url` and `query` on every request --
 * a unit test of the function alone would not catch a config that never wired
 * it in.
 */

function fakeRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    originalUrl: url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1', remotePort: 12345 },
  } as unknown as IncomingMessage;
}

function capture(): { lines: () => string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { lines: () => chunks.join('').split('\n').filter(Boolean), stream };
}

describe('requestSerializer', () => {
  it('drops the query string from a plain call', () => {
    const serialized = requestSerializer(
      fakeRequest('/v1/auth/oauth/google/callback?code=secret&state=abc'),
    );
    expect(serialized.url).toBe('/v1/auth/oauth/google/callback');
    expect(serialized).not.toHaveProperty('query');
  });

  it('leaves a query-less url unchanged', () => {
    expect(requestSerializer(fakeRequest('/readyz')).url).toBe('/readyz');
  });

  it('never lets the authorization code reach a logged line', () => {
    const { lines, stream } = capture();
    const logger = pino({ serializers: { req: requestSerializer } }, stream);

    logger.info(
      { req: fakeRequest('/v1/auth/oauth/google/callback?code=super-secret-code&state=abc') },
      'request completed',
    );

    const output = lines().join('\n');
    expect(output).not.toContain('super-secret-code');
    expect(output).toContain('/v1/auth/oauth/google/callback');
  });

  it('fails without the serializer -- the default one logs the code twice over', () => {
    // Confirms the vulnerability the serializer exists to close, on the same
    // pino default this repo actually runs: proof that the guard is load
    // bearing, not merely present.
    const { lines, stream } = capture();
    const logger = pino({}, stream);

    logger.info(
      { req: fakeRequest('/v1/auth/oauth/google/callback?code=super-secret-code&state=abc') },
      'request completed',
    );

    expect(lines().join('\n')).toContain('super-secret-code');
  });
});

describe('requestUrlPath', () => {
  it('drops the query string', () => {
    expect(requestUrlPath('/v1/auth/oauth/google/callback?code=secret&state=abc')).toBe(
      '/v1/auth/oauth/google/callback',
    );
  });

  it('leaves a query-less path unchanged', () => {
    expect(requestUrlPath('/readyz')).toBe('/readyz');
  });
});
