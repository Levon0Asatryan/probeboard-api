import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FETCH_BLOCKED_PORTS } from './fetch-blocked-ports.js';

const require = createRequire(import.meta.url);

describe('FETCH_BLOCKED_PORTS', () => {
  it('is exactly the list the installed undici refuses', () => {
    // undici has no exports map, so its internal constants are reachable; the
    // point is to read the list the probe's own HTTP client enforces, not a
    // copy of the spec that could disagree with it.
    const { badPorts } = require('undici/lib/web/fetch/constants.js') as { badPorts: string[] };
    expect([...FETCH_BLOCKED_PORTS].sort((a, b) => a - b)).toEqual(
      badPorts.map(Number).sort((a, b) => a - b),
    );
  });

  it('includes ports someone could plausibly serve HTTP on', () => {
    for (const port of [6000, 6666, 10080]) expect(FETCH_BLOCKED_PORTS.has(port)).toBe(true);
    for (const port of [80, 443, 8080, 8443, 3000])
      expect(FETCH_BLOCKED_PORTS.has(port)).toBe(false);
  });
});
