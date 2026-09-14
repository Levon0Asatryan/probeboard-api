import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from './document.js';

/**
 * Writes `openapi.yaml`, or checks the committed one is current.
 *
 * YAML rather than JSON because this file is read by people as often as by
 * tooling: multi-line descriptions become block scalars instead of one long
 * line of `\n`, and a diff shows the field that changed rather than a reflowed
 * brace. Every generator and client toolchain accepts either.
 *
 * `--check` is what CI runs: it regenerates into memory and compares, so a
 * schema change that nobody re-exported fails the build rather than shipping a
 * document that describes an API the server no longer serves.
 */
const OUTPUT = 'openapi.yaml';

function render(): string {
  return stringify(buildOpenApiDocument(), {
    // Wide enough that descriptions are not folded mid-sentence, which makes
    // the diff of a reworded line unreadable.
    lineWidth: 0,
    // Block scalars for anything with newlines, so prose stays prose.
    blockQuote: 'literal',
  });
}

/**
 * The committed file's content, or `undefined` if it does not exist.
 *
 * Only a missing file reads as "missing". Anything else -- permission
 * denied, an I/O error -- is a real failure and must surface with its cause,
 * not be reported as an absent file that a plain `npm run openapi` would
 * silently "fix" by writing over whatever is actually wrong.
 */
export async function readCommitted(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
}

async function main(): Promise<void> {
  const generated = render();

  if (process.argv.includes('--check')) {
    const committed = await readCommitted(OUTPUT);

    if (committed === generated) {
      process.stdout.write(`${OUTPUT}: up to date\n`);
      return;
    }

    console.error(
      committed === undefined
        ? `${OUTPUT}: missing. Run \`npm run openapi\`.`
        : `${OUTPUT}: out of date. Run \`npm run openapi\` and commit the result.`,
    );
    process.exitCode = 1;
    return;
  }

  await writeFile(OUTPUT, generated);
  process.stdout.write(`${OUTPUT}: written\n`);
}

// Only run as the CLI entrypoint, never as a side effect of import -- this
// module is imported directly by its own test for `readCommitted`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
