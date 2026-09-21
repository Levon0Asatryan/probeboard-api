import { Client, type Pool, type PoolClient, type QueryArrayConfig, type QueryConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret, parseHeaderEncryptionKey } from '../../../core/crypto/header-cipher.js';
import { loadConfig } from '../../../core/config/index.js';
import { createDb } from '../../../core/db/utils/kysely.js';
import { connectTestDb, testDatabaseUrl, truncateAll } from '../../../testing/database.js';
import { MonitorLoaderService, MonitorNotFoundError } from './monitor-loader.service.js';

const HEADER_KEY = 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=';
const cfg = loadConfig({
  DATABASE_URL: testDatabaseUrl(),
  HEADER_ENCRYPTION_KEY: HEADER_KEY,
});
const key = parseHeaderEncryptionKey(HEADER_KEY);

const { db, pool, close } = connectTestDb();
const loader = new MonitorLoaderService({ kysely: db } as never, cfg);

let userId: string;
let serviceId: string;
let endpointId: string;

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(pool);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('l@example.com', 'x') RETURNING id`,
  );
  userId = user.rows[0].id;
  const service = await pool.query<{ id: string }>(
    `INSERT INTO services (user_id, name, base_url) VALUES ($1, 'svc', 'https://origin-a.test')
     RETURNING id`,
    [userId],
  );
  serviceId = service.rows[0].id;
  const endpoint = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (service_id, user_id, method, path, interval_s, timeout_ms, max_redirects)
     VALUES ($1, $2, 'GET', '/health', 60, 10000, 5) RETURNING id`,
    [serviceId, userId],
  );
  endpointId = endpoint.rows[0].id;
});

async function addHeader(opts: {
  scope: 'service' | 'endpoint';
  name: string;
  value: string;
  secret?: boolean;
}): Promise<void> {
  const serviceCol = opts.scope === 'service' ? serviceId : null;
  const endpointCol = opts.scope === 'endpoint' ? endpointId : null;
  if (opts.secret) {
    const enc = encryptSecret(opts.value, key);
    await pool.query(
      `INSERT INTO headers (service_id, endpoint_id, name, is_secret, secret_ciphertext, secret_iv, secret_auth_tag)
       VALUES ($1, $2, $3, true, $4, $5, $6)`,
      [serviceCol, endpointCol, opts.name, enc.ciphertext, enc.iv, enc.authTag],
    );
  } else {
    await pool.query(
      `INSERT INTO headers (service_id, endpoint_id, name, is_secret, value) VALUES ($1, $2, $3, false, $4)`,
      [serviceCol, endpointCol, opts.name, opts.value],
    );
  }
}

describe('MonitorLoaderService.load: assembly', () => {
  it('joins base_url and path into the effective url', async () => {
    const config = await loader.load(endpointId);
    expect(config.url).toBe('https://origin-a.test/health');
    expect(config.monitorId).toBe(endpointId);
    expect(config.method).toBe('GET');
  });

  it('decrypts a secret header and leaves a plain one as-is', async () => {
    await addHeader({ scope: 'service', name: 'X-Plain', value: 'plain-value' });
    await addHeader({ scope: 'service', name: 'X-Secret', value: 'top-secret', secret: true });
    const config = await loader.load(endpointId);
    expect(config.headers['X-Plain']).toBe('plain-value');
    expect(config.headers['X-Secret']).toBe('top-secret');
  });

  it('an endpoint header overrides a service header of the same name, case-insensitively (B-4)', async () => {
    await addHeader({ scope: 'service', name: 'X-Auth', value: 'service-value' });
    await addHeader({ scope: 'endpoint', name: 'x-auth', value: 'endpoint-value' });
    const config = await loader.load(endpointId);
    const value = config.headers['x-auth'] ?? config.headers['X-Auth'];
    expect(value).toBe('endpoint-value');
    expect(Object.keys(config.headers)).toHaveLength(1);
  });

  it('throws MonitorNotFoundError for an endpoint id that does not exist', async () => {
    await expect(loader.load('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      MonitorNotFoundError,
    );
  });
});

/**
 * A deferred gate a wrapped `pg` client's `query` can wait at, and a test can
 * open from outside. `reached` resolves the instant the intercepted query is
 * about to run and blocked -- no polling, because the interception itself is
 * the synchronization point.
 */
function makeGate(): { reached: Promise<void>; waitAtGate: () => Promise<void>; open: () => void } {
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let releaseGate!: () => void;
  const gatePromise = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    reached,
    waitAtGate: async () => {
      signalReached();
      await gatePromise;
    },
    open: releaseGate,
  };
}

