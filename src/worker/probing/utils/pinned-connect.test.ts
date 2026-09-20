import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTlsServer, trustFixtureCa } from '../../../testing/tls-fixtures.js';
import type { HopBoundary } from './timing.js';
import {
  ConnectTimeoutError,
  createConnector,
  TlsVerificationError,
  type ConnectOptions,
  type TlsVerdict,
} from './pinned-connect.js';

/**
 * Two kinds of test here, deliberately.
 *
 * *Which address and which servername* the connector asks for is a claim
 * about arguments, so those tests spy on `net`/`tls`. Everything the
 * handshake decides — authorised or not, which code, when the boundaries
 * fire, whether an unauthorised socket ever carries a request — is a claim
 * about a real TLS session, and is tested against a loopback server with a
 * real certificate. A spy cannot produce an `authorizationError`.
 */
function stubSocket(): net.Socket {
  return new EventEmitter() as unknown as net.Socket;
}

const opts = (over: Partial<ConnectOptions> = {}): ConnectOptions => ({
  hostname: 'api.example.com',
  protocol: 'https:',
  port: 8443,
  ...over,
});

/** Connects for real and resolves with whatever the connector reported. */
function connect(
  pin: Parameters<typeof createConnector>[0],
  options: Partial<ConnectOptions>,
): Promise<{ error: Error | null; socket?: net.Socket }> {
  return new Promise((resolve) => {
    createConnector(pin)(opts(options), (error, socket) => resolve({ error, socket }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createConnector, pinned', () => {
  it('dials the validated address, not the hostname', () => {
    // The rebinding window: if the transport resolved the hostname again,
    // nothing the guard decided would be binding.
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);

    createConnector({ address: '93.184.216.34' })(opts(), vi.fn());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ host: '93.184.216.34', port: 8443 });
  });

  it('keeps SNI and certificate verification on the original hostname', () => {
    // The pin changes where we connect, never who we require the peer to be.
    // Verifying against the pinned IP would trade an SSRF hole for a TLS one.
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);

    createConnector({ address: '93.184.216.34' })(opts(), vi.fn());

    expect(spy.mock.calls[0][0]).toMatchObject({ servername: 'api.example.com' });
  });

  it('sets servername itself, since undici passes null', () => {
    // undici's own servername fallback runs only inside its default
    // connector; a replacement gets `servername: null` and must set it.
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);

    createConnector({ address: '203.0.113.7' })(opts({ servername: null }), vi.fn());

    expect(spy.mock.calls[0][0]).toMatchObject({ servername: 'api.example.com' });
  });

  it('omits servername when the target is an IP literal', () => {
    // RFC 6066 SNI carries names. Node currently accepts an IP and warns
    // (DEP0123) that it will be ignored; omitting it means identity is
    // checked against the certificate's IP SANs, which keeps working when
    // Node does start ignoring it.
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);

    createConnector({ address: '203.0.113.7' })(opts({ hostname: '203.0.113.7' }), vi.fn());
    createConnector()(opts({ hostname: '::1' }), vi.fn());

    expect(spy.mock.calls[0][0]).toMatchObject({ servername: undefined });
    expect(spy.mock.calls[1][0]).toMatchObject({ servername: undefined });
  });

  it('judges the certificate itself rather than letting Node reject (D6)', () => {
    // rejectUnauthorized: false is what keeps TLS_EXPIRED, TLS_UNTRUSTED and
    // TLS_HOSTNAME_MISMATCH distinguishable, and keeps the certificate in
    // hand for cert_expires_at. The trust decision is not skipped -- it moves
    // to the secureConnect handler, before any request byte is written.
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);

    createConnector({ address: '93.184.216.34' })(opts(), vi.fn());

    expect(spy.mock.calls[0][0]).toMatchObject({ rejectUnauthorized: false });
  });

  it('uses a plain socket for http, with no servername', () => {
    const tlsSpy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as tls.TLSSocket);
    const netSpy = vi.spyOn(net, 'connect').mockReturnValue(stubSocket());

    createConnector({ address: '198.51.100.9' })(opts({ protocol: 'http:', port: 8081 }), vi.fn());

    expect(tlsSpy).not.toHaveBeenCalled();
    expect(netSpy.mock.calls[0][0]).toMatchObject({ host: '198.51.100.9', port: 8081 });
  });

  it.each([
    ['https:', 443],
    ['http:', 80],
  ])('defaults the port for %s to %i', (protocol, expected) => {
    const connectSpy =
      protocol === 'https:'
        ? vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as tls.TLSSocket)
        : vi.spyOn(net, 'connect').mockReturnValue(stubSocket());

    createConnector({ address: '203.0.113.1' })(opts({ protocol, port: undefined }), vi.fn());

    expect(connectSpy.mock.calls[0][0]).toMatchObject({ port: expected });
  });
});

