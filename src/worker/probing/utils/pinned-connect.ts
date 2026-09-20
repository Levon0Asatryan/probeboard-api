/**
 * Builds the connector that closes the DNS-rebinding window, times the
 * connect and handshake phases, and judges the certificate itself.
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
import { earliestExpiry } from './tls-inspect.js';
import type { HopBoundary } from './timing.js';

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

/** What the completed handshake said, recorded whether or not it passed. */
export interface TlsVerdict {
  authorized: boolean;
  /** Node's `authorizationError` code, when it refused. */
  authorizationError?: string;
  /** The earliest `notAfter` in the presented chain (FR-22). */
  certExpiresAt?: Date;
}

/**
 * A rejected peer, carrying the OpenSSL verify code as `code`.
 *
 * `code` is what makes this classify correctly: `fetch()` wraps a connector
 * error in a `TypeError` and `classifyError`'s cause walk (D34) reads the
 * first own string `code` it finds, so `CERT_HAS_EXPIRED` here becomes
 * `TLS_EXPIRED` through the one map in `failure-classes.ts` — no second
 * mapping table beside it.
 */
export class TlsVerificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`TLS verification failed: ${code}`);
    this.name = 'TlsVerificationError';
    this.code = code;
  }
}

/**
 * The connector's own connect deadline expiring.
 *
 * `UND_ERR_CONNECT_TIMEOUT` is deliberate: it is the code undici's own
 * connector raises for this condition, and it already maps to
 * `CONNECTION_TIMEOUT`. See `timeoutMs` for why we have to raise it ourselves.
 */
export class ConnectTimeoutError extends Error {
  readonly code = 'UND_ERR_CONNECT_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`connect timed out after ${timeoutMs}ms`);
    this.name = 'ConnectTimeoutError';
  }
}

export interface PinnedConnectOptions {
  /**
   * The single validated address to dial, first in resolution order (D9).
   * Absent means "do not pin" — see `createConnector`.
   */
  address?: string;
  /** Records a phase boundary the instant it happens. */
  onBoundary?: (boundary: HopBoundary) => void;
  /** Receives the handshake verdict, authorised or not. TLS hops only. */
  onTls?: (verdict: TlsVerdict) => void;
  /**
   * Bound on getting a usable socket: TCP connect plus, on https, the
   * handshake.
   *
   * We enforce it because undici will not. `Client` applies its
   * `connectTimeout` inside `buildConnector`, and that is called only when
   * `typeof connect !== 'function'` (undici 6.28.0,
   * `lib/dispatcher/client.js`) — so supplying the custom connector D13
   * requires silently opts out of it. Without this timer a dropped SYN is
   * bounded only by the OS (~75s on Linux), far past any configured
   * `timeout_ms`; the outer `AbortSignal` (D4) still bounds the probe, but
   * the socket would outlive it.
   */
  timeoutMs?: number;
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
 * The SNI name, or nothing when the target is an IP literal.
 *
 * SNI carries host *names* by RFC 6066, so an IP there is meaningless.
 * Measured on the pinned runtime rather than assumed: Node currently
 * *accepts* an IP `servername` and emits `DEP0123` saying it "will be ignored
 * in a future version" — it does not throw, so this is not a crash guard.
 * What it buys is that identity is checked against `host`, i.e. the
 * certificate's IP SANs, which is the correct check for an IP target and the
 * one that keeps working when Node starts ignoring the field. Verified both
 * ways: a certificate carrying `IP:127.0.0.1` authorises with `servername`
 * omitted, and one without it still fails `ERR_TLS_CERT_ALTNAME_INVALID`.
 */
function servernameFor(hostname: string): string | undefined {
  return net.isIP(hostname) === 0 ? hostname : undefined;
}

/**
 * The OpenSSL verify code from a finished handshake.
 *
 * `@types/node` declares `authorizationError: Error`, but the runtime hands
 * back a bare **string** — `'DEPTH_ZERO_SELF_SIGNED_CERT'`, not an `Error`
 * carrying it — measured on the pinned runtime. Reading `.code` off it, as
 * the type invites, yields `undefined` and every TLS refusal would classify
 * as `UNKNOWN_ERROR`. Both shapes are handled because the type and the
 * runtime disagree and only one of them can be checked by the compiler.
 */
function authorizationErrorCode(socket: tls.TLSSocket): string | undefined {
  const raw: unknown = socket.authorizationError;
  if (typeof raw === 'string') return raw === '' ? undefined : raw;
  if (raw instanceof Error) {
    const code: unknown = (raw as { code?: unknown }).code;
    return typeof code === 'string' ? code : raw.message;
  }
  return undefined;
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
 *
 * On https the callback is deferred until the handshake has been judged
 * (D6). The socket is handed to undici only if the peer was authorised; an
 * unauthorised one is destroyed here, before a single request byte — and
 * therefore before any configured secret header — is written to it.
 */
export function createConnector(pin: PinnedConnectOptions = {}): Connector {
  return (options, callback) => {
    const port = portFor(options);
    // The pin, or the hostname when there is nothing to pin to.
    const host = pin.address ?? options.hostname;
    const mark = (boundary: HopBoundary): void => pin.onBoundary?.(boundary);

    // Exactly one of settle's calls reaches undici. Without this latch a
    // socket that errors *after* a successful handshake would call the
    // callback a second time, and undici would take a destroyed socket for a
    // fresh one.
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (error: Error | null, socket?: net.Socket): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      callback(error, socket);
    };

    try {
      mark('connect_start');

      const socket = isTls(options)
        ? tls.connect({
            host,
            port,
            // Deliberately the hostname, not `host`: the peer must still
            // prove it is the name the user configured, whichever address we
            // dialled.
            servername: servernameFor(options.hostname),
            // Judged below rather than by Node (D6). The trust boundary does
            // not move -- an unauthorised socket never carries a request.
            rejectUnauthorized: false,
          })
        : net.connect({ host, port });

      if (pin.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const error = new ConnectTimeoutError(pin.timeoutMs!);
          socket.destroy(error);
          settle(error);
        }, pin.timeoutMs);
        // The probe owns the deadline; this timer must not hold the loop open.
        timer.unref?.();
      }

      // `on`, not `once`: a socket commonly emits a second error while it
      // tears down, and an 'error' with no listener left is an uncaught
      // exception that takes the whole worker with it. The settle latch, not
      // listener removal, is what keeps undici's callback to exactly one call.
      socket.on('error', (error: Error) => settle(error));

      if (!isTls(options)) {
        socket.once('connect', () => {
          mark('connect_done');
          settle(null, socket);
        });
        return;
      }

      const secure = socket as tls.TLSSocket;
      // TCP is up; the handshake starts here. Both boundaries come from the
      // socket's own events, not from bracketing the whole call, so a slow
      // handshake is visible as tls time rather than hidden in connect time.
      secure.once('connect', () => {
        mark('connect_done');
        mark('tls_start');
      });

      secure.once('secureConnect', () => {
        mark('tls_done');

        const code = authorizationErrorCode(secure);

        pin.onTls?.({
          authorized: secure.authorized,
          authorizationError: secure.authorized ? undefined : code,
          // Read even when the peer was rejected: an expired certificate is
          // exactly where FR-22's cert_expires_at is most worth having.
          certExpiresAt: earliestExpiry(secure.getPeerCertificate(true)),
        });

        if (!secure.authorized) {
          const error = new TlsVerificationError(code ?? 'UNKNOWN');
          secure.destroy();
          settle(error);
          return;
        }

        settle(null, secure);
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
