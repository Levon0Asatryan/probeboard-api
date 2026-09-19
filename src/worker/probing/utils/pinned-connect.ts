/**
 * Builds the connector that closes the DNS-rebinding window.
 *
 * The guard resolves a hostname and classifies every address it got back. If
 * the transport then resolves that hostname *again* at connect time, nothing
 * the guard decided is binding: an attacker's name server answers public for
 * the check and private for the connection, and the probe reaches the address
 * the guard just rejected. That is the TOCTOU the M2 corpus exists for, and
 * validating a URL string cannot close it.
 *
 * This closes it structurally: the socket dials the exact address that was
 * validated, because the connector ignores the resolver entirely. Nothing
 * between validation and connect can re-resolve, so there is no window to
 * race.
 *
 * SNI and certificate verification still use the **original hostname**. The
 * pin changes where we connect, never who we require the peer to be — the
 * certificate must still be valid for the name the user configured, or the
 * pin would trade an SSRF hole for a TLS one. A replacement `connect`
 * function has to set `servername` itself: undici's own fallback
 * (`servername || options.servername || getServerName(host)`) runs only
 * inside the default connector, and `options.servername` arrives `null` —
 * verified live on the pinned runtime.
 */
import net from 'node:net';
import tls from 'node:tls';

/**
 * The shape undici passes to a custom `connect`. Declared structurally rather
 * than imported, so this module — and its tests — stay independent of the
 * transport package and of whichever undici major is installed.
 */
export interface ConnectOptions {
  /** The **original** request hostname, never the pinned address. */
  hostname: string;
  port?: number | string;
  protocol?: string;
  servername?: string | null;
}

export type ConnectCallback = (error: Error | null, socket?: net.Socket) => void;
export type Connector = (options: ConnectOptions, callback: ConnectCallback) => void;

export interface PinnedConnectOptions {
  /**
   * The single validated address to dial, first in resolution order (D9).
   * Absent means "do not pin" — see `createConnector`.
   */
  address?: string;
}

function portFor(options: ConnectOptions): number {
  if (options.port !== undefined && options.port !== '' && options.port !== null) {
    return Number(options.port);
  }
  return options.protocol === 'https:' ? 443 : 80;
}

function isTls(options: ConnectOptions): boolean {
  return options.protocol === 'https:';
}

/**
 * A connector for one hop.
 *
 * With an address, every connection goes to that address and nothing else.
 * Without one, it connects by hostname and lets the system resolver run,
 * exactly as an ordinary HTTP client would.
 *
 * The unpinned case is not a loophole, it is what `SSRF_GUARD_ENABLED=false`
 * means (D19). A disabled guard short-circuits before resolving and returns
 * no addresses, so there would otherwise be nothing to dial — the entire
 * local-server test strategy runs in that mode. The flag's own config
 * comment says it is for tests against a local server: skip probeboard's SSRF
 * machinery, not pin to nothing. An *enabled* guard that produced no
 * addresses is a different thing entirely — that is the `URL_UNRESOLVABLE`
 * rejection path, and it never reaches a connector at all.
 */
export function createConnector(pin: PinnedConnectOptions = {}): Connector {
  return (options, callback) => {
    const port = portFor(options);
    // The pin, or the hostname when there is nothing to pin to.
    const host = pin.address ?? options.hostname;

    try {
      if (isTls(options)) {
        const socket = tls.connect({
          host,
          port,
          // Deliberately the hostname, not `host`: the peer must still prove
          // it is the name the user configured, whichever address we dialled.
          servername: options.hostname,
        });
        socket.once('error', () => undefined);
        callback(null, socket);
        return;
      }

      const socket = net.connect({ host, port });
      socket.once('error', () => undefined);
      callback(null, socket);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
