import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCommitted } from './cli.js';

describe('readCommitted', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-cli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for a missing file', async () => {
    await expect(readCommitted(join(dir, 'missing.yaml'))).resolves.toBeUndefined();
  });

  it('returns the file content when it exists', async () => {
    const path = join(dir, 'openapi.yaml');
    await writeFile(path, 'content');

    await expect(readCommitted(path)).resolves.toBe('content');
  });

  it('does not swallow a non-ENOENT read failure as "missing"', async () => {
    // A directory can be opened but never read as a file -- EISDIR, not
    // ENOENT. Before the fix, `.catch(() => undefined)` reported this the
    // same as a genuinely missing file; the cause (a real I/O failure) was
    // discarded instead of surfacing.
    await expect(readCommitted(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
