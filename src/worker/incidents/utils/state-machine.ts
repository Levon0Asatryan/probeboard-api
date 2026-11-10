/**
 * The incident state machine, as one pure step (docs/m6-plan.md §3.4).
 *
 * **State is derived, not transitioned.** Architecture §7.6 writes the machine
 * as rules keyed on the previous state, and as written they fail three ways
 * (plan C3): no rule returns PENDING to UP on a success; a slow success while
 * an incident is open moves DOWN to DEGRADED, after which the close rule never
 * matches again; and whether one failure opens an incident at N = 1 depends on
 * the order the rules are applied in. Here the counters move first and the
 * state is computed from (open incident, counters, this observation), so none
 * of those questions exists.
 *
 * **Times are probe `started_at`s**, never a clock read here (plan §3.5):
 * `opened_at` is the first failed probe of the run (D-2, 03 §3.8), not the one
 * that crossed the threshold, which would under-report every outage by
 * `(N - 1) x interval`.
 *
 * No I/O, no clock, no global state: the one source of novelty, the id of an
 * incident being opened, is injected.
 */
import type {
  FailureClassLabel,
  FailureDetail,
  ObservedState,
  ProbeOutcomeLabel,
} from '../../../core/db/types.js';

/** One stored result, as the evaluator reads it. */
export interface Observation {
  startedAt: Date;
  attemptId: string;
  outcome: ProbeOutcomeLabel;
  /** A declared window covered `startedAt` when the row was written (D6). */
  inMaintenance: boolean;
  failureClass: FailureClassLabel | null;
  failureCode: string | null;
  statusCode: number | null;
  failureDetail: FailureDetail | null;
}

/** What an incident's cause is copied from: the first failed probe of the run (C8). */
export interface RunEvidence {
  startedAt: Date;
  failureClass: FailureClassLabel;
  failureCode: string | null;
  statusCode: number | null;
  failureDetail: FailureDetail | null;
}