/**
 * Wraps a real `pg.Pool` so the first query whose text matches `matcher`,
 * issued on any client this test checks out, is held at `gate` before
 * running. Everything else -- `BEGIN`, `SET TRANSACTION ISOLATION LEVEL`,
 * every other statement -- runs through untouched.
 *
 * This is the barrier itself: it lets a second, independent connection
 * commit a competing change at the exact instant between two of the loader's
 * own reads, which is the only way `REPEATABLE READ`'s guarantee is actually
 * exercised rather than assumed.
 */
type QueryArgs = [string | QueryConfig | QueryArrayConfig, ...unknown[]];

function textOf(first: QueryArgs[0]): string | undefined {
  return typeof first === 'string' ? first : first.text;
}

function wrapPoolWithGate(
  pool: Pool,
  matcher: (sql: string) => boolean,
  gate: ReturnType<typeof makeGate>,
): Pool {
  let armed = true;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          const originalQuery = client.query.bind(client) as (
            ...args: QueryArgs
          ) => Promise<unknown>;
          client.query = (async (...queryArgs: QueryArgs) => {
            const text = textOf(queryArgs[0]);
            if (armed && text && matcher(text)) {
              armed = false;
              await gate.waitAtGate();
            }
            return originalQuery(...queryArgs);
          }) as typeof client.query;
          return client;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

describe('MonitorLoaderService.load: REPEATABLE READ (D22)', () => {
  it(
    'assembles the config wholly from the snapshot at transaction start, ' +
      'even when a base_url rotation and a secret-header rotation both ' +
      'commit between the endpoint read and the service/headers reads',
    async () => {
      await addHeader({ scope: 'service', name: 'X-Api-Key', value: 'old-secret', secret: true });

      const gate = makeGate();
      const wrappedPool = wrapPoolWithGate(pool, (sql) => /from "services"/i.test(sql), gate);
      const gatedDb = createDb(wrappedPool);
      const gatedLoader = new MonitorLoaderService({ kysely: gatedDb } as never, cfg);

      const loadPromise = gatedLoader.load(endpointId);
      await gate.reached;

      // Committed on an independent connection, strictly between the
      // loader's endpoint read and its service read.
      const barrier = new Client({ connectionString: testDatabaseUrl() });
      await barrier.connect();
      await barrier.query('UPDATE services SET base_url = $1 WHERE id = $2', [
        'https://origin-b.test',
        serviceId,
      ]);
      const rotated = encryptSecret('new-secret', key);
      await barrier.query(
        `UPDATE headers SET secret_ciphertext = $1, secret_iv = $2, secret_auth_tag = $3
         WHERE service_id = $4 AND name = 'X-Api-Key'`,
        [rotated.ciphertext, rotated.iv, rotated.authTag, serviceId],
      );
      await barrier.end();

      gate.open();
      const config = await loadPromise;

      // Wholly the old service, never the old url with the new credential.
      expect(config.url).toBe('https://origin-a.test/health');
      expect(config.headers['X-Api-Key']).toBe('old-secret');

      // Not destroyed: `gatedDb` wraps a Proxy over the shared `pool`, and
      // Kysely's `destroy()` ends the underlying `pg.Pool` -- which every
      // other test in this file, and `afterAll`'s `close()`, still needs.

      // The transaction that ran without the barrier now sees the committed
      // rotation, proving the snapshot -- not something about this endpoint
      // -- is what changed.
      const after = await loader.load(endpointId);
      expect(after.url).toBe('https://origin-b.test/health');
      expect(after.headers['X-Api-Key']).toBe('new-secret');
    },
  );
});
