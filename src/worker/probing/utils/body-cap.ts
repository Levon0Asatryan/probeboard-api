/**
 * Reads a response body under a hard byte cap (NFR-13, docs/m3-plan.md §3.6).
 *
 * The cap is applied *while* reading, not by trimming a buffer that has
 * already been read in full — three of the four reference implementations
 * surveyed in §2.3 do the latter, which means a hostile or merely broken
 * endpoint decides how much memory the worker allocates.
 */

/** What a capped read produced. */
export interface CappedBody {
  /** The retained bytes, decoded as UTF-8. Never longer than the cap. */
  text: string;
  /** Whether the endpoint had more body than the cap allowed us to keep. */
  truncated: boolean;
  /** Retained byte count — `min(actual body length, cap)`. */
  bytes: number;
  /**
   * The largest number of body bytes held at once, including the single
   * deciding over-read (D39). Reported rather than assumed away: see below.
   */
  peakBytes: number;
}

const EMPTY: CappedBody = { text: '', truncated: false, bytes: 0, peakBytes: 0 };

/**
 * Reads at most `cap` bytes from `body`.
 *
 * Three rules, each of which was a defect in an earlier draft:
 *
 * 1. **Reaching the cap is not being truncated (D30).** A body whose true
 *    length is *exactly* the cap reaches it at the same instant it ends, and
 *    the loop cannot yet tell those apart — it has not seen `done: true`. So
 *    the decision is deferred by one further `read()`: `done` arriving at or
 *    below the cap means complete, and only a chunk pushing the count
 *    *past* the cap means truncated. Deciding at `>=` marks a healthy
 *    endpoint truncated, and D23/D28's conservative truncation handling then
 *    fails assertions the complete body satisfies — reporting it down.
 * 2. **The overshoot is one chunk, and it is disclosed (D39).** `read()`
 *    cannot ask for a byte count; it returns whatever the next transport
 *    chunk is. The *retained* buffer is capped exactly, but the peak held
 *    during that one deciding read exceeds the cap by up to one chunk. That
 *    bound is the transport's record and socket sizing, not anything the
 *    response declares, so it is not attacker-inflatable — but it is not
 *    zero either, and `peakBytes` states it instead of leaving it unstated.
 * 3. **The reader is released, the stream is never cancelled behind it
 *    (D38).** A reader keeps its stream locked even after `done: true`. Any
 *    later `body.cancel()` on a stream whose reader is still held rejects
 *    with `TypeError: Invalid state: ReadableStream is locked` — an
 *    unhandled rejection, or a spurious failure of a probe that succeeded.
 *    Truncation stops the transfer through `reader.cancel()`, which is the
 *    reader's own teardown; `releaseLock()` in `finally` covers every path,
 *    including a read that threw.
 *
 * A null body is not an error (D18). `HEAD`, `204`, `205` and `304` have no
 * body by specification; the result is empty and assertions run against it
 * normally, so `body_contains` fails as ASSERTION_FAILED rather than crashing.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  cap: number,
): Promise<CappedBody> {
  if (body === null || body === undefined) return { ...EMPTY };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;

      chunks.push(value);
      total += value.byteLength;

      // Strictly greater: landing exactly on the cap is rule 1's case and
      // has to go round once more for `done`.
      if (total > cap) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const retained = concat(chunks, Math.min(total, cap));
  return {
    text: new TextDecoder().decode(retained),
    truncated,
    bytes: retained.byteLength,
    peakBytes: total,
  };
}

/** Joins the chunks into exactly `length` bytes, dropping any overshoot. */
function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const take = Math.min(chunk.byteLength, length - offset);
    out.set(take === chunk.byteLength ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}
