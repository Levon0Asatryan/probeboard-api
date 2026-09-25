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

  it('surfaces a socket error from after startup when it is closed', async () => {
    // A fault mid-test would otherwise only change what the resolver saw --
    // silence, which reads as ETIMEOUT -- and a test could pass on that.
    const server = await startDnsServer('servfail');
    server.socket.emit('error', new Error('late fault'));

    expect(server.errors().map((e) => e.message)).toEqual(['late fault']);
    await expect(server.close()).rejects.toThrow(/socket errors/);
  });

  it('closes cleanly when nothing went wrong', async () => {
    const server = await startDnsServer('servfail');
    await expect(server.close()).resolves.toBeUndefined();
  });
});
