/**
 * One-time repair of `json_path` assertions stored before the supported
 * grammar existed.
 *
 *   npm run audit:json-path-assertions        # a checkout, with dev deps
 *   npm run audit:json-path-assertions:dist   # the shipped image
 *
 * Two entries because the operator step runs where the audit is deployed,
 * and the runtime image cannot run the first one: the Dockerfile copies only
 * `dist/` and installs with `npm ci --omit=dev`, so neither this `.ts` file
 * nor the dev-only `tsx` binary exists there. The `:dist` entry runs the
 * compiled `dist/.../audit-json-path-assertions.cli.js`, which the build
 * does emit, the same way `start:api` runs `dist/api/main.js`. Inside a
 * container with no npm wrapper, that is:
 *
 *   docker compose exec api node dist/core/db/maintenance/audit-json-path-assertions.cli.js
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
 *
 * The line is written, flushed and error-checked *before* the removal that
 * produced it commits (D60), so a broken pipe or a full buffer keeps the
 * assertion in the database instead of destroying it silently.
 */
import { Pool } from 'pg';
import { loadConfig } from '../../config/index.js';
import { describeError } from '../../errors/describe.js';
import { createDb } from '../utils/kysely.js';
import { auditJsonPathAssertions } from './audit-json-path-assertions.js';

/**
 * Writes one line to stdout, resolving only once the stream has accepted it
 * and rejecting if the write fails.
 *
 * `process.stdout.write()`'s return value describes buffering, not delivery:
 * it comes back `false` on backpressure with the data still queued, and an
 * `EPIPE` against a closed pipe surfaces asynchronously, after the call has
 * already returned. Treating that as persistence is what let a removal
 * outlive its own recovery record. The callback form is the only way to
 * await the flush and observe the error, and the audit turns a rejection
 * here into a rolled-back removal (D60).
 */
function writeLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
  const db = createDb(pool);

  try {
    // Written and flushed inside the removal's own transaction, so an
    // assertion is never deleted before the line that can restore it has
    // actually reached stdout. A failed write rejects, the transaction rolls
    // back, and the run stops with the row intact (D60).
    //
    // `process.stdout` rather than `console.log`: this output is the
    // recovery record an operator keeps, so it belongs on stdout where it
    // can be redirected to a file, and the lint rule reserves `console` for
    // errors.
    //
    // A count comes back, not the records: holding every removal until the
    // run finished was itself unbounded on the large deployments the audit
    // matters most on (D61).
    const removedCount = await auditJsonPathAssertions(db, {
      onRemoved: (entry) => writeLine(`${JSON.stringify(entry)}\n`),
    });
    await writeLine(
      removedCount === 0
        ? 'audit: no unsupported json_path assertions found\n'
        : `audit: removed ${String(removedCount)} unsupported json_path assertion(s)\n`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(`audit failed: ${describeError(err)}`);
  process.exit(1);
});
