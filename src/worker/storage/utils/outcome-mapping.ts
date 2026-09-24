import type { Insertable } from 'kysely';
import type {
  FailureClassLabel,
  ProbeOutcomeLabel,
  ProbeResultsTable,
} from '../../../core/db/types.js';
import type { ProbeOutcome } from '../../probing/index.js';

export type NewProbeResult = Insertable<ProbeResultsTable>;

export interface ResultContext {
  endpointId: string;
  /** The claimed slot as PostgreSQL's own text -- microseconds intact. */
  slot: string;
  /** `ClaimedSlot.scheduled_interval_s`. */
  intervalS: number;
  workerId: string;
  /** Generated once per attempt, before the probe; reused by retries of the write. */
  attemptId: string;
}

/**
 * What a probe concluded (docs/m5-plan.md §3.3). `BLOCKED_BY_POLICY` is our
 * refusal and `UNKNOWN_ERROR` is unclassified: recording either as `down`
 * would manufacture an outage M6 is required to exclude. A failure with no
 * class at all is unclassified too.
 */
export function outcomeLabel(o: Pick<ProbeOutcome, 'success' | 'failureClass'>): ProbeOutcomeLabel {
  if (o.success) return 'up';
  if (o.failureClass === undefined) return 'unknown';
  if (o.failureClass === 'BLOCKED_BY_POLICY' || o.failureClass === 'UNKNOWN_ERROR')
    return 'unknown';
  return 'down';
}

/** `null` for an absent phase -- never `0` (timing.ts). Rounded: the column is an integer. */
function ms(v: number | undefined): number | null {
  return v === undefined ? null : Math.round(v);
}

export function toResultRow(o: ProbeOutcome, ctx: ResultContext): NewProbeResult {
  return {
    endpoint_id: ctx.endpointId,
    started_at: new Date(o.startedAt),
    scheduled_at: ctx.slot,
    interval_s: ctx.intervalS,
    outcome: outcomeLabel(o),
    failure_class: o.failureClass ? (o.failureClass.toLowerCase() as FailureClassLabel) : null,
    failure_code: o.code ?? null,
    status_code: o.status ?? null,
    total_ms: Math.round(o.timings.totalMs),
    dns_ms: ms(o.timings.dnsMs),
    connect_ms: ms(o.timings.connectMs),
    tls_ms: ms(o.timings.tlsMs),
    ttfb_ms: ms(o.timings.ttfbMs),
    transfer_ms: ms(o.timings.transferMs),
    redirects: o.redirects,
    truncated: o.truncated,
    cert_expires_at: o.certExpiresAt ?? null,
    worker_id: ctx.workerId,
    attempt_id: ctx.attemptId,
  };
}
