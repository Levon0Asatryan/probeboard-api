/**
 * Phase-boundary capture for one probe.
 *
 * Records the **absolute timestamp of each boundary**, never a duration
 * (`03-api-health.md` §3.3.1). Any duration is derivable from boundaries; the
 * reverse is not, and redirects or connection reuse produce overlapping or
 * absent phases that durations cannot represent — `blackbox_exporter` has an
 * open bug of exactly that shape. Gaps between phases (scheduler jitter,
 * socket-pool wait) also stay visible rather than folding into a neighbour,
 * which is what ADR-0004 ties NFR-5 to.
 *
 * Two clocks, not one (docs/m3-plan.md D37). `wallClock()` answers "when did
 * this happen" and is the only source for the user-facing `startedAt`;
 * `monotonic()` answers "how long did it take" and is the only source for
 * every `*_ms`. `Date.now()` can step backwards under NTP or an operator
 * adjusting the system clock mid-probe, which would report a negative or
 * wildly inflated `total_ms` for a measurement NFR-5 commits to being
 * trustworthy.
 */

/** A boundary that belongs to a single redirect hop and resets between hops. */
export type HopBoundary =
  | 'dns_start'
  | 'dns_done'
  | 'connect_start'
  | 'connect_done'
  | 'tls_start'
  | 'tls_done'
  | 'first_byte'
  | 'transfer_done';

/**
 * How the probe ended. Exactly one is recorded on every path (D22).
 *
 * `transfer_done` doubles as a hop boundary and a terminal one: a successful
 * probe ends when the evaluated response finishes reading.
 */
export type TerminalBoundary = 'transfer_done' | 'blocked_at' | 'failed_at';

export interface Clock {
  /** `Date.now()` in production. Used only for `startedAt`, never subtracted. */
  wallClock(): number;
  /** `performance.now()` in production. The only source for durations. */
  monotonic(): number;
}

/**
 * The boundaries as recorded, in monotonic time. Absent means "never reached",
 * which is meaningful: the abort classifier reads exactly these gaps to decide
 * which phase a deadline fired in (D16).
 */
export type Boundaries = Partial<Record<HopBoundary, number>>;

/** Derived phases, per `03-api-health.md` §3.3.2. Absent when underivable. */
export interface DerivedPhases {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  transferMs?: number;
  /** Always present: D24's anchor exists on every path. */
  totalMs: number;
}

export interface ProbeTiming {
  /** Wall-clock instant the probe began. The one non-monotonic value. */
  readonly startedAt: number;
  /** Records a hop boundary at the current monotonic instant. */
  mark(boundary: HopBoundary): void;
  /** Clears every hop boundary, before a redirect hop's attempt begins (D45). */
  resetHop(): void;
  /** Records how the probe ended. The first call wins. */
  markTerminal(boundary: TerminalBoundary): void;
  /** The current hop's boundaries — the "final hop" once the probe ends (D17). */
  boundaries(): Boundaries;
  /** Whether a terminal boundary has been recorded yet. */
  hasEnded(): boolean;
  /** Derived phases for the final hop, plus `total_ms` for the whole probe. */
  derived(): DerivedPhases;
}

export function createTiming(clock: Clock): ProbeTiming {
  // D24: the unconditional anchor, taken before any validation runs. The
  // first draft anchored `total_ms` on `dns_start`, which an IP-literal
  // target never sets (no resolution happens) and a scheme/port/credential
  // rejection never reaches — leaving `total_ms` uncomputable for ordinary
  // successful probes and for the cheapest policy rejections.
  const probeStart = clock.monotonic();
  const startedAt = clock.wallClock();

  let boundaries: Boundaries = {};
  let endAt: number | undefined;

  const sub = (from?: number, to?: number): number | undefined =>
    from === undefined || to === undefined ? undefined : to - from;

  return {
    startedAt,

    mark(boundary) {
      boundaries[boundary] = clock.monotonic();
    },

    resetHop() {
      // D45: not automatic. A redirect's `3xx` response has headers, so
      // `first_byte` is set for that hop exactly like a final response. If the
      // next hop then stalls before answering, a stale `first_byte` would make
      // the abort classifier read "headers arrived, body stalled" and report
      // BODY_TIMEOUT for a hop that never got that far. `dns_*` resets too,
      // since a redirect can target a different host.
      boundaries = {};
    },

    markTerminal(boundary) {
      // First call wins: a later `catch` must not overwrite the instant the
      // outcome was actually decided.
      if (endAt !== undefined) return;
      endAt = clock.monotonic();
      if (boundary === 'transfer_done') boundaries.transfer_done = endAt;
    },

    boundaries() {
      return { ...boundaries };
    },

    hasEnded() {
      return endAt !== undefined;
    },

    derived() {
      const b = boundaries;
      return {
        dnsMs: sub(b.dns_start, b.dns_done),
        connectMs: sub(b.connect_start, b.connect_done),
        tlsMs: sub(b.tls_start, b.tls_done),
        // `tls_done ?? connect_done`: on plain http there is no handshake, so
        // time-to-first-byte starts at the TCP connect. This is the only phase
        // that measures the API itself rather than the path to it.
        ttfbMs: sub(b.tls_done ?? b.connect_done, b.first_byte),
        transferMs: sub(b.first_byte, b.transfer_done),
        // Measured directly from the anchor, never summed from the phases
        // above — ADR-0004 and §3.3.2 both say the phases will not add up to
        // it (~10% is normal, and redirect-hop time is a further disclosed
        // reason under D17).
        //
        // This deliberately supersedes `03-api-health.md` §3.3.2's own
        // formula, `transfer_done − dns_start`: that one is uncomputable on
        // every path D24 exists to cover, and it would exclude earlier
        // redirect hops entirely. D24 anchors on `probe_start` instead, which
        // already spans the whole probe including every hop.
        totalMs: (endAt ?? clock.monotonic()) - probeStart,
      };
    },
  };
}
