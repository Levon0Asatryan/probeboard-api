import { describe, expect, it } from 'vitest';
import { effectiveState } from './effective-state.js';

const since = new Date('2033-03-10T10:00:00Z');
const windowStart = new Date('2033-03-10T09:00:00Z');
const down = { state: 'down' as const, stateSince: since };

describe('effectiveState: paused > maintenance > stored > unknown (docs/m6-plan.md §3.10)', () => {
  it('is paused when disabled, whatever was stored or declared', () => {
    expect(effectiveState({ enabled: false, maintenanceSince: windowStart, stored: down })).toEqual(
      { state: 'paused', since: null },
    );
  });

  it('is maintenance while a window covers now, from the window start', () => {
    expect(effectiveState({ enabled: true, maintenanceSince: windowStart, stored: down })).toEqual({
      state: 'maintenance',
      since: windowStart,
    });
  });

  it('is the stored observation otherwise, from when it changed', () => {
    expect(effectiveState({ enabled: true, maintenanceSince: null, stored: down })).toEqual({
      state: 'down',
      since,
    });
  });

  it('is unknown when the evaluator has never seen the endpoint', () => {
    expect(effectiveState({ enabled: true, maintenanceSince: null, stored: null })).toEqual({
      state: 'unknown',
      since: null,
    });
  });
});
