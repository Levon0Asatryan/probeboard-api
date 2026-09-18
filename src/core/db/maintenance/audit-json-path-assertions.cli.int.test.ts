import { spawn } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EndpointAssertion } from '../types.js';
import type { DbService } from '../db.service.js';
import { UserRepository } from '../../users/repositories/user.repository.js';
import { ServiceRepository } from '../../registration/repositories/service.repository.js';
import { EndpointRepository } from '../../registration/repositories/endpoint.repository.js';
import {
  connectTestDb,
  testDatabaseUrl,
  truncateAll,
  type TestDb,
} from '../../../testing/database.js';

/**
 * The CLI as a real process, because the defect it guards only exists in one.
 *
 * `audit-json-path-assertions.int.test.ts` covers the audit function with an
 * injected rejecting sink. That is not the same failure: injecting a
 * rejection never makes `process.stdout` emit its `error` event, so that test
 * passes with D65's listeners deleted. The bug is that a genuinely failing
 * writable does *both* -- it hands the error to the `write` callback and
 * emits `error` -- and Node escalates the unhandled event into a fatal
 * uncaught exception before the rejected promise can reach Kysely's rollback.
 * Only a real broken pipe against a real process reproduces that, so this is
 * the one place in the repository that spawns one (Codex finding, PR #43, P1;
 * docs/m3-plan.md D60/D65).
 *
 * The pipe is closed deterministically rather than on a timer: the parent
 * destroys its read end immediately after `spawn`, which is long before the
 * child has loaded tsx, read its config, connected to PostgreSQL and reached
 * its first write. No sleep decides the outcome.
 */

const CLI = 'src/core/db/maintenance/audit-json-path-assertions.cli.ts';

// The committed local-development value, as used by docker-compose and
// .env.example: loadConfig() requires it, and the audit never touches an
// encrypted header.
const LOCAL_HEADER_KEY = 'dqLhOBUQykRUIXmfvJzR5v52vAm8SpLNIPreseVmKfo=';

const UNSUPPORTED: EndpointAssertion = { type: 'json_path', path: '$.items[*].id', equals: 1 };
const BODY: EndpointAssertion = { type: 'body_contains', value: 'ok' };

let ctx: TestDb;
let users: UserRepository;
let services: ServiceRepository;
let endpoints: EndpointRepository;
let endpointId: string;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  options: { breakStdout?: boolean; breakStderr?: boolean } = {},
): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn('npx', ['tsx', CLI], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        HEADER_ENCRYPTION_KEY: LOCAL_HEADER_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (options.breakStdout) {
      // Destroying the parent's read end makes every write in the child fail
      // with EPIPE -- a real broken pipe, not a simulated one.
      child.stdout.destroy();
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
    }

    if (options.breakStderr) {
      // The status stream dies while stdout stays healthy: the repair still
      // commits, so the run must still succeed (D67).
      child.stderr.destroy();
    } else {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function readAssertions(id: string): Promise<EndpointAssertion[]> {
  const row = await ctx.db
    .selectFrom('endpoints')
    .select('assertions')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.assertions;
}

beforeAll(() => {
  ctx = connectTestDb();
  const db = { kysely: ctx.db } as DbService;
  users = new UserRepository(db);
  services = new ServiceRepository(db);
  endpoints = new EndpointRepository(db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
  const user = await users.create('cli@example.com', '$argon2id$hash');
  const service = await services.create({
    user_id: user!.id,
    name: 'API',
    base_url: 'https://example.com',
  });
  const endpoint = await endpoints.create({
    service_id: service.id,
    user_id: user!.id,
    interval_s: 60,
    timeout_ms: 10000,
    max_redirects: 5,
    method: 'GET',
    path: '/orders',
  });
  endpointId = endpoint.id;
  // Straight through Kysely: an unsupported path is what the DTO now rejects,
  // so bypassing it is the only way to produce the legacy row, and is how the
  // real ones got there.
  await ctx.db
    .updateTable('endpoints')
    .set({ assertions: JSON.stringify([UNSUPPORTED, BODY]) })
    .where('id', '=', endpointId)
    .execute();
});

describe('audit-json-path-assertions CLI', () => {
  it('reports a broken stdout and rolls the removal back instead of dying', async () => {
    const result = await runCli({ breakStdout: true });

    // Reported through main().catch(), not a crash. Without D65's listeners
    // Node escalates stdout's `error` event into an uncaught exception and
    // this assertion is what catches it.
    expect(result.stderr).not.toMatch(/Unhandled 'error' event/);
    expect(result.stderr).toMatch(/audit failed/);
    expect(result.stderr).toMatch(/EPIPE/);
    expect(result.code).not.toBe(0);

    // The point of the ordering in D60: the record could not be written, so
    // the removal that produced it must not have committed.
    expect(await readAssertions(endpointId)).toEqual([UNSUPPORTED, BODY]);
  }, 60_000);

  it('repairs the row and prints the record when stdout is healthy', async () => {
    // The control: without it, the test above could pass because the CLI
    // never ran at all.
    const result = await runCli({ breakStdout: false });

    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ endpointId, removed: UNSUPPORTED });

    // D63: the summary is on stderr, so stdout stays valid JSONL.
    expect(result.stderr).toMatch(/audit: removed 1 unsupported json_path assertion/);
    expect(await readAssertions(endpointId)).toEqual([BODY]);
  }, 60_000);

  it('still succeeds when stderr dies after the repair has committed', async () => {
    // The summary is written after every removal and every recovery record
    // has committed, so a dead status stream must not turn a successful
    // destructive repair into `audit failed` and a non-zero exit -- which
    // would tell an operator nothing happened and invite a re-run against a
    // database that no longer needs one (D67).
    const result = await runCli({ breakStderr: true });

    expect(result.code).toBe(0);

    // And the repair really did happen, with its recovery record really on
    // stdout: otherwise this would pass for a run that did nothing.
    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ endpointId, removed: UNSUPPORTED });
    expect(await readAssertions(endpointId)).toEqual([BODY]);
  }, 60_000);
});
