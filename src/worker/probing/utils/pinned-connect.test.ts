import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnector, type ConnectOptions } from './pinned-connect.js';

/**
 * `net.connect`/`tls.connect` are spied rather than dialled. The claim under
 * test is *which address and which servername the connector asks for* -- a
 * real socket would prove nothing extra and would need a real listener.
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createConnector, pinned', () => {
  it('dials the validated address, not the hostname', () => {
    // The rebinding window: if the transport resolved the hostname again,
    // nothing the guard decided would be binding.
    const spy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as never);
    const cb = vi.fn();

    createConnector({ address: '93.184.216.34' })(opts(), cb);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ host: '93.184.216.34', port: 8443 });
    expect(cb).toHaveBeenCalledWith(null, expect.anything());
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

  it('uses a plain socket for http, with no servername', () => {
    const tlsSpy = vi.spyOn(tls, 'connect').mockReturnValue(stubSocket() as tls.TLSSocket);
    const netSpy = vi.spyOn(net, 'connect').mockReturnValue(stubSocket());

    createConnector({ address: '198.51.100.9' })(opts({ protocol: 'http:', port: 8080 }), vi.fn());

    expect(tlsSpy).not.toHaveBeenCalled();
    expect(netSpy.mock.calls[0][0]).toMatchObject({ host: '198.51.100.9', port: 8080 });
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

    createConnector()(opts({ protocol: 'http:', hostname: '127.0.0.1', port: 3000 }), vi.fn());

    expect(spy.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1', port: 3000 });
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
});
