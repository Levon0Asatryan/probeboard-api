import type { ObservedState } from '../../../core/db/types.js';

export type EffectiveState = ObservedState | 'paused' | 'maintenance';

/**
 * The state a user sees (docs/m6-plan.md §3.10, C7).
 *
 * The evaluator stores only what it observed. `paused` and `maintenance` are
 * functions of configuration, so they are derived here on every read: written
 * by the evaluator they would be stale by up to a tick after every API write.
 * Precedence: a paused endpoint is paused whatever it last did; a window
 * covering now says why failures are not opening incidents; then the stored
 * observation; and an endpoint the evaluator has never seen is `unknown`.
 */
export function effectiveState(input: {
  enabled: boolean;
  /** The earliest start among the windows covering now; `null` when none does. */
  maintenanceSince: Date | null;
  stored: { state: ObservedState; stateSince: Date } | null;
}): { state: EffectiveState; since: Date | null } {
  if (!input.enabled) return { state: 'paused', since: null };
  if (input.maintenanceSince !== null) {
    return { state: 'maintenance', since: input.maintenanceSince };
  }
  if (input.stored !== null) return { state: input.stored.state, since: input.stored.stateSince };
  return { state: 'unknown', since: null };
}
