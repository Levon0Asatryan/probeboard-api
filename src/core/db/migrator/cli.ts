/**
 * Migration CLI.
 *
 *   tsx src/core/db/migrator/cli.ts up | down
 *
 * Covered by the CI `migrations` job against a real PostgreSQL -- apply, no-op,
 * roll back, re-apply -- rather than by unit tests, which would exercise a
 * mocked pg client.
 */
import { loadConfig } from '../../config/index.js';
import { describeError } from '../../errors/describe.js';
import { createPool } from '../utils/pool.js';
import { down, up } from './runner.js';

async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`unknown direction "${direction}" (expected "up" or "down")`);
  }

  const cfg = loadConfig();
  // The shared helper rather than a bare `new Pool`, for the reason spelled
  // out in `utils/pool.ts`: an unhandled `error` event on the pool is a fatal
  // uncaught exception in Node, so an idle connection dying mid-migration
  // would kill this process outright instead of failing through
  // `main().catch()` and the `finally` that closes the pool (D64).
  const pool = createPool(cfg, (message, fields) => {
    console.error(`${message}: ${fields.cause}`);
  });

  try {
    await (direction === 'up' ? up(pool, console.log) : down(pool, console.log));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
