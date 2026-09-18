import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamWriteTimeoutError,
  writeLineWithDeadline,
  type LineWritable,
} from './stream-write.js';

/**
 * Fake timers and a fake stream, because the case under test is a write that
 * never completes. Reproducing it against a real pipe means filling the OS
 * buffer with a reader that has stopped consuming -- possible, but decided by
 * buffer sizes rather than by the code, which is exactly the kind of timing
 * dependence `CLAUDE.md` rules out as evidence. Here the stall is exact.
 */

/** A stream that accepts the write and never calls back. */
function stalledStream(): LineWritable {
  return {
    write: () => false,
  };
}

/** A stream that completes immediately, optionally with an error. */
function completingStream(error?: Error): LineWritable {
  return {
    write: (_chunk, callback) => {
      callback(error ?? null);
      return true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('writeLineWithDeadline', () => {
  it('rejects when the write never completes, instead of waiting forever', async () => {
    const promise = writeLineWithDeadline(stalledStream(), 'line\n', 10_000);
    const assertion = expect(promise).rejects.toBeInstanceOf(StreamWriteTimeoutError);

    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
  });

  it('names the deadline it exceeded', async () => {
    const promise = writeLineWithDeadline(stalledStream(), 'line\n', 2_500);
    const assertion = expect(promise).rejects.toThrow(/2500ms/);

    await vi.advanceTimersByTimeAsync(2_500);

    await assertion;
  });

  it('resolves when the write completes, and leaves no timer behind', async () => {
    await expect(
      writeLineWithDeadline(completingStream(), 'line\n', 10_000),
    ).resolves.toBeUndefined();

    // A pending deadline would keep the process alive after the repair is
    // done, so the success path has to clear it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the stream error when the write fails', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    await expect(writeLineWithDeadline(completingStream(epipe), 'line\n', 10_000)).rejects.toThrow(
      /EPIPE/,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a callback that arrives after the deadline has already fired', async () => {
    let late: ((error?: Error | null) => void) | undefined;
    const stream: LineWritable = {
      write: (_chunk, callback) => {
        late = callback;
        return false;
      },
    };

    const promise = writeLineWithDeadline(stream, 'line\n', 1_000);
    const assertion = expect(promise).rejects.toBeInstanceOf(StreamWriteTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    // The stream settles late: this must not resolve an already-rejected
    // promise or surface as an unhandled rejection.
    expect(() => {
      late?.(null);
    }).not.toThrow();
  });
});
