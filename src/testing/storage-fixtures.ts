import type { Pool } from 'pg';

/** A user, service and endpoint: the minimum a `probe_results` row is read against. */
export async function createEndpoint(
  pool: Pool,
  email: string,
  intervalS = 60,
): Promise<{ userId: string; endpointId: string }> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  const userId = user.rows[0].id;
  const service = await pool.query<{ id: string }>(
    `INSERT INTO services (user_id, name, base_url) VALUES ($1, 's', $2) RETURNING id`,
    [userId, `http://${email.replace(/[^a-z0-9]/gi, '-')}.invalid`],
  );
  const endpoint = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     VALUES ($1, $2, 'GET', '/p', $3, 5000, 5) RETURNING id`,
    [service.rows[0].id, userId, intervalS],
  );
  return { userId, endpointId: endpoint.rows[0].id };
}

export interface RawRow {
  endpointId: string;
  startedAt: string;
  outcome: 'up' | 'down' | 'degraded' | 'unknown';
  intervalS?: number;
  totalMs?: number;
  /** `null` = the endpoint never produced response headers. */
  ttfbMs?: number | null;
}

/**
 * Inserts raw results **in one transaction per call** -- so the rows share one
 * `insert_xid`, exactly as a single committed write does. Call it once per row
 * to give each row its own.
 */
export async function insertRaw(pool: Pool, rows: RawRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) await insertRawOn(client, r);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function insertRawOn(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  r: RawRow,
): Promise<void> {
  await client.query(
    `INSERT INTO probe_results (endpoint_id, started_at, scheduled_at, interval_s, outcome,
                                total_ms, ttfb_ms, redirects, truncated, worker_id, attempt_id)
     VALUES ($1, $2::timestamptz, $2::timestamptz, $3, $4, $5, $6, 0, false, 'fixture', gen_random_uuid())`,
    [
      r.endpointId,
      r.startedAt,
      r.intervalS ?? 60,
      r.outcome,
      r.totalMs ?? 40,
      r.ttfbMs === undefined ? Math.floor((r.totalMs ?? 40) / 2) : r.ttfbMs,
    ],
  );
}

/** Drops every partition whose name carries `_p<year>`: leaves other tests' dates alone. */
export async function dropPartitionsOfYear(pool: Pool, year: number): Promise<void> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relname ~ $1 AND relkind = 'r'`,
    [`_p${year}[0-9]{2,4}$`],
  );
  for (const r of rows) await pool.query(`DROP TABLE IF EXISTS "${r.relname}"`);
}
