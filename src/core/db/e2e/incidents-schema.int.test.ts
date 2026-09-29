import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, truncateAll } from '../../../testing/database.js';

/**
 * Every constraint migration 0011 adds, each branch rejected on its own
 * (probeboard rule #14: a constraint tested only on its happy path is a
 * comment). These are what hold the evaluator's invariants when its code is
 * wrong -- the state machine's bugs become a failed pass, not a bad row.
 */
const { pool, close } = connectTestDb();
afterAll(close);

let userId: string;
let otherUserId: string;
let serviceId: string;
let endpointId: string;
let otherServiceId: string;
let otherEndpointId: string;

async function owner(email: string): Promise<{ user: string; service: string; endpoint: string }> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  const service = await pool.query<{ id: string }>(
    `INSERT INTO services (user_id, name, base_url) VALUES ($1, 's', 'http://' || $2 || '.test') RETURNING id`,
    [user.rows[0].id, email.split('@')[0]],
  );
  const endpoint = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     VALUES ($1, $2, 'GET', '/', 60, 5000, 5) RETURNING id`,
    [service.rows[0].id, user.rows[0].id],
  );
  return { user: user.rows[0].id, service: service.rows[0].id, endpoint: endpoint.rows[0].id };
}

beforeEach(async () => {
  await truncateAll(pool);
  const a = await owner('a@example.com');
  const b = await owner('b@example.com');
  [userId, serviceId, endpointId] = [a.user, a.service, a.endpoint];
  [otherUserId, otherServiceId, otherEndpointId] = [b.user, b.service, b.endpoint];
});

describe('maintenance_windows', () => {
  const insert = (u: string, svc: string | null, ep: string | null, from = '10:00', to = '11:00') =>
    pool.query(
      `INSERT INTO maintenance_windows (user_id, service_id, endpoint_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [u, svc, ep, `2026-09-29 ${from}Z`, `2026-09-29 ${to}Z`],
    );

  it('accepts a window on a service, and one on an endpoint, of the same owner', async () => {
    await insert(userId, serviceId, null);
    await insert(userId, null, endpointId);
  });

  it('rejects both targets, and neither', async () => {
    await expect(insert(userId, serviceId, endpointId)).rejects.toThrow(
      /maintenance_windows_one_target/,
    );
    await expect(insert(userId, null, null)).rejects.toThrow(/maintenance_windows_one_target/);
  });

  it('rejects an empty or inverted window', async () => {
    await expect(insert(userId, serviceId, null, '11:00', '11:00')).rejects.toThrow(
      /maintenance_windows_ordered/,
    );
    await expect(insert(userId, serviceId, null, '11:00', '10:00')).rejects.toThrow(
      /maintenance_windows_ordered/,
    );
  });

  it("rejects a window naming another owner's service or endpoint (rule #10)", async () => {
    // The writer suppresses incidents for whatever a window names; storing one
    // across owners would let a user silence someone else's monitor.
    await expect(insert(userId, otherServiceId, null)).rejects.toThrow(
      /maintenance_windows_service_owner_fkey/,
    );
    await expect(insert(userId, null, otherEndpointId)).rejects.toThrow(
      /maintenance_windows_endpoint_owner_fkey/,
    );
    await expect(insert(otherUserId, null, endpointId)).rejects.toThrow(
      /maintenance_windows_endpoint_owner_fkey/,
    );
  });

  it('goes with its target', async () => {
    await insert(userId, null, endpointId);
    await insert(userId, serviceId, null);
    await pool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
    const { rows } = await pool.query(`SELECT 1 FROM maintenance_windows`);
    expect(rows).toHaveLength(0);
  });
});