export interface Health {
  state: ObservedState;
  stateSince: Date;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Present exactly when `consecutiveFailures > 0` (the schema's run_shape CHECK). */
  run: RunEvidence | null;
  /** The first success of the current recovery run -- `closed_at` if it closes. */
  recoveryStartedAt: Date | null;
  openIncidentId: string | null;
  lastSuccessAt: Date | null;
  /** The newest observation applied: the ordering fence (D3). */
  applied: { startedAt: Date; attemptId: string } | null;
}

/** `failure_threshold` and `success_threshold`, as they are when evaluated (D17). */
export interface Thresholds {
  failuresToOpen: number;
  successesToClose: number;
}

export type Transition =
  | {
      kind: 'open';
      incidentId: string;
      openedAt: Date;
      confirmedAt: Date;
      failuresToOpen: number;
      cause: RunEvidence;
    }
  | { kind: 'close'; incidentId: string; closedAt: Date; closeConfirmedAt: Date };

export type Step =
  | { applied: true; health: Health; transitions: Transition[] }
  /** Older than the last applied observation: stored and folded, never applied (D3). */
  | { applied: false; health: Health; transitions: [] };

/** Before any observation: nothing is known. */
export function initialHealth(since: Date): Health {
  return {
    state: 'unknown',
    stateSince: since,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    run: null,
    recoveryStartedAt: null,
    openIncidentId: null,
    lastSuccessAt: null,
    applied: null,
  };
}

/** Whether `o` is at or before the fence: same instant, then attempt id breaks the tie. */
function isLate(o: Observation, fence: Health['applied']): boolean {
  if (fence === null) return false;
  const a = o.startedAt.getTime();
  const b = fence.startedAt.getTime();
  return a < b || (a === b && o.attemptId <= fence.attemptId);
}

function evidenceOf(o: Observation): RunEvidence {
  return {
    startedAt: o.startedAt,
    // A `down` row always carries a class (the writer maps a classless
    // failure to `unknown`, outcome-mapping.ts); this is the schema's NOT NULL
    // honoured rather than assumed.
    failureClass: o.failureClass ?? 'unknown_error',
    failureCode: o.failureCode,
    statusCode: o.statusCode,
    failureDetail: o.failureDetail,
  };
}

/**
 * Applies one observation.
 *
 * | observation                  | counters                    | run / recovery                    | incident                                  | state                       |
 * | ---------------------------- | --------------------------- | --------------------------------- | ----------------------------------------- | --------------------------- |
 * | failure, outside maintenance | failures += 1, successes = 0 | run starts at the first failure  | opens when none is open and failures >= N | open ? down : pending       |
 * | failure, in maintenance      | both 0                      | run cleared (D-6)                 | never opens                               | open ? down : pending       |
 * | success (up / degraded)      | successes += 1, failures = 0 | recovery starts at the first one | closes when open and successes >= M      | open ? down : the outcome   |
 * | unknown                      | unchanged                   | unchanged                         | unchanged                                 | unknown                     |
 */
export function step(
  health: Health,
  o: Observation,
  thresholds: Thresholds,
  newIncidentId: () => string,
): Step {
  if (isLate(o, health.applied)) return { applied: false, health, transitions: [] };

  let next: Health = { ...health, applied: { startedAt: o.startedAt, attemptId: o.attemptId } };
  const transitions: Transition[] = [];
  let state: ObservedState;

  if (o.outcome === 'unknown') {
    // D-7: probeboard refused or could not tell. Neither evidence of failure
    // nor of recovery -- a run in progress keeps its opened_at, an open
    // incident stays open.
    state = 'unknown';
  } else if (o.outcome === 'down') {
    if (o.inMaintenance) {
      // D-6: a failure inside a declared window is expected. It must not seed
      // a run that opens after the window with opened_at inside it.
      next = { ...next, consecutiveFailures: 0, run: null };
    } else {
      const failures = health.consecutiveFailures + 1;
      next = {
        ...next,
        consecutiveFailures: failures,
        run: failures === 1 ? evidenceOf(o) : health.run,
      };
    }
    next = { ...next, consecutiveSuccesses: 0, recoveryStartedAt: null };

    if (
      next.openIncidentId === null &&
      next.run !== null &&
      next.consecutiveFailures >= thresholds.failuresToOpen
    ) {
      const incidentId = newIncidentId();
      transitions.push({
        kind: 'open',
        incidentId,
        openedAt: next.run.startedAt,
        confirmedAt: o.startedAt,
        failuresToOpen: thresholds.failuresToOpen,
        cause: next.run,
      });
      next = { ...next, openIncidentId: incidentId };
    }
    state = next.openIncidentId !== null ? 'down' : 'pending';
  } else {
    // `up` and `degraded` alike: a degraded endpoint answered correctly, so it
    // counts toward recovery (D7) -- C3b is exactly the case where it did not.
    const successes = health.consecutiveSuccesses + 1;
    next = {
      ...next,
      consecutiveFailures: 0,
      run: null,
      consecutiveSuccesses: successes,
      recoveryStartedAt: successes === 1 ? o.startedAt : health.recoveryStartedAt,
      lastSuccessAt: o.startedAt,
    };

    if (
      next.openIncidentId !== null &&
      next.recoveryStartedAt !== null &&
      next.consecutiveSuccesses >= thresholds.successesToClose
    ) {
      transitions.push({
        kind: 'close',
        incidentId: next.openIncidentId,
        closedAt: next.recoveryStartedAt,
        closeConfirmedAt: o.startedAt,
      });
      next = { ...next, openIncidentId: null };
    }
    state = next.openIncidentId !== null ? 'down' : o.outcome;
  }

  if (state !== health.state) next = { ...next, state, stateSince: o.startedAt };
  return { applied: true, health: next, transitions };
}