describe('createConnector, unpinned (D19)', () => {
  it('connects by hostname when there is no address to pin to', () => {
    // SSRF_GUARD_ENABLED=false short-circuits before resolving, so there is
    // no address -- the entire local-server test strategy runs in that mode.
    // Not a loophole: it is what "disabled" means.
    const spy = vi.spyOn(net, 'connect').mockReturnValue(stubSocket());

    createConnector()(
      opts({ protocol: 'http:', hostname: 'api.example.com', port: 8081 }),
      vi.fn(),
    );

    expect(spy.mock.calls[0][0]).toMatchObject({ host: 'api.example.com', port: 8081 });
  });

  it('still verifies the original hostname over TLS when unpinned', () => {
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);

    createConnector()(opts(), vi.fn());

    expect(spy.mock.calls[0][0]).toMatchObject({
      host: 'api.example.com',
      servername: 'api.example.com',
    });
  });
});

describe('createConnector over a real handshake', () => {
  it('hands undici the socket and reports the chain expiry when the peer is trusted', async () => {
    const restore = trustFixtureCa();
    const server = await startTlsServer('valid');
    const verdicts: TlsVerdict[] = [];
    try {
      const { error, socket } = await connect(
        { address: '127.0.0.1', onTls: (v) => verdicts.push(v) },
        { hostname: 'localhost', port: server.port },
      );

      expect(error).toBeNull();
      expect(socket).toBeDefined();
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].authorized).toBe(true);
      expect(verdicts[0].authorizationError).toBeUndefined();
      // FR-22: recorded on success too, not only when something is wrong.
      expect(verdicts[0].certExpiresAt).toBeInstanceOf(Date);
      socket?.destroy();
    } finally {
      await server.close();
      restore();
    }
  });

  it.each([
    ['expired', 'CERT_HAS_EXPIRED'],
    ['self-signed', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
  ] as const)('refuses a %s certificate with code %s', async (cert, expected) => {
    const server = await startTlsServer(cert);
    const verdicts: TlsVerdict[] = [];
    try {
      const { error, socket } = await connect(
        { address: '127.0.0.1', onTls: (v) => verdicts.push(v) },
        { hostname: 'localhost', port: server.port },
      );

      expect(error).toBeInstanceOf(TlsVerificationError);
      expect((error as TlsVerificationError).code).toBe(expected);
      expect(socket).toBeUndefined();
      expect(verdicts[0]).toMatchObject({ authorized: false, authorizationError: expected });
    } finally {
      await server.close();
    }
  });

  it('reports a name mismatch as a mismatch, not as an untrusted chain', async () => {
    // Needs the CA trusted: otherwise the untrusted-chain error is reported
    // first and this class would never be reachable, which is exactly how a
    // test can pass while proving nothing.
    const restore = trustFixtureCa();
    const server = await startTlsServer('wrong-name');
    try {
      const { error } = await connect(
        { address: '127.0.0.1' },
        { hostname: 'localhost', port: server.port },
      );

      expect((error as TlsVerificationError).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    } finally {
      await server.close();
      restore();
    }
  });

  it('records the expiry of a rejected certificate too', async () => {
    // An expired certificate is precisely where cert_expires_at earns its
    // keep. Letting Node reject the handshake would have thrown it away.
    const server = await startTlsServer('expired');
    const verdicts: TlsVerdict[] = [];
    try {
      await connect(
        { address: '127.0.0.1', onTls: (v) => verdicts.push(v) },
        { hostname: 'localhost', port: server.port },
      );

      expect(verdicts[0].certExpiresAt).toEqual(new Date('Jan 1 00:00:00 2021 GMT'));
    } finally {
      await server.close();
    }
  });

  it('writes nothing to an unauthorised socket', async () => {
    // The point of judging before the callback (D6, §3.8): undici never gets
    // the socket, so the configured secret headers are never written to a
    // peer that failed verification.
    const server = await startTlsServer('self-signed');
    try {
      const { socket } = await connect(
        { address: '127.0.0.1' },
        { hostname: 'localhost', port: server.port },
      );

      expect(socket).toBeUndefined();
      expect(server.requests()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('marks connect and TLS boundaries in order', async () => {
    const restore = trustFixtureCa();
    const server = await startTlsServer('valid');
    const marks: HopBoundary[] = [];
    try {
      const { socket } = await connect(
        { address: '127.0.0.1', onBoundary: (b) => marks.push(b) },
        { hostname: 'localhost', port: server.port },
      );

      // Separate boundaries, from the socket's own events: a slow handshake
      // has to be visible as TLS time, not folded into connect time.
      expect(marks).toEqual(['connect_start', 'connect_done', 'tls_start', 'tls_done']);
      socket?.destroy();
    } finally {
      await server.close();
      restore();
    }
  });

  it('marks only the connect boundaries on plain http', async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const marks: HopBoundary[] = [];
    try {
      const { error, socket } = await connect(
        { onBoundary: (b) => marks.push(b) },
        { protocol: 'http:', hostname: '127.0.0.1', port },
      );

      expect(error).toBeNull();
      expect(marks).toEqual(['connect_start', 'connect_done']);
      socket?.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('createConnector failure handling', () => {
  it('reports a connect failure through the callback rather than throwing', () => {
    vi.spyOn(net, 'connect').mockImplementation(() => {
      throw new Error('EMFILE');
    });
    const cb = vi.fn();

    createConnector({ address: '203.0.113.5' })(opts({ protocol: 'http:' }), cb);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((cb.mock.calls[0][0] as Error).message).toBe('EMFILE');
  });

  it('reports a refused connection once, not twice', () => {
    // A socket that errors after settling must not call undici's callback a
    // second time -- it would hand undici a destroyed socket as a fresh one.
    const cb = vi.fn();
    const socket = stubSocket();
    vi.spyOn(net, 'connect').mockReturnValue(socket);

    createConnector({ address: '127.0.0.1' })(opts({ protocol: 'http:', port: 9 }), cb);
    socket.emit(
      'error',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    socket.emit('error', new Error('again'));

    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0][0] as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });

  it('bounds a connect that never completes, since undici will not', async () => {
    // undici applies connectTimeout inside buildConnector, which it calls
    // only when `typeof connect !== 'function'` -- so a custom connector
    // silently opts out and a dropped SYN would be bounded only by the OS.
    vi.useFakeTimers();
    try {
      const socket = stubSocket();
      socket.destroy = vi.fn() as never;
      vi.spyOn(net, 'connect').mockReturnValue(socket);
      const cb = vi.fn();

      createConnector({ address: '203.0.113.5', timeoutMs: 1000 })(opts({ protocol: 'http:' }), cb);
      expect(cb).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(cb).toHaveBeenCalledTimes(1);
      const error = cb.mock.calls[0][0] as ConnectTimeoutError;
      expect(error).toBeInstanceOf(ConnectTimeoutError);
      // undici's own code for this condition, already mapped to
      // CONNECTION_TIMEOUT -- not a probeboard-only string.
      expect(error.code).toBe('UND_ERR_CONNECT_TIMEOUT');
      expect(socket.destroy).toHaveBeenCalledWith(error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timeout after a successful connect', async () => {
    vi.useFakeTimers();
    try {
      const socket = stubSocket();
      vi.spyOn(net, 'connect').mockReturnValue(socket);
      const cb = vi.fn();

      createConnector({ address: '203.0.113.5', timeoutMs: 1000 })(opts({ protocol: 'http:' }), cb);
      socket.emit('connect');
      await vi.advanceTimersByTimeAsync(5000);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
