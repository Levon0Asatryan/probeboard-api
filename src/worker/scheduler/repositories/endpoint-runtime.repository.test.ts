import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../../core/db/utils/kysely.js';
import { EndpointRuntimeRepository } from './endpoint-runtime.repository.js';

/**
 * Compiled-SQL assertions. No database: these check properties of the
 * statement text that a running query would not reveal — most importantly
 * that no worker-clock value is ever *written* to a scheduling column (D3).
 *
 * The pool is never connected; Kysely needs a dialect to compile against, not
 * a live server.
 */
const db = createDb(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }));
const repo = new EndpointRuntimeRepository({ kysely: db } as never);

/** PostgreSQL's own text form, microseconds and all -- never a JS Date. */
const SLOT = '2026-01-01 00:00:00.123456+00';

/** Every column whose value is a scheduling decision the database must own. */
const SCHEDULING_COLUMNS = ['next_run_at', 'leased_until', 'scheduled_at', 'last_probe_at'];

/**
 * The right-hand side of every `column = ...` assignment in a SET clause.
 *
 * Deliberately only the SET clause: a bound timestamp in `WHERE` is the fence
 * (`scheduled_at = $slot`), which is required, not forbidden.
 *
 * Depth-aware, and that is not fussiness. A regex ending the clause at the
 * first `/\bFROM\b/i` stops inside `extract(epoch from (now() - …))`, which
 * the claim's own catch-up arithmetic contains -- so it returned two
 * assignments instead of five and never looked at `leased_until` or
 * `leased_by`, the two a worker clock would most plausibly be written into.
 * The clause ends at a `FROM` or `WHERE` that is at paren depth zero.
 */