describe('endpoint_health', () => {
  const insert = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      endpoint_id: endpointId,
      state: 'up',
      state_since: '2026-09-29 10:00Z',
      consecutive_failures: 0,
      run_started_at: null,
      ...over,
    };
    const cols = Object.keys(row);
    return pool.query(
      `INSERT INTO endpoint_health (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  it('accepts every observed state', async () => {
    for (const state of ['up', 'degraded', 'pending', 'down', 'unknown']) {
      await truncateAll(pool);
      await insert({ state });
    }
  });

  it('refuses the configuration states: paused and maintenance are derived on read', async () => {
    for (const state of ['paused', 'maintenance']) {
      await expect(insert({ state })).rejects.toThrow(/endpoint_health_observed_state/);
    }
  });

  it('holds the run shape both ways: failures without a start, and a start without failures', async () => {
    await expect(insert({ consecutive_failures: 2, run_started_at: null })).rejects.toThrow(
      /endpoint_health_run_shape/,
    );
    await expect(
      insert({ consecutive_failures: 0, run_started_at: '2026-09-29 10:00Z' }),
    ).rejects.toThrow(/endpoint_health_run_shape/);
    await insert({ consecutive_failures: 2, run_started_at: '2026-09-29 10:00Z' });
  });

  it('refuses negative counters', async () => {
    await expect(insert({ consecutive_successes: -1 })).rejects.toThrow(/check constraint/);
  });

  it('holds a long healthy run: integer, not smallint (plan C2)', async () => {
    // 11.4 days of successes at 30 s passes a smallint's 32,767.
    await insert({ consecutive_successes: 40_000 });
  });
});

describe('incidents', () => {
  const insert = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      endpoint_id: endpointId,
      service_id: serviceId,
      user_id: userId,
      opened_at: '2026-09-29 10:01Z',
      confirmed_at: '2026-09-29 10:03Z',
      failures_to_open: 3,
      cause_class: 'connection_refused',
      closed_at: null,
      close_confirmed_at: null,
      ...over,
    };
    const cols = Object.keys(row);
    return pool.query<{ id: string }>(
      `INSERT INTO incidents (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id`,
      Object.values(row),
    );
  };
  const closed = { closed_at: '2026-09-29 10:10Z', close_confirmed_at: '2026-09-29 10:11Z' };

  it('allows one open incident per endpoint, and a new one once it closes', async () => {
    const first = await insert();
    await expect(
      insert({ opened_at: '2026-09-29 10:05Z', confirmed_at: '2026-09-29 10:06Z' }),
    ).rejects.toThrow(/incidents_one_open_idx/);
    // Another endpoint is unaffected.
    await insert({ endpoint_id: otherEndpointId });
    await pool.query(
      `UPDATE incidents SET closed_at = '2026-09-29 10:10Z', close_confirmed_at = '2026-09-29 10:11Z' WHERE id = $1`,
      [first.rows[0].id],
    );
    await insert({ opened_at: '2026-09-29 10:20Z', confirmed_at: '2026-09-29 10:22Z' });
  });

  it('refuses a confirmation before the opening probe', async () => {
    await expect(insert({ confirmed_at: '2026-09-29 10:00Z' })).rejects.toThrow(
      /incidents_confirmed_after_open/,
    );
  });

  it('refuses a half-closed incident, either half', async () => {
    await expect(insert({ closed_at: closed.closed_at })).rejects.toThrow(/incidents_close_pair/);
    await expect(insert({ close_confirmed_at: closed.close_confirmed_at })).rejects.toThrow(
      /incidents_close_pair/,
    );
  });

  it('refuses a close at or before the open, and a confirmation before the close', async () => {
    await expect(
      insert({ closed_at: '2026-09-29 10:01Z', close_confirmed_at: '2026-09-29 10:02Z' }),
    ).rejects.toThrow(/incidents_close_order/);
    await expect(
      insert({ closed_at: '2026-09-29 10:10Z', close_confirmed_at: '2026-09-29 10:09Z' }),
    ).rejects.toThrow(/incidents_close_order/);
    await insert(closed);
  });
});

describe('notification_outbox', () => {
  async function incident(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO incidents (endpoint_id, service_id, user_id, opened_at, confirmed_at, failures_to_open, cause_class)
       VALUES ($1, $2, $3, '2026-09-29 10:01Z', '2026-09-29 10:03Z', 3, 'dns_failure') RETURNING id`,
      [endpointId, serviceId, userId],
    );
    return rows[0].id;
  }
  const enqueue = (incidentId: string, kind: string) =>
    pool.query(
      `INSERT INTO notification_outbox (incident_id, kind, user_id, service_id) VALUES ($1, $2, $3, $4)`,
      [incidentId, kind, userId, serviceId],
    );

  it('holds one row per incident and kind (E-1, "sent once")', async () => {
    const id = await incident();
    await enqueue(id, 'incident_open');
    await expect(enqueue(id, 'incident_open')).rejects.toThrow(/notification_outbox_once/);
    await enqueue(id, 'incident_close');
  });

  it('refuses a row for an incident that does not exist, and goes with the incident', async () => {
    await expect(enqueue('00000000-0000-4000-8000-000000000000', 'incident_open')).rejects.toThrow(
      /foreign key/,
    );
    const id = await incident();
    await enqueue(id, 'incident_open');
    await pool.query(`DELETE FROM incidents WHERE id = $1`, [id]);
    expect((await pool.query(`SELECT 1 FROM notification_outbox`)).rows).toHaveLength(0);
  });
});

describe('the evaluator watermark', () => {
  it('exists beside the rollup watermark (the migration seeds it; truncateAll restores it)', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM rollup_state ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['incident_evaluator', 'probe_results']);
  });
});
