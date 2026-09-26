import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../../testing/database.js';
import { isDatabaseUnavailable } from './database-unavailable.js';

/**
 * Each shape the classifier lists, produced by the real driver against a real
 * PostgreSQL (or a real socket that behaves like an unreachable one) rather
 * than built by hand: the rule for a table of external signals, after #49
 * found three rows that synthetic errors had passed and reality did not.
 */

const url = testDatabaseUrl();
let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

/** A pool that swallows idle-client errors, as `createPool` does. */
function quietPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('error', () => undefined);
  return pool;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the operation to fail');
}

describe('isDatabaseUnavailable, against the real driver', () => {
  it('recognises a refused connection (ECONNREFUSED)', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));

    const pool = quietPool({ host: '127.0.0.1', port, user: 'u', database: 'd' });
    const err = await failure(() => pool.query('SELECT 1'));
    await pool.end();

    expect((err as { code?: string }).code).toBe('ECONNREFUSED');
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('recognises a host that does not resolve (ENOTFOUND or EAI_AGAIN)', async () => {
    // What a stopped compose `postgres` service looks like: its name leaves
    // Docker's DNS. `.invalid` never resolves (RFC 6761).
    const pool = quietPool({ host: 'postgres.invalid', user: 'u', database: 'd' });
    const err = await failure(() => pool.query('SELECT 1'));
    await pool.end();

    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain((err as { code?: string }).code);
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('recognises a connect that never completes (the pool connection timeout)', async () => {
    // Accepts TCP and never speaks, so the driver waits for the server's
    // first message until connectionTimeoutMillis.
    const accepted: net.Socket[] = [];
    const mute = net.createServer((socket) => accepted.push(socket));
    await new Promise<void>((r) => mute.listen(0, '127.0.0.1', r));
    const port = (mute.address() as net.AddressInfo).port;

    const pool = quietPool({
      host: '127.0.0.1',
      port,
      user: 'u',
      database: 'd',
      connectionTimeoutMillis: 200,
    });
    const err = await failure(() => pool.query('SELECT 1'));
    // `close()` waits for every accepted socket, and nothing else ends these.
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((r) => mute.close(() => r()));
    await pool.end();

    expect((err as Error).message).toBe('Connection terminated due to connection timeout');
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('recognises a backend terminated mid-query (57P01)', async () => {
    const client = new pg.Client({ connectionString: url });
    client.on('error', () => undefined);
    await client.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

    const running = failure(() => client.query('SELECT pg_sleep(30)'));
    // Barrier on observable state: the sleep is running before it is killed.
    for (;;) {
      const { rows } = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND query LIKE 'SELECT pg_sleep%' AND state = 'active'`,
        [pid],
      );
      if (rows.length > 0) break;
    }
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    const err = await running;
    await client.end().catch(() => undefined);

    expect((err as { code?: string }).code).toBe('57P01');
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('recognises a query on a client whose connection already died', async () => {
    const client = new pg.Client({ connectionString: url });
    const died = new Promise<void>((r) => client.once('error', () => r()));
    await client.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await died;

    const err = await failure(() => client.query('SELECT 1'));
    await client.end().catch(() => undefined);

    expect((err as Error).message).toBe(
      'Client has encountered a connection error and is not queryable',
    );
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('does not call a real query error an outage', async () => {
    // The control: the database answered, and said our SQL was wrong. That
    // is a bug, and must stay a 500.
    for (const sql of ['SELECT * FROM no_such_table', "SELECT 'x'::uuid"]) {
      const err = await failure(() => admin.query(sql));
      expect(isDatabaseUnavailable(err), sql).toBe(false);
    }
  });
});
