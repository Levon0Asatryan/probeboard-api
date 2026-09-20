/**
 * Local HTTP/HTTPS servers for the probe executor's tests (D12, D53).
 *
 * Real sockets, no database — which is why the suite using these is
 * `probe.test.ts` and not `.int.test.ts`. Everything binds `127.0.0.1`
 * explicitly: on macOS an ephemeral port picked against `0.0.0.0` can collide
 * with another process already bound to `127.0.0.1` there, producing flaky
 * failures that look unrelated to the change that surfaced them.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { readFixture, type FixtureCert } from './tls-fixtures.js';

/** What the server saw, so a test can assert on what was actually sent. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Handler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  recorded: RecordedRequest,
) => void;

export interface TestServer {
  port: number;
  origin: string;
  /** Every request the server received, in order. */
  received: RecordedRequest[];
  /** Sockets the server has accepted and not yet seen closed. */
  openSockets: () => number;
  close: () => Promise<void>;
}

export interface TestServerOptions {
  /** Present for an HTTPS server; absent for plain HTTP. */
  cert?: FixtureCert;
}

/**
 * Starts a server that answers with `handler`.
 *
 * `openSockets` is the evidence for the cleanup table (D26/D41/D46): a test
 * asserts the count returns to zero, which is an observation of the socket
 * actually closing rather than of it eventually being collected.
 */
export async function startServer(
  handler: Handler,
  options: TestServerOptions = {},
): Promise<TestServer> {
  const received: RecordedRequest[] = [];
  let open = 0;

  const listener: http.RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(recorded);
      handler(request, response, recorded);
    });
  };

  const server =
    options.cert === undefined
      ? http.createServer(listener)
      : https.createServer(
          { key: readFixture(options.cert, 'key'), cert: readFixture(options.cert, 'crt') },
          listener,
        );

  server.on('connection', track);
  server.on('secureConnection', track);
  function track(socket: Socket): void {
    open += 1;
    socket.once('close', () => {
      open -= 1;
    });
  }
  // An unauthorised client aborting the handshake would otherwise emit an
  // unhandled 'error' and fail the whole file.
  server.on('tlsClientError', () => undefined);
  server.on('clientError', () => undefined);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = options.cert === undefined ? 'http' : 'https';

  return {
    port,
    origin: `${scheme}://127.0.0.1:${port}`,
    received,
    openSockets: () => open,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Answers `200 OK` with `body`. */
export function respond(body: string, status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  };
}

/** Redirects to `location` with `status`. */
export function redirect(location: string, status = 302): Handler {
  return (_request, response) => {
    response.writeHead(status, { Location: location });
    response.end();
  };
}

/**
 * Sends headers, then a body that never ends.
 *
 * The case D26 and D46 exist for: `fetch()` resolves once headers arrive, so
 * a hop moved past without cancelling leaves this streaming forever.
 */
export function neverEndingBody(status = 302, location?: string): Handler {
  return (_request, response) => {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    if (location !== undefined) headers.Location = location;
    response.writeHead(status, headers);
    const timer = setInterval(() => response.write('x'.repeat(1024)), 5);
    response.on('close', () => clearInterval(timer));
  };
}

/**
 * Sends headers and one chunk, then goes silent for ever.
 *
 * Distinct from `neverEndingBody`: that one keeps sending, so the body cap
 * ends the read and the probe succeeds truncated. This one stalls *below*
 * the cap, which is the only way the body phase reaches the deadline.
 */
export function stalledBody(status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
    response.write('partial');
    // Deliberately never ended. The server is closed by the test's teardown.
  };
}

/**
 * Accepts the connection and never answers at all — not even headers.
 *
 * The hop state that distinguishes a response timeout from a body one: with
 * `stalledBody` the headers arrived, here they never did.
 */
export function silent(): Handler {
  return () => undefined;
}

/**
 * Sends headers and part of a body, then destroys the socket.
 *
 * A real mid-response reset. It reaches `fetch()` as undici's `SocketError`
 * (`UND_ERR_SOCKET`), not as a raw `ECONNRESET` — the distinction the
 * taxonomy mapping has to get right.
 */
export function resetMidBody(status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': '1000' });
    response.write('partial');
    setTimeout(() => response.socket?.destroy(), 20);
  };
}
