import { describe, expect, it } from 'vitest';
import { startDnsServer } from './dns-server.js';

describe('startDnsServer', () => {
  it('rejects when it cannot bind, instead of crashing the test run', async () => {
    // A UDP port already bound: the second socket emits 'error' from bind.
    // With no listener that is an uncaught exception, which kills the Vitest
    // worker rather than failing this one start.
    const first = await startDnsServer('servfail');
    try {
      await expect(startDnsServer('servfail', 'servfail', { port: first.port })).rejects.toThrow(
        /EADDRINUSE/,
      );
    } finally {
      await first.close();
    }
  });
});