function setAssignments(sqlText: string): { column: string; value: string }[] {
  const setAt = /\bSET\b/i.exec(sqlText);
  if (!setAt) return [];

  let depth = 0;
  let end = sqlText.length;
  for (let i = setAt.index + setAt[0].length; i < sqlText.length; i += 1) {
    const ch = sqlText[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && /\bFROM\b|\bWHERE\b/i.test(sqlText.slice(i, i + 6))) {
      end = i;
      break;
    }
  }

  const clause = sqlText.slice(setAt.index + setAt[0].length, end);
  const parts: string[] = [];
  let current = '';
  depth = 0;
  for (const ch of clause) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return { column: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
}

describe('no worker clock reaches a scheduling column (D3)', () => {
  it.each([
    ['claim', () => repo.claimQuery('worker-a', 60_000, 100)],
    ['release', () => repo.releaseQuery('e1', 'worker-a', SLOT)],
    ['abandon', () => repo.abandonQuery('e1', 'worker-a', SLOT)],
    ['reconcile', () => repo.reconcileQuery()],
    ['adopt', () => repo.adoptQuery(60)],
  ])('%s anchors every scheduling column in the database', (_name, build) => {
    const compiled = build().compile(db);
    for (const { column, value } of setAssignments(compiled.sql)) {
      if (!SCHEDULING_COLUMNS.includes(column)) continue;
      // Clearing a lease is not an instant at all.
      if (/^null$/i.test(value)) continue;

      // The instant must come from the database: either now(), or another
      // column of the row being updated. "No bound parameter at all" is the
      // wrong rule and would fail a correct statement -- `leased_until =
      // now() + make_interval(secs => $n)` binds a *duration* from validated
      // config, which is fine; what must never be bound is an *instant*.
      expect(value, `${column} is not anchored on now() or a row column`).toMatch(/now\(\)|\br\./);

      // And no parameter in the assignment may be cast to a timestamp, which
      // is how an instant from this process would get in past the check above.
      expect(value, `${column} binds a timestamp parameter`).not.toMatch(
        /\$\d+\s*::\s*(timestamptz|timestamp|date)/i,
      );
    }
  });

  // Without this the check above degrades silently: a parser that stops early
  // inspects nothing and reports no violation, which is indistinguishable from
  // a clean statement.
  it.each([
    [
      'claim',
      () => repo.claimQuery('worker-a', 60_000, 100),
      ['scheduled_at', 'next_run_at', 'leased_until'],
    ],
    ['release', () => repo.releaseQuery('e1', 'worker-a', SLOT), ['leased_until', 'last_probe_at']],
    ['abandon', () => repo.abandonQuery('e1', 'worker-a', SLOT), ['leased_until']],
    ['reconcile', () => repo.reconcileQuery(), ['next_run_at']],
  ])('%s: every scheduling column it writes is actually examined', (_name, build, expected) => {
    const columns = setAssignments(build().compile(db).sql).map((a) => a.column);
    for (const column of expected) expect(columns).toContain(column);
  });

  it('binds no Date parameter on any statement that writes a schedule', () => {
    for (const build of [
      () => repo.claimQuery('worker-a', 60_000, 100),
      () => repo.reconcileQuery(),
      () => repo.adoptQuery(60),
    ]) {
      const compiled = build().compile(db);
      expect(compiled.parameters.some((p) => p instanceof Date)).toBe(false);
    }
  });

  it('derives every written timestamp from now()', () => {
    const claim = repo.claimQuery('w', 60_000, 10).compile(db).sql;
    expect(claim).toMatch(/leased_until\s*=\s*now\(\)/);
    // next_run_at comes off the slot, never off the clock -- NFR-2.
    expect(claim).toMatch(/next_run_at\s*=\s*r\.next_run_at/);
    expect(claim).not.toMatch(/next_run_at\s*=\s*now\(\)/);
  });
});

describe('the claim statement', () => {
  const compiled = () => repo.claimQuery('worker-a', 60_000, 100).compile(db);

  it('takes the row lock on endpoint_runtime only, and skips locked rows', () => {
    // `OF r` matters: endpoints is read but never locked, so the API writing
    // an endpoint cannot block a claim.
    expect(compiled().sql).toMatch(/FOR UPDATE OF r SKIP LOCKED/);
  });

  it('filters on enabled, due time and lease expiry', () => {
    const text = compiled().sql;
    expect(text).toMatch(/e\.enabled/);
    expect(text).toMatch(/r\.next_run_at <= now\(\)/);
    expect(text).toMatch(/r\.leased_until IS NULL OR r\.leased_until < now\(\)/);
  });

  it('orders by next_run_at so the oldest slot drains first', () => {
    expect(compiled().sql).toMatch(/ORDER\s+BY r\.next_run_at/);
  });

  it('uses floor(...)+1 rather than ceil, so the next slot is strictly future', () => {
    // At an exact multiple of the interval, ceil() returns now(): the row
    // would be immediately due again, a one-tick busy loop at the boundary.
    const text = compiled().sql;
    expect(text).toMatch(/floor\(/);
    expect(text).not.toMatch(/ceil\(/);
  });

  it('records the slot in claim_log inside the same statement', () => {
    const text = compiled().sql;
    expect(text).toMatch(/INSERT INTO claim_log \(endpoint_id, scheduled_at, worker_id\)/);
    // One statement, so the record cannot disagree with the claim or be lost
    // between the two.
    expect(text.indexOf('INSERT INTO claim_log')).toBeGreaterThan(text.indexOf('UPDATE'));
  });

  it('binds the batch size and worker id rather than interpolating them', () => {
    const { parameters } = compiled();
    expect(parameters).toContain(100);
    expect(parameters).toContain('worker-a');
  });
});

describe('the release fence', () => {
  it.each([
    ['release', (): string => repo.releaseQuery('e1', 'w1', SLOT).compile(db).sql],
    ['abandon', (): string => repo.abandonQuery('e1', 'w1', SLOT).compile(db).sql],
  ])('%s matches on both the worker and the slot', (_name, build) => {
    const text = build();
    expect(text).toMatch(/leased_by\s*=\s*\$\d/);
    expect(text).toMatch(/scheduled_at\s*=\s*\$\d/);
  });

  it('casts the bound slot back to timestamptz, so microseconds survive', () => {
    // timestamptz keeps microseconds; a JS Date holds milliseconds. Binding a
    // round-tripped Date changes the value, so the fence would match nothing
    // and no lease would ever be cleared. Measured against this database.
    for (const text of [
      repo.releaseQuery('e1', 'w1', SLOT).compile(db).sql,
      repo.abandonQuery('e1', 'w1', SLOT).compile(db).sql,
    ]) {
      expect(text).toMatch(/scheduled_at\s*=\s*\$\d+::timestamptz/);
    }
    // And the claim must hand back the exact text the fence needs.
    expect(repo.claimQuery('w', 1000, 1).compile(db).sql).toMatch(
      /scheduled_at::text AS scheduled_at/,
    );
  });

  it('binds the slot as text, never as a Date', () => {
    for (const build of [
      () => repo.releaseQuery('e1', 'w1', SLOT),
      () => repo.abandonQuery('e1', 'w1', SLOT),
    ]) {
      expect(
        build()
          .compile(db)
          .parameters.some((p) => p instanceof Date),
      ).toBe(false);
    }
  });

  it('release advances last_probe_at; abandon deliberately does not', () => {
    expect(repo.releaseQuery('e1', 'w1', SLOT).compile(db).sql).toMatch(
      /last_probe_at\s*=\s*now\(\)/,
    );
    // M6 reads last_probe_at for the UNKNOWN sweep. Moving it for a slot that
    // produced no observation makes the gap look freshly probed.
    expect(repo.abandonQuery('e1', 'w1', SLOT).compile(db).sql).not.toMatch(/last_probe_at/);
  });
});

describe('reconcile', () => {
  const text = () => repo.reconcileQuery().compile(db).sql;

  it('keys on the recorded interval, not on the slot arithmetic', () => {
    // The arithmetic form rewinds a caught-up row into the past and replays
    // its backlog one probe per tick (D26).
    expect(text()).toMatch(/r\.scheduled_interval_s IS DISTINCT FROM e\.interval_s/);
    expect(text()).not.toMatch(/next_run_at\s*<>/);
  });

  it('never touches a leased row or one that was never claimed', () => {
    expect(text()).toMatch(/r\.scheduled_at IS NOT NULL/);
    expect(text()).toMatch(/r\.leased_until IS NULL OR r\.leased_until < now\(\)/);
  });
});

describe('adopt', () => {
  it('inserts only for endpoints with no runtime row, and tolerates a race', () => {
    const text = repo.adoptQuery(60).compile(db).sql;
    expect(text).toMatch(/NOT EXISTS/);
    expect(text).toMatch(/ON CONFLICT \(endpoint_id\) DO NOTHING/);
  });

  it('bounds the jitter by the interval, so a long interval still starts soon', () => {
    expect(repo.adoptQuery(60).compile(db).sql).toMatch(/least\(e\.interval_s, \$\d/);
  });
});
