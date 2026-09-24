import { Pool } from 'pg';
import { loadConfig } from '../core/config/index.js';
import { up } from '../core/db/migrator/runner.js';
import { createDb } from '../core/db/utils/kysely.js';
import { PartitionService } from '../worker/storage/services/partition.service.js';
import { testDatabaseUrl } from './database.js';

/**
 * Brings the test database up to date once, before the integration suite.
 *
 * It uses the application's own migration runner rather than a test-only
 * schema, so the tests run against the schema that actually ships -- and the
 * application's own `PartitionService`, because the partitioned tables have
 * no partitions until something creates them and there is deliberately no
 * default partition to fall back on.
 */
export default async function setup(): Promise<void> {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 2 });
  try {
    await up(pool, () => undefined);
    const cfg = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
    });
    await new PartitionService({ kysely: createDb(pool) } as never, cfg).ensure(new Date(), {
      wait: true,
    });
  } finally {
    await pool.end();
  }
}
