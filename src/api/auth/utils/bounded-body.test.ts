import { describe, expect, it } from 'vitest';
import { readBodyWithLimit } from './bounded-body.js';

function streamed(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

describe('readBodyWithLimit', () => {
  it('returns the body when it is within the limit', async () => {
    await expect(readBodyWithLimit(streamed(['hello', ' world']), 100)).resolves.toBe(
      'hello world',
    );
  });

  it('refuses a body that exceeds the limit, without buffering it fully', async () => {
    // Sent across several chunks so the cap must be checked as bytes arrive,
    // not only once the whole body has already been read.
    const chunks = Array<string>(10).fill('x'.repeat(10));
    await expect(readBodyWithLimit(streamed(chunks), 50)).rejects.toThrow(/exceeded/);
  });

  it('cancels the stream once the limit is crossed', async () => {
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    await expect(readBodyWithLimit(new Response(stream), 10)).rejects.toThrow();
    expect(cancelled).toBeInstanceOf(Error);
  });

  it('returns an empty string for a response with no body', async () => {
    await expect(readBodyWithLimit(new Response(null), 10)).resolves.toBe('');
  });
});
