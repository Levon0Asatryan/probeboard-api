import { describe, expect, it } from 'vitest';
import { createTiming, type Clock } from './timing.js';

/**
 * A clock the test drives by hand. Every timing rule here is about *which*
 * instant is recorded and which arithmetic uses it, so a real clock would only
 * add flakiness — there is nothing to wait for.
 */
function fakeClock(options: { wall?: number; mono?: number } = {}): Clock & {
  advance(ms: number): void;
  setWall(value: number): void;
} {
  let mono = options.mono ?? 1_000;
  let wall = options.wall ?? 1_700_000_000_000;
  return {
    monotonic: () => mono,
    wallClock: () => wall,
    advance(ms) {
      mono += ms;
      wall += ms;
    },
    setWall(value) {
      wall = value;
    },
  };
}

describe('createTiming', () => {
  it('derives every phase with the formula the architecture doc documents', () => {
    const clock = fakeClock();
    const timing = createTiming(clock);

    clock.advance(5);
    timing.mark('dns_start');
    clock.advance(20);
    timing.mark('dns_done');
    clock.advance(1);
    timing.mark('connect_start');
    clock.advance(30);
    timing.mark('connect_done');
    timing.mark('tls_start');
    clock.advance(40);
    timing.mark('tls_done');
    clock.advance(50);
    timing.mark('first_byte');
    clock.advance(60);
    timing.markTerminal('transfer_done');

    const d = timing.derived();
    expect(d.dnsMs).toBe(20);
    expect(d.connectMs).toBe(30);
    expect(d.tlsMs).toBe(40);
    // ttfb starts at tls_done on https, not connect_done.
    expect(d.ttfbMs).toBe(50);
    expect(d.transferMs).toBe(60);
    expect(d.totalMs).toBe(206);
  });

  it('measures ttfb from connect_done when there is no handshake', () => {
    const clock = fakeClock();
    const timing = createTiming(clock);

    timing.mark('connect_start');
    clock.advance(10);
    timing.mark('connect_done');
    clock.advance(25);
    timing.mark('first_byte');

    expect(timing.derived().ttfbMs).toBe(25);
    expect(timing.derived().tlsMs).toBeUndefined();
  });

  it('measures total_ms directly, not as the sum of the phases', () => {
    // §3.3.2: the phases do not add up to the total, and that gap is real
    // time -- socket-pool wait, scheduling -- not noise to be hidden.
    const clock = fakeClock();
    const timing = createTiming(clock);

    timing.mark('dns_start');
    clock.advance(10);
    timing.mark('dns_done');
    clock.advance(500); // an unaccounted gap between instrumented boundaries
    timing.mark('connect_start');
    clock.advance(10);
    timing.mark('connect_done');
    clock.advance(10);
    timing.mark('first_byte');
    timing.markTerminal('transfer_done');

    const d = timing.derived();
    const summed = (d.dnsMs ?? 0) + (d.connectMs ?? 0) + (d.ttfbMs ?? 0) + (d.transferMs ?? 0);
    expect(d.totalMs).toBe(530);
    expect(d.totalMs).toBeGreaterThan(summed);
  });

  it('is unaffected by a wall-clock jump mid-probe', () => {
    // D37: an NTP step or an operator adjusting the clock must not corrupt a
    // duration. Only `startedAt` comes from the wall clock.
    const clock = fakeClock({ wall: 1_700_000_000_000 });
    const timing = createTiming(clock);
    const startedAt = timing.startedAt;

    clock.advance(100);
    clock.setWall(1_600_000_000_000); // jumps backwards, hard
    clock.advance(100);
    timing.markTerminal('failed_at');

    expect(timing.derived().totalMs).toBe(200);
    expect(timing.derived().totalMs).toBeGreaterThan(0);
    expect(timing.startedAt).toBe(startedAt);
  });

  it('produces total_ms on a path that never resolved DNS', () => {
    // D24: an IP-literal target makes no resolver call, and a scheme
    // rejection fails before resolution is attempted. Anchoring on
    // `dns_start` left both with no computable total.
    const clock = fakeClock();
    const timing = createTiming(clock);

    clock.advance(3);
    timing.markTerminal('blocked_at');

    const d = timing.derived();
    expect(d.totalMs).toBe(3);
    expect(d.dnsMs).toBeUndefined();
  });

  it('clears hop boundaries so a stalled hop is not read through the previous one', () => {
    // D45: hop 1's `3xx` sets first_byte. If hop 2 stalls before answering, a
    // leftover first_byte would make the abort classifier report BODY_TIMEOUT
    // for a hop that never received headers at all.
    const clock = fakeClock();
    const timing = createTiming(clock);

    timing.mark('connect_start');
    timing.mark('connect_done');
    timing.mark('first_byte');
    expect(timing.boundaries().first_byte).toBeDefined();

    timing.resetHop();

    expect(timing.boundaries().first_byte).toBeUndefined();
    expect(timing.boundaries().connect_done).toBeUndefined();
    expect(timing.boundaries().dns_start).toBeUndefined();
  });

  it('keeps total_ms spanning every hop even though phases describe the last one', () => {
    // D17: `connect_ms` and friends describe the final hop; `total_ms` still
    // covers the slow first hop, by construction rather than by a
    // redirect-specific rule.
    const clock = fakeClock();
    const timing = createTiming(clock);

    timing.mark('connect_start');
    clock.advance(400); // slow first hop
    timing.mark('connect_done');

    timing.resetHop();
    timing.mark('connect_start');
    clock.advance(10); // fast final hop
    timing.mark('connect_done');
    timing.markTerminal('transfer_done');

    const d = timing.derived();
    expect(d.connectMs).toBe(10);
    expect(d.totalMs).toBe(410);
  });

  it('records the first terminal boundary, not a later one', () => {
    // A catch further out must not overwrite the instant the outcome was
    // actually decided.
    const clock = fakeClock();
    const timing = createTiming(clock);

    clock.advance(15);
    timing.markTerminal('failed_at');
    clock.advance(500);
    timing.markTerminal('transfer_done');

    expect(timing.derived().totalMs).toBe(15);
    expect(timing.hasEnded()).toBe(true);
  });

  it('reports a running total before the probe has ended', () => {
    const clock = fakeClock();
    const timing = createTiming(clock);
    clock.advance(7);

    expect(timing.hasEnded()).toBe(false);
    expect(timing.derived().totalMs).toBe(7);
  });
});
