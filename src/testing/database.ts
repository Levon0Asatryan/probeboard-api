import { Pool } from 'pg';
import { createDb, type Db } from '../core/db/utils/kysely.js';

/**
 * A real PostgreSQL connection for integration tests.
 *
 * Repositories and the claim queries that arrive in M4 cannot be meaningfully
 * tested against a mock: `ON CONFLICT`, `FOR UPDATE SKIP LOCKED` and
 * transactional visibility are the behaviour under test, and a mock would only
 * assert that we called the mock.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Integration tests need TEST_DATABASE_URL or DATABASE_URL. ' +
        'Start one with: docker compose up -d postgres',
    );
  }
  return url;
}

export function createTestPool(): Pool {
  return new Pool({ connectionString: testDatabaseUrl(), max: 5 });
}

export interface TestDb {
  db: Db;
  pool: Pool;
  close: () => Promise<void>;
}

export function connectTestDb(): TestDb {
  const pool = createTestPool();
  // Integration tests must not die on a dropped idle connection.
  pool.on('error', () => undefined);

  const db = createDb(pool);
  return { db, pool, close: () => db.destroy() };
}

/**
 * Empties every table the application owns, leaving the schema and the
 * migration registry alone.
 *
 * TRUNCATE rather than DELETE so identity columns restart, and CASCADE so
 * foreign keys do not dictate the order — which would otherwise need updating
 * every time a table is added.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
