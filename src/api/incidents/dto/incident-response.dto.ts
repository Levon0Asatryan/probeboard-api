import type { FailureClassLabel, FailureDetail, Incident } from '../../../core/db/types.js';

/**
 * One incident, as D-5 and FR-27 show it (docs/m6-plan.md §3.10).
 *
 * Every time is a probe `started_at` (plan §3.5): `openedAt` the first failed
 * probe of the run, `confirmedAt` the one that reached the threshold,
 * `closedAt` the first success of the recovery, `closeConfirmedAt` the one
 * that reached it. So `detectionLatencyMs` is what hysteresis cost, recorded
 * rather than hidden, and `durationMs` is the outage as the endpoint had it.
 */
export interface IncidentDto {
  id: string;
  endpointId: string;
  serviceId: string;
  status: 'open' | 'closed';
  openedAt: string;
  confirmedAt: string;
  closedAt: string | null;
  closeConfirmedAt: string | null;
  /** `closedAt - openedAt`; `null` while open. */
  durationMs: number | null;
  /** `confirmedAt - openedAt`. */
  detectionLatencyMs: number;
  /** The failure threshold in force when it opened. */
  failuresToOpen: number;
  /** The first failed probe's evidence, copied when the incident opened (plan C8). */
  cause: {
    class: FailureClassLabel;
    code: string | null;
    statusCode: number | null;
    /** Which assertion failed, when the class is `assertion_failed` (D11). */
    assertion: FailureDetail | null;
  };
}

export function toIncidentDto(i: Incident): IncidentDto {
  return {
    id: i.id,
    endpointId: i.endpoint_id,
    serviceId: i.service_id,
    status: i.closed_at === null ? 'open' : 'closed',
    openedAt: i.opened_at.toISOString(),
    confirmedAt: i.confirmed_at.toISOString(),
    closedAt: i.closed_at?.toISOString() ?? null,
    closeConfirmedAt: i.close_confirmed_at?.toISOString() ?? null,
    durationMs: i.closed_at === null ? null : i.closed_at.getTime() - i.opened_at.getTime(),
    detectionLatencyMs: i.confirmed_at.getTime() - i.opened_at.getTime(),
    failuresToOpen: i.failures_to_open,
    cause: {
      class: i.cause_class,
      code: i.cause_code,
      statusCode: i.cause_status_code,
      assertion: i.cause_detail,
    },
  };
}
