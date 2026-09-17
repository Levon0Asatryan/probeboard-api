/**
 * One-time repair of `json_path` assertions stored before the supported
 * grammar existed.
 *
 *   npm run audit:json-path-assertions
 *
 * Run once against each deployed database after the grammar constraint
 * ships and before the scheduler starts probing (docs/m3-plan.md D48/D50).
 * Nothing runs it automatically: it is not a migration, so `npm run migrate`
 * does not pick it up, and no boot path invokes it. Re-running is safe.
 *
 * Split from the function it calls for the same reason `migrator/cli.ts` is
 * split from `runner.ts`: tests import the function, and importing an
 * entrypoint would run it.
 *
 * Each removal is printed as one JSON line. That output is the recovery
 * record -- an operator rewrites the path into the supported subset and
 * re-adds the assertion through the normal API.
 */
import { Pool } from 'pg';
import { loadConfig } from '../../config/index.js';
import { describeError } from '../../errors/describe.js';
import { createDb } from '../utils/kysely.js';
import { auditJsonPathAssertions } from './audit-json-path-assertions.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
  const db = createDb(pool);

  try {
    // Printed as each removal commits, not collected and printed at the end:
    // the removal is permanent once its own transaction commits, so an
    // interrupted run must still leave a record of every assertion it has
    // already destroyed.
    //
    // `process.stdout` rather than `console.log`: this output is the
    // recovery record an operator keeps, so it belongs on stdout where it
    // can be redirected to a file, and the lint rule reserves `console` for
    // errors.
    const removed = await auditJsonPathAssertions(db, {
      onRemoved: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
    });
    process.stdout.write(
      removed.length === 0
        ? 'audit: no unsupported json_path assertions found\n'
        : `audit: removed ${String(removed.length)} unsupported json_path assertion(s)\n`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(`audit failed: ${describeError(err)}`);
  process.exit(1);
});
