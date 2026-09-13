import type { ReadableStreamDefaultReader } from 'node:stream/web';

/**
 * Reads a `Response` body as text, refusing to buffer past `maxBytes`.
 *
 * `response.json()` and `response.text()` buffer the whole body before
 * returning, with no limit. A provider or an intermediary between us and it
 * can answer with an unexpectedly large or indefinitely streamed 200, and
 * concurrent sign-ins reading it unbounded exhaust the process heap instead of
 * ending in a bounded provider failure. Reading the stream ourselves, chunk by
 * chunk, lets us cancel the moment the limit is crossed rather than after the
 * fact.
 */
export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel(new Error('response body exceeded the configured byte limit'));
      throw new Error(`response body exceeded ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}
