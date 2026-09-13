import { readFile, writeFile } from 'node:fs/promises';
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

async function main(): Promise<void> {
  const generated = render();

  if (process.argv.includes('--check')) {
    const committed = await readFile(OUTPUT, 'utf8').catch(() => undefined);

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

await main();
