import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { raceAbort } from './abort-race.js';

const listeners = (signal: AbortSignal): number => getEventListeners(signal, 'abort').length;

describe('raceAbort', () => {
  it('rejects with the abort reason', async () => {
    const controller = new AbortController();
    const race = raceAbort(controller.signal);
    const reason = new DOMException('probe deadline exceeded', 'TimeoutError');

    controller.abort(reason);

    await expect(race.promise).rejects.toBe(reason);
  });

  it('rejects immediately when the signal has already aborted', async () => {
    // The hop after the deadline has already fired: it must not wait for a
    // second abort that will never come.
    const controller = new AbortController();
    const reason = new DOMException('too late', 'TimeoutError');
    controller.abort(reason);

    await expect(raceAbort(controller.signal).promise).rejects.toBe(reason);
  });

  it('attaches exactly one listener and removes it on dispose', () => {
    // One listener is attached per redirect hop. Without the removal every
    // settled hop's listener stays on the signal for the rest of the probe.
    const controller = new AbortController();
    expect(listeners(controller.signal)).toBe(0);

    const race = raceAbort(controller.signal);
    expect(listeners(controller.signal)).toBe(1);

    race.dispose();
    expect(listeners(controller.signal)).toBe(0);

    // The promise is abandoned, never awaited, and must not keep the process
    // alive or surface as an unhandled rejection.
    race.promise.catch(() => undefined);
  });

  it('leaves nothing behind across many hops', () => {
    // The shape the executor actually produces: a race per hop, each
    // disposed as it settles. PROBE_MAX_REDIRECTS_CAP defaults to 10.
    const controller = new AbortController();

    for (let hop = 0; hop < 12; hop += 1) {
      const race = raceAbort(controller.signal);
      race.promise.catch(() => undefined);
      race.dispose();
    }

    expect(listeners(controller.signal)).toBe(0);
  });

  it('is safe to dispose more than once', () => {
    const controller = new AbortController();
    const race = raceAbort(controller.signal);
    race.promise.catch(() => undefined);

    race.dispose();
    race.dispose();

    expect(listeners(controller.signal)).toBe(0);
  });

  it('does not attach a listener at all when already aborted', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('gone', 'TimeoutError'));

    const race = raceAbort(controller.signal);
    race.promise.catch(() => undefined);

    expect(listeners(controller.signal)).toBe(0);
    race.dispose();
  });
});
