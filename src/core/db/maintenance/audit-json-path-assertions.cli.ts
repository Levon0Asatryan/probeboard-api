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
 * **stdout carries those records and nothing else** (D63). D51 tells an
 * operator to parse these lines, so the stream has to be valid JSONL end to
 * end:
 *
 *   npm run audit:json-path-assertions:dist > removed.jsonl
 *
 * must produce a file every line of which parses. The human-readable summary
 * therefore goes to stderr, where it is still visible on a terminal but
 * cannot corrupt a redirected recovery file.
 *
 * The line is written, flushed and error-checked *before* the removal that
 * produced it commits (D60), so a broken pipe or a full buffer keeps the
 * assertion in the database instead of destroying it silently.
 */
import { loadConfig } from '../../config/index.js';
import { describeError } from '../../errors/describe.js';
import { createDb } from '../utils/kysely.js';
import { createPool } from '../utils/pool.js';
import { auditJsonPathAssertions } from './audit-json-path-assertions.js';
import { writeLineWithDeadline } from './stream-write.js';

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
 *
 * Bounded by `AUDIT_WRITE_TIMEOUT_MS`, because the await happens inside the
 * removal's transaction: a reader that stops consuming without closing the
 * pipe produces backpressure rather than `EPIPE`, the callback never fires,
 * and an unbounded wait would hold `FOR UPDATE` on that endpoint row forever
 * (D66).
 */
function writeLine(line: string, timeoutMs: number): Promise<void> {
  return writeLineWithDeadline(process.stdout, line, timeoutMs);
}

/**
 * The same, to stderr: human-readable status that must never land in the
 * recovery stream (D63).
 *
 * Not `console.error`, which is fire-and-forget: the process can exit with
 * the summary still queued. This is status rather than data, so a failure to
 * write it is not worth aborting a completed repair over -- but it is worth
 * waiting for.
 */
function writeErrLine(line: string, timeoutMs: number): Promise<void> {
  return writeLineWithDeadline(process.stderr, line, timeoutMs);
}

/** The last stream failure observed, for context when the run reports. */
let lastStreamError: string | undefined;

/**
 * Deadline for the final failure diagnostic (D68).
 *
 * A constant rather than `AUDIT_WRITE_TIMEOUT_MS`, because this write runs on
 * the path where `loadConfig()` itself may have thrown — there may be no
 * config to read a timeout from.
 */
const REPORT_WRITE_TIMEOUT_MS = 10_000;

/**
 * Attaches `error` listeners to stdout and stderr for the duration of the
 * run, returning the function that removes them again.
 *
 * A failing writable does **two** things: it passes the error to the `write`
 * callback *and* emits an `error` event. `process.stdout` has no listener of
 * its own, so Node escalates that event into a fatal uncaught exception —
 * and it does so before the promise rejected by the callback can reach
 * Kysely's rollback and `main().catch()`. The precise failure D60 exists to
 * survive (a broken pipe, a full device, while a removal is uncommitted)
 * would therefore bypass the rollback it is meant to trigger, leaving the
 * assertion deleted anyway. That is the case this closes (D65).
 *
 * Not a swallowed failure: the same error still arrives through the `write`
 * callback, rejects `writeLine`, rolls the removal back and is reported.
 * These listeners only stop the duplicate event from pre-empting that path,
 * and they record it for context.
 *
 * Scoped rather than global — removed when the run ends — so they can never
 * mask a stream failure outside it.
 */
function absorbStreamErrors(): () => void {
  const note =
    (stream: string) =>
    (err: unknown): void => {
      lastStreamError = `${stream}: ${describeError(err)}`;
    };
  const onStdout = note('stdout');
  const onStderr = note('stderr');
  process.stdout.on('error', onStdout);
  process.stderr.on('error', onStderr);

  return () => {
    process.stdout.off('error', onStdout);
    process.stderr.off('error', onStderr);
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // The shared helper, not a bare `new Pool`: `pg` emits `error` on the pool
  // when an *idle* connection dies (a restart, a failover, a dropped link),
  // and Node escalates an unhandled `error` event into a fatal uncaught
  // exception. Without the listener `createPool` attaches, a database restart
  // between two of this audit's per-row transactions would kill the process
  // outright rather than surfacing through `main().catch()` and the `finally`
  // that closes the pool -- during a destructive repair, and bypassing the
  // orderly shutdown entirely (D64).
  const pool = createPool(cfg, (message, fields) => {
    console.error(`${message}: ${fields.cause}`);
  });
  const db = createDb(pool);
  const releaseStreams = absorbStreamErrors();

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
      onRemoved: (entry) => writeLine(`${JSON.stringify(entry)}\n`, cfg.AUDIT_WRITE_TIMEOUT_MS),
    });
    // stderr, not stdout: stdout is the recovery stream an operator redirects
    // to a file and parses line by line (D51), so a trailing line of prose
    // would make that file invalid JSONL and break a restoration tool at
    // exactly the moment it is needed -- right after a destructive run (D63).
    //
    // Its failure is not the audit's failure (D67). By this point every
    // removal and every recovery record has already committed, so a stderr
    // that is closed or has stopped consuming would otherwise make a fully
    // successful destructive repair report `audit failed` and exit non-zero
    // -- telling an operator the repair did not happen when it did, and
    // inviting a re-run. The database state and the stdout records are what
    // actually happened; this line only describes them.
    //
    // Deliberately not logged on failure: stderr is precisely the stream that
    // just failed, so there is no channel left to report it through.
    try {
      await writeErrLine(
        removedCount === 0
          ? 'audit: no unsupported json_path assertions found\n'
          : `audit: removed ${String(removedCount)} unsupported json_path assertion(s)\n`,
        cfg.AUDIT_WRITE_TIMEOUT_MS,
      );
    } catch {
      // Intentionally ignored -- see above. The repair stands.
    }
  } finally {
    await db.destroy();
    releaseStreams();
  }
}

main().catch(async (err: unknown) => {
  // stderr, so this still reports when it was stdout that failed. The stream
  // error is appended when one was seen, because a rejected write and a dead
  // pipe read very differently to an operator deciding whether the repair ran
  // (D65).
  const streamDetail = lastStreamError === undefined ? '' : ` (${lastStreamError})`;

  try {
    // Awaited, and `process.exitCode` rather than `process.exit(1)`:
    // `console.error` on a pipe or a file is asynchronous, so exiting
    // immediately can terminate the process with the diagnostic still queued.
    // On the stdout-failure path this line is the operator's only statement of
    // whether the destructive repair rolled back, so it has to reach the
    // stream before the process ends. Setting the exit code instead lets the
    // streams drain on their own (D68).
    await writeErrLine(
      `audit failed: ${describeError(err)}${streamDetail}\n`,
      REPORT_WRITE_TIMEOUT_MS,
    );
  } catch {
    // stderr is unusable too, so there is no channel left to explain this
    // through; the non-zero exit status is the only signal remaining.
  }

  process.exitCode = 1;
});
