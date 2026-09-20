/**
 * Racing a cancellable step against the probe deadline.
 *
 * Node cannot cancel an in-flight `dns.resolve`, so the guard's DNS step is
 * raced against the deadline instead (D44): the underlying call still runs to
 * completion and its late result is discarded. Without the race, a name
 * server that never answers holds the probe open past `timeout_ms` regardless
 * of every other bound, because the guard runs before any socket the
 * `AbortSignal` could reach.
 */

export interface AbortRace {
  /** Rejects with the signal's reason when it aborts. Never resolves. */
  promise: Promise<never>;
  /** Detaches the listener. Safe to call more than once. */
  dispose: () => void;
}

/**
 * A promise that rejects when `signal` aborts, plus the disposer for it.
 *
 * The disposer exists because the listener outlives the race otherwise: one
 * is attached per redirect hop, and every settled hop's listener stays on the
 * signal for the rest of the probe.
 *
 * Note this is *not* the `MaxListenersExceededWarning` case it might look
 * like. `AbortSignal` is an `EventTarget`, and an `EventTarget`'s max-listener
 * count defaults to 0 — unlimited. Measured: fifteen listeners on one signal
 * emits no warning at all. What this fixes is only the accumulation itself,
 * which was bounded by one probe's hop count and never unbounded.
 */
export function raceAbort(signal: AbortSignal): AbortRace {
  if (signal.aborted) {
    return {
      promise: Promise.reject(signal.reason as Error),
      dispose: () => undefined,
    };
  }

  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return {
    promise,
    dispose: () => {
      if (onAbort === undefined) return;
      signal.removeEventListener('abort', onAbort);
      onAbort = undefined;
    },
  };
}
