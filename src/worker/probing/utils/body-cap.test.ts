import { describe, expect, it, vi } from 'vitest';
import { readCappedBody } from './body-cap.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A stream that yields exactly the given chunks, in order. */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/**
 * A stream that never ends, recording how many chunks were pulled. The
 * counter is what proves the reader stopped rather than politely ignoring
 * the rest of an already-finished body.
 */
function endlessStream(chunk: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let pulls = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    }),
    pulls: () => pulls,
  };
}

describe('readCappedBody, under the cap', () => {
  it('returns the whole body, decoded, not truncated', async () => {
    const result = await readCappedBody(streamOf([bytes('hello '), bytes('world')]), 64);

    expect(result).toEqual({ text: 'hello world', truncated: false, bytes: 11, peakBytes: 11 });
  });

  it('decodes multi-byte UTF-8 split across chunk boundaries', async () => {
    // The transport splits on byte counts, not codepoints. A per-chunk
    // decode would turn the halves of "é" into two replacement characters.
    const encoded = bytes('héllo wörld');
    const result = await readCappedBody(
      streamOf([encoded.subarray(0, 2), encoded.subarray(2)]),
      64,
    );

    expect(result.text).toBe('héllo wörld');
  });

  it('treats a null body as empty rather than crashing (D18)', async () => {
    // HEAD, 204, 205 and 304 have no body by specification; Node gives
    // `response.body === null`. An unconditional getReader() throws on the
    // most ordinary successful shapes there are.
    expect(await readCappedBody(null, 64)).toEqual({
      text: '',
      truncated: false,
      bytes: 0,
      peakBytes: 0,
    });
    expect(await readCappedBody(undefined, 64)).toEqual({
      text: '',
      truncated: false,
      bytes: 0,
      peakBytes: 0,
    });
  });

  it('handles an empty body', async () => {
    expect(await readCappedBody(streamOf([]), 64)).toMatchObject({ text: '', truncated: false });
  });
});

describe('readCappedBody, at exactly the cap (D30)', () => {
  it('does not mark a body whose length equals the cap as truncated', async () => {
    // The regression this rule exists for: deciding at `>= cap` aborts one
    // read too early, so a complete body is marked truncated, D23/D28's
    // conservative handling then fails assertions the complete body
    // satisfies, and a healthy endpoint is reported down.
    const body = 'x'.repeat(32);

    const result = await readCappedBody(streamOf([bytes(body)]), 32);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(body);
    expect(result.bytes).toBe(32);
  });

  it('is not truncated when the final chunk lands exactly on the cap', async () => {
    const result = await readCappedBody(streamOf([bytes('abcd'), bytes('efgh')]), 8);

    expect(result).toMatchObject({ text: 'abcdefgh', truncated: false });
  });

  it('is truncated by a single byte over the cap', async () => {
    const result = await readCappedBody(streamOf([bytes('abcd'), bytes('efghi')]), 8);

    expect(result).toMatchObject({ text: 'abcdefgh', truncated: true, bytes: 8 });
  });
});

describe('readCappedBody, over the cap', () => {
  it('keeps exactly the cap and reports truncation', async () => {
    const result = await readCappedBody(streamOf([bytes('x'.repeat(100))]), 16);

    expect(result.bytes).toBe(16);
    expect(result.text).toBe('x'.repeat(16));
    expect(result.truncated).toBe(true);
  });

  it('stops reading instead of draining an endless body', async () => {
    // NFR-13's actual point. Without the cap check this never returns, and
    // the worker allocates whatever the endpoint decides to send.
    const { stream, pulls } = endlessStream(bytes('y'.repeat(8)));

    const result = await readCappedBody(stream, 16);

    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(16);
    // 16 bytes reached on pull 2, the deciding over-read is pull 3.
    expect(pulls()).toBe(3);
  });

  it('bounds the transient peak by one chunk, and says so (D39)', async () => {
    // read() cannot request a byte count -- it returns whatever the next
    // transport chunk is, so the deciding read can overshoot by one chunk.
    // The retained buffer is capped exactly; the peak is reported, not
    // silently assumed to equal the cap.
    const chunk = 4096;
    const { stream } = endlessStream(new Uint8Array(chunk));
    const cap = 10_000;

    const result = await readCappedBody(stream, cap);

    expect(result.bytes).toBe(cap);
    expect(result.peakBytes).toBeGreaterThan(cap);
    expect(result.peakBytes).toBeLessThanOrEqual(cap + chunk);
  });
});

describe('readCappedBody, stream cleanup (D38)', () => {
  it('leaves a fully-read stream unlocked', async () => {
    // A reader keeps its stream locked even after done: true. Left locked,
    // any later cancel() on that stream rejects with "Invalid state:
    // ReadableStream is locked" -- an unhandled rejection, or a spurious
    // failure of a probe that actually succeeded.
    const stream = streamOf([bytes('ok')]);

    await readCappedBody(stream, 64);

    expect(stream.locked).toBe(false);
    await expect(stream.cancel()).resolves.toBeUndefined();
  });

  it('leaves a truncated stream unlocked', async () => {
    const { stream } = endlessStream(bytes('z'.repeat(8)));

    await readCappedBody(stream, 16);

    expect(stream.locked).toBe(false);
    await expect(stream.cancel()).resolves.toBeUndefined();
  });

  it('unlocks the stream even when a read fails mid-body', async () => {
    // The failure path is the one that matters: a socket reset here must
    // not also leave the stream locked for whatever cleanup runs next.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('ECONNRESET'));
      },
    });

    await expect(readCappedBody(stream, 64)).rejects.toThrow('ECONNRESET');

    expect(stream.locked).toBe(false);
  });

  it('cancels through the reader, never the stream it still holds', async () => {
    // The distinction D38 names: cancelling the *stream* while a reader
    // holds it is exactly the TypeError above. Truncation tears down
    // through the reader instead.
    const { stream } = endlessStream(bytes('w'.repeat(8)));
    const cancelStream = vi.spyOn(stream, 'cancel');

    await readCappedBody(stream, 16);

    expect(cancelStream).not.toHaveBeenCalled();
  });
});
