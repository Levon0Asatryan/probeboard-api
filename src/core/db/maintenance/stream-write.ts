/**
 * A line write that cannot hang forever.
 *
 * The audit awaits its recovery-record write *inside* the per-row transaction
 * (docs/m3-plan.md D60), which is what makes the record durable before the
 * removal is. The cost of that ordering is that a write which never completes
 * stalls the transaction, holding `FOR UPDATE` on that endpoint row: the API
 * blocks on it, and the audit D48 makes mandatory before M4 probes never
 * finishes.
 *
 * A *closed* pipe is not the dangerous case -- it fails fast with `EPIPE`.
 * The dangerous case is a live pipe whose reader stops consuming without
 * closing it: Node reports ordinary backpressure, the data sits in the
 * buffer, and the `write` callback simply never fires. Nothing in the stream
 * contract bounds that wait, so the bound has to come from here (D66).
 *
 * On timeout this rejects, which rolls the removal back and releases the row
 * lock -- the same path a write error takes.
 */

/**
 * The slice of a writable stream this needs, rather than `NodeJS.WriteStream`:
 * it keeps `process.stdout` and a test's fake stream interchangeable without
 * either one pretending to be a full `Writable`.
 */
export interface LineWritable {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export class StreamWriteTimeoutError extends Error {
  readonly code = 'STREAM_WRITE_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`stream write did not complete within ${String(timeoutMs)}ms`);
    this.name = 'StreamWriteTimeoutError';
  }
}

export function writeLineWithDeadline(
  stream: LineWritable,
  line: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    // Deliberately not `unref()`ed. If the write really is stuck, this timer
    // firing is the whole point; letting the process exit around it would
    // leave the stall unreported. The success path clears it instead, so a
    // completed write never holds the event loop open.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      // The write itself stays pending: nothing in the stream API releases a
      // write already blocked on a full pipe -- `destroy()` and `unref()` were
      // both measured leaving the process hung, on Node 24 and on the pinned
      // Node 22 (D69). Rejecting frees the transaction and its row lock; the
      // CLI then ends the process itself once it has reported (its bounded
      // exit), which is the only thing that does release the write.
      reject(new StreamWriteTimeoutError(timeoutMs));
    }, timeoutMs);

    stream.write(line, (error) => {
      // A stream may still invoke the callback after the deadline has passed.
      // Settling once keeps that late call from producing an unhandled
      // rejection or resolving a promise the caller already gave up on.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
