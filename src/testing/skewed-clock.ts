/**
 * Runs `fn` with this process's clock an hour behind the database's.
 *
 * Only `Date` is faked, so timers, the driver's sockets and PostgreSQL's own
 * `now()` are untouched. A write that stamps a timestamp from the process
 * clock instead of the database's lands an hour in the past -- deterministic,
 * where a real skew between a host and a Docker VM is a few milliseconds and
 * only sometimes (#71's flaky `updated_at` test).
 */
import { vi } from 'vitest';

export async function withProcessClockBehind<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() - 3_600_000);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Whether a row's `updated_at` is strictly after its `created_at`, compared
 * by PostgreSQL at microsecond precision.
 *
 * Not on the `Date`s the driver returns: `pg` parses `timestamptz` into a JS
 * `Date`, which keeps milliseconds only, so two statements in the same
 * millisecond read back equal and a strict comparison fails -- 9 runs in 25
 * with no sleep between insert and update. The sleep the old test used only
 * hid that, and let a process-vs-database clock skew through instead.
 */
export async function movedForward(
  pool: { query: (text: string, values: unknown[]) => Promise<{ rows: { moved: boolean }[] }> },
  table: 'users' | 'services' | 'endpoints',
  id: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT updated_at > created_at AS moved FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0].moved;
}
