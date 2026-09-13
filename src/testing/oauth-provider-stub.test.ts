import http, { type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthProviderStub } from './oauth-provider-stub.js';

/**
 * The stub is test infrastructure, not the thing under test elsewhere -- but a
 * bug in it fails or hangs every suite that uses it, so its own two guards get
 * their own tests: a bind failure must reject `start()` rather than crash the
 * process, and a rejection from `handle()` must not become an unhandled
 * rejection.
 */

describe('OAuthProviderStub.start', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects rather than crashing the process when the bind fails', async () => {
    // `listen()` reports a bind failure by emitting 'error', not by calling
    // back. An EventEmitter's 'error' with no listener is a fatal uncaught
    // exception in Node -- this reproduces that path without needing to
    // actually exhaust file descriptors.
    vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: Server) {
      queueMicrotask(() => {
        this.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }));
      });
      return this;
    });

    await expect(OAuthProviderStub.start('github')).rejects.toThrow('EADDRINUSE');
  });
});

describe('a request that fails while being handled', () => {
  it('answers 500 instead of becoming an unhandled rejection', async () => {
    const stub = await OAuthProviderStub.start('github');
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    vi.spyOn(
      stub as unknown as { handle: (...args: unknown[]) => Promise<void> },
      'handle',
    ).mockRejectedValue(new Error('boom'));

    try {
      const response = await fetch(`${stub.url}/user`);
      expect(response.status).toBe(500);

      // Let a same-tick unhandled rejection surface before asserting its absence.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      await stub.close();
    }
  });
});
