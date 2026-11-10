import { describe, expect, it } from 'vitest';
import {
  initialHealth,
  step,
  type Health,
  type Observation,
  type Thresholds,
  type Transition,
} from './state-machine.js';

const T0 = Date.parse('2026-09-29T10:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000);

type Kind = 'F' | 'S' | 'D' | 'U' | 'MF' | 'MS';

/** F failure, S success, D degraded success, U unknown; M- inside a window. */
function obs(kind: Kind, minute: number, over: Partial<Observation> = {}): Observation {
  const outcome =
    kind === 'F' || kind === 'MF'
      ? 'down'
      : kind === 'U'
        ? 'unknown'
        : kind === 'D'
          ? 'degraded'
          : 'up';
  return {
    startedAt: at(minute),
    attemptId: `00000000-0000-4000-8000-${String(minute).padStart(12, '0')}`,
    outcome,
    inMaintenance: kind === 'MF' || kind === 'MS',
    failureClass:
      outcome === 'down'
        ? 'connection_refused'
        : outcome === 'unknown'
          ? 'blocked_by_policy'
          : null,
    failureCode: outcome === 'down' ? 'ECONNREFUSED' : null,
    statusCode: null,
    failureDetail: null,
    ...over,
  };
}

const N3M2: Thresholds = { failuresToOpen: 3, successesToClose: 2 };

/** Runs a sequence, one observation a minute from 10:01, collecting every transition. */
function run(
  kinds: Kind[],
  thresholds: Thresholds = N3M2,
  from: Health = initialHealth(at(0)),
): { health: Health; transitions: Transition[] } {
  let health = from;
  const transitions: Transition[] = [];
  let n = 0;
  kinds.forEach((k, i) => {
    const s = step(health, obs(k, i + 1), thresholds, () => `incident-${++n}`);
    health = s.health;
    transitions.push(...s.transitions);
  });
  return { health, transitions };
}

describe('opening (D-1, D-2)', () => {
  it('opens on the Nth consecutive failure, timed from the first', () => {
    const { health, transitions } = run(['S', 'F', 'F', 'F']);
    expect(transitions).toEqual([
      expect.objectContaining({
        kind: 'open',
        openedAt: at(2),
        confirmedAt: at(4),
        failuresToOpen: 3,
        cause: expect.objectContaining({ startedAt: at(2), failureClass: 'connection_refused' }),
      }),
    ]);
    expect(health).toMatchObject({ state: 'down', stateSince: at(4), consecutiveFailures: 3 });
  });

  it('shows the retry window as pending, with the count, before N (03 §3.7)', () => {
    const { health, transitions } = run(['S', 'F', 'F']);
    expect(transitions).toEqual([]);
    expect(health).toMatchObject({ state: 'pending', consecutiveFailures: 2, stateSince: at(2) });
  });

  it('never opens on isolated failures', () => {
    expect(run(['F', 'S', 'F', 'S', 'F', 'S', 'F']).transitions).toEqual([]);
  });

  it('opens on the first failure at N = 1, timed from itself (C3c)', () => {
    const { transitions } = run(['S', 'F'], { failuresToOpen: 1, successesToClose: 1 });
    expect(transitions).toEqual([
      expect.objectContaining({ kind: 'open', openedAt: at(2), confirmedAt: at(2) }),
    ]);
  });

  it('opens at the next failure when N is lowered below a run already in progress', () => {
    const mid = run(['F', 'F', 'F', 'F'], { failuresToOpen: 10, successesToClose: 2 });
    expect(mid.transitions).toEqual([]);
    const s = step(mid.health, obs('F', 5), N3M2, () => 'x');
    expect(s.transitions).toEqual([
      expect.objectContaining({ kind: 'open', openedAt: at(1), confirmedAt: at(5) }),
    ]);
  });

  it('copies the evidence of the first failure, not the one that crossed N (C8)', () => {
    let h = initialHealth(at(0));
    const first = obs('F', 1, {
      failureClass: 'assertion_failed',
      failureCode: null,
      statusCode: 200,
      failureDetail: {
        index: 0,
        code: 'value_mismatch',
        assertion: { type: 'json_path', path: '$.s', equals: 'ok' },
      },
    });
    h = step(h, first, N3M2, () => 'x').health;
    h = step(
      h,
      obs('F', 2, { failureClass: 'status_mismatch', statusCode: 500 }),
      N3M2,
      () => 'x',
    ).health;
    const s = step(h, obs('F', 3, { failureClass: 'connection_reset' }), N3M2, () => 'inc');
    expect(s.transitions[0]).toMatchObject({
      kind: 'open',
      cause: {
        failureClass: 'assertion_failed',
        statusCode: 200,
        failureDetail: { index: 0, code: 'value_mismatch' },
      },
    });
  });

  it('does not open a second incident while one is open', () => {
    const { transitions } = run(['F', 'F', 'F', 'F', 'F', 'F', 'F']);
    expect(transitions.filter((t) => t.kind === 'open')).toHaveLength(1);
  });
});

describe('closing (D-3)', () => {
  it('closes after M consecutive successes, timed from the first', () => {
    const { health, transitions } = run(['F', 'F', 'F', 'S', 'S']);
    expect(transitions[1]).toEqual({
      kind: 'close',
      incidentId: 'incident-1',
      closedAt: at(4),
      closeConfirmedAt: at(5),
    });
    expect(health).toMatchObject({ state: 'up', openIncidentId: null, consecutiveSuccesses: 2 });
  });

  it('stays down, and restarts the recovery, when a failure interrupts it', () => {
    const { health, transitions } = run(['F', 'F', 'F', 'S', 'F', 'S']);
    expect(transitions.filter((t) => t.kind === 'close')).toEqual([]);
    expect(health).toMatchObject({
      state: 'down',
      recoveryStartedAt: at(6),
      consecutiveSuccesses: 1,
    });
  });

  it('counts a slow success toward closing, and stays down until M (C3b)', () => {
    // 07 §7.6's rules moved DOWN to DEGRADED here, and then never closed.
    const mid = run(['F', 'F', 'F', 'D']);
    expect(mid.health.state).toBe('down');
    const { transitions } = run(['F', 'F', 'F', 'D', 'S']);
    expect(transitions[1]).toMatchObject({
      kind: 'close',
      closedAt: at(4),
      closeConfirmedAt: at(5),
    });
  });

  it('closes on the first success at M = 1', () => {
    const { transitions } = run(['F', 'S'], { failuresToOpen: 1, successesToClose: 1 });
    expect(transitions.map((t) => t.kind)).toEqual(['open', 'close']);
    expect(transitions[1]).toMatchObject({ closedAt: at(2), closeConfirmedAt: at(2) });
  });
});

describe('the states between incidents', () => {
  it('returns from pending to up on a success (C3a)', () => {
    const { health } = run(['F', 'S']);
    expect(health).toMatchObject({
      state: 'up',
      consecutiveFailures: 0,
      run: null,
      stateSince: at(2),
    });
  });

  it('is degraded for a slow success with no incident open, and up again after a fast one', () => {
    expect(run(['S', 'D']).health).toMatchObject({ state: 'degraded', stateSince: at(2) });
    expect(run(['S', 'D', 'S']).health).toMatchObject({ state: 'up', stateSince: at(3) });
  });

  it('moves stateSince only when the state changes', () => {
    expect(run(['S', 'S', 'S']).health).toMatchObject({ state: 'up', stateSince: at(1) });
  });

  it('records the last success', () => {
    expect(run(['S', 'D', 'F']).health.lastSuccessAt).toEqual(at(2));
  });
});

describe('unknown (D-7, D5)', () => {
  it('never opens an incident, however many', () => {
    const { health, transitions } = run(['U', 'U', 'U', 'U', 'U']);
    expect(transitions).toEqual([]);
    expect(health).toMatchObject({ state: 'unknown', consecutiveFailures: 0 });
  });

  it('neither extends nor breaks a run: F U F F opens, timed from the first F', () => {
    const { transitions } = run(['F', 'U', 'F', 'F']);
    expect(transitions).toEqual([
      expect.objectContaining({ kind: 'open', openedAt: at(1), confirmedAt: at(4) }),
    ]);
  });

  it('neither closes an open incident nor breaks its recovery', () => {
    const { transitions } = run(['F', 'F', 'F', 'S', 'U', 'S']);
    expect(transitions[1]).toMatchObject({
      kind: 'close',
      closedAt: at(4),
      closeConfirmedAt: at(6),
    });
    const stuck = run(['F', 'F', 'F', 'U', 'U', 'U']);
    expect(stuck.health).toMatchObject({ state: 'unknown', openIncidentId: 'incident-1' });
  });
});

describe('maintenance (D-6, D6)', () => {
  it('never opens inside a window, however many failures', () => {
    const { health, transitions } = run(['MF', 'MF', 'MF', 'MF', 'MF']);
    expect(transitions).toEqual([]);
    expect(health).toMatchObject({ consecutiveFailures: 0, run: null });
  });

  it('does not let failures inside a window seed opened_at after it', () => {
    // A deploy fails in the window and once after it: the run starts outside.
    const { health, transitions } = run(['MF', 'MF', 'F']);
    expect(transitions).toEqual([]);
    expect(health).toMatchObject({
      consecutiveFailures: 1,
      run: expect.objectContaining({ startedAt: at(3) }),
    });
    const opened = run(['MF', 'MF', 'F', 'F', 'F']);
    expect(opened.transitions[0]).toMatchObject({ kind: 'open', openedAt: at(3) });
  });

  it('keeps an incident open before the window open through it: one incident (Kuma #2846)', () => {
    const { health, transitions } = run(['F', 'F', 'F', 'MF', 'MF', 'F', 'F', 'F']);
    expect(transitions.map((t) => t.kind)).toEqual(['open']);
    expect(health).toMatchObject({ state: 'down', openIncidentId: 'incident-1' });
  });

  it('closes a prior incident on successes inside the window', () => {
    const { transitions } = run(['F', 'F', 'F', 'MS', 'MS']);
    expect(transitions[1]).toMatchObject({
      kind: 'close',
      closedAt: at(4),
      closeConfirmedAt: at(5),
    });
  });

  it('restarts a recovery that a failure inside the window interrupts', () => {
    const { transitions } = run(['F', 'F', 'F', 'MS', 'MF', 'MS', 'MS']);
    expect(transitions[1]).toMatchObject({ kind: 'close', closedAt: at(6) });
  });
});

describe('ordering (D3)', () => {
  it('refuses an observation older than the last applied, and changes nothing', () => {
    const h = run(['S', 'S', 'S', 'S', 'S']).health; // applied up to 10:05
    const s = step(h, obs('F', 4), N3M2, () => 'x');
    expect(s.applied).toBe(false);
    expect(s.health).toBe(h);
    expect(s.transitions).toEqual([]);
  });

  it('refuses the same observation twice, so a replay is idempotent', () => {
    const h = run(['F', 'F', 'F']).health;
    const again = step(h, obs('F', 3), N3M2, () => 'x');
    expect(again).toMatchObject({ applied: false, transitions: [] });
  });

  it('orders a same-millisecond pair by attempt id, applying the later one', () => {
    const h = step(initialHealth(at(0)), obs('S', 1, { attemptId: 'b' }), N3M2, () => 'x').health;
    expect(step(h, obs('F', 1, { attemptId: 'a' }), N3M2, () => 'x').applied).toBe(false);
    expect(step(h, obs('F', 1, { attemptId: 'c' }), N3M2, () => 'x').applied).toBe(true);
  });
});

describe('the run-shape invariant the schema enforces', () => {
  it('has a run exactly when failures > 0, after every step of a mixed sequence', () => {
    const kinds: Kind[] = ['F', 'U', 'MF', 'F', 'F', 'F', 'S', 'MS', 'D', 'F', 'U', 'S', 'S'];
    let h = initialHealth(at(0));
    kinds.forEach((k, i) => {
      h = step(h, obs(k, i + 1), N3M2, () => `i${i}`).health;
      expect(h.consecutiveFailures > 0, `after ${k} at ${i}`).toBe(h.run !== null);
    });
  });
});
