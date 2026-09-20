/**
 * The probe executor, against real local servers (D12, D53).
 *
 * Real sockets, no database, so this is `.test.ts` rather than
 * `.int.test.ts`. The three injected dependencies cover what a local server
 * cannot produce: `resolver` for DNS answers, `clock` for a clock that
 * misbehaves, and `dispatcherFactory` for a transport that never connects.
 */
import { Agent, type Dispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SsrfGuardConfig } from '../../../core/ssrf/host-validator.js';
import {
  neverEndingBody,
  redirect,
  resetMidBody,
  respond,
  silent,
  stalledBody,
  startServer,
  type Handler,
  type TestServer,
} from '../../../testing/probe-server.js';
import { trustFixtureCa } from '../../../testing/tls-fixtures.js';
import { createConnector, type PinnedConnectOptions } from './pinned-connect.js';
import { probe, type EndpointProbeConfig, type ProbeDeps } from './probe.js';

/** Servers started by a test, closed for it afterwards. */
const started: TestServer[] = [];

async function serve(
  handler: Handler,
  cert?: Parameters<typeof startServer>[1],
): Promise<TestServer> {
  const server = await startServer(handler, cert ?? {});
  started.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

/** The guard off — what SSRF_GUARD_ENABLED=false means for a local target (D19). */
const GUARD_OFF: SsrfGuardConfig = { enabled: false, blockedPorts: [] };
const GUARD_ON: SsrfGuardConfig = { enabled: true, blockedPorts: [] };

const realDispatcher = (options: PinnedConnectOptions): Dispatcher =>
  new Agent({ connect: createConnector(options) });

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    resolver: {
      resolve4: () => Promise.resolve([]),
      resolve6: () => Promise.resolve([]),
    },
    clock: { wallClock: () => Date.now(), monotonic: () => performance.now() },
    dispatcherFactory: realDispatcher,
    ssrf: GUARD_OFF,
    maxTimeoutMs: 5000,
    maxBodyBytes: 64 * 1024,
    maxRedirectsCap: 5,
    ...over,
  };
}

function config(over: Partial<EndpointProbeConfig> = {}): EndpointProbeConfig {
  return {
    monitorId: 'monitor-1',
    // Not port 1: undici's fetch refuses the WHATWG bad-ports list outright
    // with a generic "bad port" network error, so a test aimed at a timeout
    // or a refusal would classify as UNKNOWN_ERROR for an unrelated reason.
    url: 'http://127.0.0.1:45001/',
    method: 'GET',
    headers: {},
    expectedStatus: [],
    assertions: [],
    timeoutMs: 4000,
    followRedirects: true,
    maxRedirects: 3,
    ...over,
  };
}

/**
 * Guard **on**, against a local server — which needs a stand-in address.
 *
 * A loopback-bound test server is itself inside the SSRF blocklist (D12), so
 * a guard-enabled probe of `127.0.0.1` is refused before it connects. That is
 * correct behaviour, and it means the guard-on path cannot be exercised by
 * pointing it straight at the server: the first draft of these tests did, and
 * they passed while proving nothing, because ADDRESS_NOT_ALLOWED happened to
 * be the expected answer for an unrelated reason.
 *
 * So the resolver answers with a routable address the guard accepts, and the
 * transport dials the local server regardless. What is under test here is
 * what `probe()` hands the dispatcher factory and how it classifies each
 * hop — the connector's own pinning is proved against `tls.connect` in
 * pinned-connect.test.ts.
 */
const ROUTABLE = '93.184.216.34';

function guardedDeps(
  resolve4: (host: string) => Promise<string[]>,
  captured: PinnedConnectOptions[] = [],
): ProbeDeps {
  return deps({
    ssrf: GUARD_ON,
    resolver: { resolve4, resolve6: () => Promise.resolve([]) },
    dispatcherFactory: (options) => {
      captured.push(options);
      return new Agent({ connect: createConnector({ ...options, address: '127.0.0.1' }) });
    },
  });
}

describe('probe, success', () => {
  it('reports a healthy endpoint with timings and the monitor id', async () => {
    const server = await serve(respond('{"status":"ok"}'));

    const outcome = await probe(config({ url: `${server.origin}/health` }), deps());

    expect(outcome.success).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.failureClass).toBeUndefined();
    expect(outcome.monitorId).toBe('monitor-1');
    expect(outcome.truncated).toBe(false);
    expect(outcome.redirects).toBe(0);
    // D24's anchor exists on every path, so this is never undefined.
    expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timings.connectMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timings.ttfbMs).toBeGreaterThanOrEqual(0);
  });

  it('treats an empty expected_status as "any 2xx" (FR-6)', async () => {
    const server = await serve(respond('{}', 204));

    const outcome = await probe(config({ url: server.origin }), deps());

    expect(outcome).toMatchObject({ success: true, status: 204 });
  });

  it('sends the configured method, body and headers', async () => {
    const server = await serve(respond('{}'));

    await probe(
      config({
        url: server.origin,
        method: 'POST',
        body: '{"ping":1}',
        headers: { 'X-Api-Key': 'k1' },
      }),
      deps(),
    );

    expect(server.received[0]).toMatchObject({ method: 'POST', body: '{"ping":1}' });
    expect(server.received[0].headers['x-api-key']).toBe('k1');
  });

  it('closes the only hop’s dispatcher, so an ordinary probe leaks no socket (D41)', async () => {
    // D26 covers intermediate hops and D38 the reader; between them the
    // final hop's Agent was left for GC. Under PROBE_CONCURRENCY that is a
    // file-descriptor leak, not untidiness.
    const server = await serve(respond('{}'));

    await probe(config({ url: server.origin }), deps());
    await vi.waitFor(() => expect(server.openSockets()).toBe(0), { timeout: 2000 });
  });
});

describe('probe, status and assertions', () => {
  it('reports STATUS_MISMATCH against the configured ranges', async () => {
    const server = await serve(respond('{}', 503));

    const outcome = await probe(
      config({ url: server.origin, expectedStatus: [{ min: 200, max: 299 }] }),
      deps(),
    );

    expect(outcome).toMatchObject({ success: false, status: 503, failureClass: 'STATUS_MISMATCH' });
  });

  it('accepts a status inside a non-2xx configured range', async () => {
    const server = await serve(respond('{}', 418));

    const outcome = await probe(
      config({ url: server.origin, expectedStatus: [{ min: 418, max: 418 }] }),
      deps(),
    );

    expect(outcome.success).toBe(true);
  });

  it('reports ASSERTION_FAILED with the status still recorded', async () => {
    // The status is what an operator looks at first; losing it because an
    // assertion failed would hide that the endpoint answered normally.
    const server = await serve(respond('{"status":"degraded"}'));

    const outcome = await probe(
      config({
        url: server.origin,
        assertions: [{ type: 'json_path', path: '$.status', equals: 'ok' }],
      }),
      deps(),
    );

    expect(outcome).toMatchObject({
      success: false,
      status: 200,
      failureClass: 'ASSERTION_FAILED',
    });
  });

  it('passes assertions against the body it actually read', async () => {
    const server = await serve(respond('{"status":"ok","db":{"up":true}}'));

    const outcome = await probe(
      config({
        url: server.origin,
        assertions: [
          { type: 'body_contains', value: 'ok' },
          { type: 'json_path', path: '$.db.up', equals: true },
        ],
      }),
      deps(),
    );

    expect(outcome.success).toBe(true);
  });
});

describe('probe, body handling', () => {
  it('truncates a body over the cap and says so', async () => {
    const server = await serve(respond('y'.repeat(4096)));

    const outcome = await probe(config({ url: server.origin }), deps({ maxBodyBytes: 512 }));

    expect(outcome).toMatchObject({ success: true, truncated: true });
  });

  it('handles a bodyless response (D18)', async () => {
    // 204 and HEAD give `response.body === null`; an unconditional
    // getReader() throws on the most ordinary successful shapes there are.
    const server = await serve(respond('', 204));

    const head = await probe(config({ url: server.origin, method: 'HEAD' }), deps());
    const empty = await probe(config({ url: server.origin }), deps());

    expect(head).toMatchObject({ success: true, truncated: false });
    expect(empty).toMatchObject({ success: true, status: 204 });
  });

  it('fails a body assertion against an empty body instead of crashing', async () => {
    const server = await serve(respond('', 204));

    const outcome = await probe(
      config({ url: server.origin, assertions: [{ type: 'body_contains', value: 'ok' }] }),
      deps(),
    );

    expect(outcome.failureClass).toBe('ASSERTION_FAILED');
  });
});

describe('probe, redirects', () => {
  it('follows a same-origin redirect and counts it', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/final' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('{}');
    });

    const outcome = await probe(config({ url: `${server.origin}/start` }), deps());

    expect(outcome).toMatchObject({ success: true, status: 200, redirects: 1 });
    expect(server.received.map((r) => r.url)).toEqual(['/start', '/final']);
  });

  it('keeps headers on a same-origin hop', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/final' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('{}');
    });

    await probe(
      config({ url: `${server.origin}/start`, headers: { Authorization: 'Bearer s3cret' } }),
      deps(),
    );

    expect(server.received[1].headers.authorization).toBe('Bearer s3cret');
  });

  it('drops every header on a cross-origin redirect (D15)', async () => {
    // The map can hold the monitor's own API key for the intended origin; a
    // redirect elsewhere would otherwise hand it to an unrelated host.
    const destination = await serve(respond('{}'));
    const source = await serve(redirect(`${destination.origin}/final`));

    const outcome = await probe(
      config({ url: source.origin, headers: { Authorization: 'Bearer s3cret' } }),
      deps(),
    );

    expect(outcome.success).toBe(true);
    expect(destination.received[0].headers.authorization).toBeUndefined();
  });

  it('rewrites POST to GET on a 302 and drops the body headers (D31)', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/final' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('{}');
    });

    await probe(
      config({
        url: `${server.origin}/start`,
        method: 'POST',
        body: '{"a":1}',
        headers: { 'Content-Type': 'application/json', 'X-Keep': 'yes' },
      }),
      deps(),
    );

    expect(server.received[1].method).toBe('GET');
    expect(server.received[1].headers['content-type']).toBeUndefined();
    expect(server.received[1].headers['x-keep']).toBe('yes');
  });

  it('evaluates a 3xx as-is when follow_redirects is false', async () => {
    const server = await serve(redirect('/final', 302));

    const outcome = await probe(
      config({
        url: server.origin,
        followRedirects: false,
        expectedStatus: [{ min: 302, max: 302 }],
      }),
      deps(),
    );

    expect(outcome).toMatchObject({ success: true, status: 302, redirects: 0 });
  });

  it('does not chase a Location on a 304 (D27)', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(304, { Location: '/elsewhere' });
      response.end();
    });

    const outcome = await probe(
      config({ url: server.origin, expectedStatus: [{ min: 304, max: 304 }] }),
      deps(),
    );

    expect(outcome).toMatchObject({ success: true, status: 304, redirects: 0 });
    expect(server.received).toHaveLength(1);
  });

  it('evaluates a followed 3xx that carries no Location', async () => {
    // There is no next hop, so there is nothing for the budget to refuse.
    const server = await serve((_request, response) => {
      response.writeHead(302);
      response.end('no location here');
    });

    const outcome = await probe(
      config({ url: server.origin, expectedStatus: [{ min: 302, max: 302 }] }),
      deps(),
    );

    expect(outcome).toMatchObject({ success: true, status: 302, redirects: 0 });
  });

  it('does not call a Location-less 3xx TOO_MANY_REDIRECTS when the budget is spent', async () => {
    // The budget check used to run first, so an endpoint that legitimately
    // answers 302 without a Location was recorded as downtime -- with its
    // status dropped -- whenever max_redirects was zero or already spent.
    const server = await serve((_request, response) => {
      response.writeHead(302);
      response.end('no location here');
    });

    const outcome = await probe(
      config({ url: server.origin, maxRedirects: 0, expectedStatus: [{ min: 302, max: 302 }] }),
      deps(),
    );

    expect(outcome).toMatchObject({ success: true, status: 302 });
    expect(outcome.failureClass).toBeUndefined();
  });

  it('returns TOO_MANY_REDIRECTS promptly even when the over-budget 3xx streams forever (D46)', async () => {
    // The over-budget 3xx is the last iteration but is still a discarded
    // hop. Treated as an evaluated one it would stall on this unread body
    // until the overall deadline instead of returning now.
    const server = await serve((request, response) => {
      const next = Number(request.url?.slice(1) ?? '0') + 1;
      if (next > 2) {
        neverEndingBody(302, `/${next}`)(request, response, {
          method: 'GET',
          url: '',
          headers: {},
          body: '',
        });
        return;
      }
      response.writeHead(302, { Location: `/${next}` });
      response.end();
    });

    const startedAt = performance.now();
    const outcome = await probe(
      config({ url: `${server.origin}/0`, maxRedirects: 2, timeoutMs: 4000 }),
      deps(),
    );
    const elapsed = performance.now() - startedAt;

    expect(outcome.failureClass).toBe('TOO_MANY_REDIRECTS');
    expect(outcome.success).toBe(false);
    // Well inside the 4s deadline: the proof it did not stall on the body.
    expect(elapsed).toBeLessThan(2000);
    await vi.waitFor(() => expect(server.openSockets()).toBe(0), { timeout: 2000 });
  });

  it('caps redirects at PROBE_MAX_REDIRECTS_CAP even when the endpoint asks for more', async () => {
    const server = await serve((request, response) => {
      const next = Number(request.url?.slice(1) ?? '0') + 1;
      response.writeHead(302, { Location: `/${next}` });
      response.end();
    });

    const outcome = await probe(
      config({ url: `${server.origin}/0`, maxRedirects: 50 }),
      deps({ maxRedirectsCap: 2 }),
    );

    expect(outcome.failureClass).toBe('TOO_MANY_REDIRECTS');
    expect(server.received).toHaveLength(3); // the initial hop plus two follows
  });

  it('does not leak a hop whose Location is not a URL', async () => {
    // `new URL(location, target)` throws on a malformed Location. Thrown
    // from the hop loop it escapes past the discard, leaving the body
    // streaming and the dispatcher open for the life of the process.
    const server = await serve((_request, response) => {
      response.writeHead(302, { Location: 'http://' });
      const timer = setInterval(() => response.write('x'.repeat(1024)), 5);
      response.on('close', () => clearInterval(timer));
    });

    const outcome = await probe(config({ url: server.origin }), deps());

    expect(outcome).toMatchObject({
      success: false,
      failureClass: 'UNKNOWN_ERROR',
      code: 'INVALID_LOCATION',
    });
    expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
    await vi.waitFor(() => expect(server.openSockets()).toBe(0), { timeout: 2000 });
  });

  it('closes an intermediate hop whose body never ends before moving on (D26)', async () => {
    const destination = await serve(respond('{}'));
    const source = await serve(neverEndingBody(302, `${destination.origin}/final`));

    const outcome = await probe(config({ url: source.origin }), deps());

    expect(outcome.success).toBe(true);
    await vi.waitFor(() => expect(source.openSockets()).toBe(0), { timeout: 2000 });
  });
});

describe('probe, SSRF guard', () => {
  it('refuses a blocked address without connecting (NFR-11)', async () => {
    const dispatcherFactory = vi.fn(realDispatcher);

    const outcome = await probe(
      config({ url: 'http://internal.example.com/' }),
      deps({
        ssrf: GUARD_ON,
        dispatcherFactory,
        resolver: {
          resolve4: () => Promise.resolve(['169.254.169.254']),
          resolve6: () => Promise.resolve([]),
        },
      }),
    );

    expect(outcome).toMatchObject({
      success: false,
      failureClass: 'BLOCKED_BY_POLICY',
      code: 'ADDRESS_NOT_ALLOWED',
    });
    // No connection was ever attempted, which is the actual claim.
    expect(dispatcherFactory).not.toHaveBeenCalled();
    expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('pins the validated address rather than the hostname (D9, D13)', async () => {
    // The rebinding window: the connector must be handed the address the
    // guard approved, not left to resolve the name again at connect time.
    const server = await serve(respond('{}'));
    const captured: PinnedConnectOptions[] = [];

    const outcome = await probe(
      config({ url: `http://probe.example.com:${server.port}/` }),
      guardedDeps(() => Promise.resolve([ROUTABLE]), captured),
    );

    expect(outcome.success).toBe(true);
    expect(captured[0]).toMatchObject({ address: ROUTABLE });
  });

  it('pins only the first address in resolution order (D9)', async () => {
    // No multi-address fallback: dialling the second would reach somewhere
    // the first check did not authorise.
    const server = await serve(respond('{}'));
    const captured: PinnedConnectOptions[] = [];

    await probe(
      config({ url: `http://probe.example.com:${server.port}/` }),
      guardedDeps(() => Promise.resolve([ROUTABLE, '93.184.216.35']), captured),
    );

    expect(captured[0].address).toBe(ROUTABLE);
  });

  it('maps a resolver failure to DNS_FAILURE, never BLOCKED_BY_POLICY (D14)', async () => {
    const outcome = await probe(
      config({ url: 'http://broken.example.com/' }),
      guardedDeps(() => Promise.reject(Object.assign(new Error('again'), { code: 'EAI_AGAIN' }))),
    );

    expect(outcome).toMatchObject({ failureClass: 'DNS_FAILURE', code: 'EAI_AGAIN' });
  });

  it('re-validates every redirect hop, classifying its failure on its own terms (D29)', async () => {
    // A valid first hop redirecting to a name that genuinely fails to
    // resolve is a DNS failure, not probeboard refusing.
    const server = await serve(redirect('http://broken.example.com/final'));
    const resolve = vi.fn((host: string) =>
      host === 'broken.example.com'
        ? Promise.reject(Object.assign(new Error('again'), { code: 'EAI_AGAIN' }))
        : Promise.resolve([ROUTABLE]),
    );

    const outcome = await probe(
      config({ url: `http://probe.example.com:${server.port}/` }),
      guardedDeps(resolve),
    );

    expect(outcome).toMatchObject({ failureClass: 'DNS_FAILURE', code: 'EAI_AGAIN' });
    expect(resolve).toHaveBeenCalledWith('broken.example.com');
    expect(server.received).toHaveLength(1);
  });

  it('blocks a redirect to an address the guard refuses', async () => {
    const server = await serve(redirect('http://internal.example.com/final'));

    const outcome = await probe(
      config({ url: `http://probe.example.com:${server.port}/` }),
      guardedDeps((host) =>
        Promise.resolve(host === 'internal.example.com' ? ['10.0.0.5'] : [ROUTABLE]),
      ),
    );

    expect(outcome).toMatchObject({
      failureClass: 'BLOCKED_BY_POLICY',
      code: 'ADDRESS_NOT_ALLOWED',
    });
    // The first hop really was reached -- otherwise this would pass for the
    // wrong reason, which is exactly what it did before ROUTABLE existed.
    expect(server.received).toHaveLength(1);
  });
});

describe('probe, transport failures', () => {
  it('classifies a refused connection from the real wrapped error (D34)', async () => {
    // fetch() wraps transport errors in a TypeError whose own code is
    // undefined; reading error.code directly reports UNKNOWN_ERROR here.
    const server = await serve(respond('{}'));
    const port = server.port;
    await server.close();
    started.splice(started.indexOf(server), 1);

    const outcome = await probe(config({ url: `http://127.0.0.1:${port}/` }), deps());

    expect(outcome).toMatchObject({ success: false, failureClass: 'CONNECTION_REFUSED' });
    // D22: total_ms exists for a failure that never reached a response.
    expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('classifies a real mid-response reset as CONNECTION_RESET', async () => {
    // Once the connector has handed the socket over, a peer reset reaches
    // fetch() as undici's SocketError carrying UND_ERR_SOCKET -- not a raw
    // ECONNRESET. The cause walk stops at the first code it finds, so
    // without that row this reports UNKNOWN_ERROR, which M6 excludes from
    // uptime instead of counting as DOWN.
    const server = await serve(resetMidBody());

    const outcome = await probe(config({ url: server.origin }), deps());

    expect(outcome.failureClass).toBe('CONNECTION_RESET');
    expect(outcome.code).toBe('UND_ERR_SOCKET');
    expect(outcome.success).toBe(false);
  });

  it('keeps the status the endpoint answered with when its body then fails', async () => {
    // The headers arrived and this was the evaluated hop, so the status is
    // real data about the endpoint. Dropping it leaves a reset or timeout
    // diagnosis with nothing to say about what the server actually replied.
    const server = await serve(resetMidBody(200));

    const outcome = await probe(config({ url: server.origin }), deps());

    expect(outcome.status).toBe(200);
  });

  it('does not leak a discarded redirect hop\u2019s status into a later failure', async () => {
    // The counterpart: an intermediate 302 is never evaluated, so its status
    // must not appear in the outcome when a later hop fails.
    const destination = await serve(silent());
    const source = await serve(redirect(`${destination.origin}/final`));

    const outcome = await probe(config({ url: source.origin, timeoutMs: 400 }), deps());

    expect(outcome.failureClass).toBe('RESPONSE_TIMEOUT');
    expect(outcome.status).toBeUndefined();
  });

  it('classifies the deadline by the phase it fired in (D16)', async () => {
    // §6's own mechanism: a dropped SYN is not reproducible on loopback, and
    // a real blackhole address is itself inside the SSRF blocklist. A
    // connector that withholds its callback past the deadline proves
    // probe()'s own enforcement and classification, which is the claim here.
    const dispatcherFactory = (): Dispatcher =>
      new Agent({
        connect: ((_options: unknown, callback: (error: Error | null) => void) => {
          setTimeout(() => callback(new Error('too late')), 60_000).unref();
        }) as never,
      });

    const outcome = await probe(config({ timeoutMs: 300 }), deps({ dispatcherFactory }));

    // connect_done was never reached, so the deadline is read as a connect
    // timeout rather than a response or body one.
    expect(outcome).toMatchObject({ success: false, failureClass: 'CONNECTION_TIMEOUT' });
  });

  it('bounds the whole probe when the body stalls after first byte', async () => {
    // Stalled below the cap, so the read cannot end on its own: the only
    // thing that ends this probe is the overall deadline.
    const server = await serve(stalledBody());

    const startedAt = performance.now();
    const outcome = await probe(config({ url: server.origin, timeoutMs: 400 }), deps());
    const elapsed = performance.now() - startedAt;

    expect(outcome.success).toBe(false);
    expect(outcome.failureClass).toBe('BODY_TIMEOUT');
    expect(elapsed).toBeLessThan(2000);
  });

  it('succeeds truncated when a fast endless body hits the cap instead', async () => {
    // The contrast that makes the row above mean something: reaching the cap
    // is a successful read, not a timeout.
    const server = await serve(neverEndingBody(200));

    const outcome = await probe(
      config({ url: server.origin, timeoutMs: 4000 }),
      deps({ maxBodyBytes: 2048 }),
    );

    expect(outcome).toMatchObject({ success: true, truncated: true });
  });
});

describe('probe, deadline bounds', () => {
  it('clamps the persisted timeout to PROBE_MAX_TIMEOUT_MS (D35)', async () => {
    // An endpoint saved before the cap was lowered would otherwise keep its
    // old, larger budget -- the persisted value is not trusted on its own.
    const server = await serve(stalledBody());

    const startedAt = performance.now();
    const outcome = await probe(
      config({ url: server.origin, timeoutMs: 30_000 }),
      deps({ maxTimeoutMs: 300 }),
    );
    const elapsed = performance.now() - startedAt;

    expect(outcome.failureClass).toBe('BODY_TIMEOUT');
    expect(elapsed).toBeLessThan(3000);
  });

  it('does not carry a redirect hop\u2019s first_byte into the next hop (D45)', async () => {
    // A 3xx has headers, so first_byte is set for that hop. Left stale, the
    // next hop stalling *before* its headers reads as "headers arrived, body
    // stalled" -- BODY_TIMEOUT for a hop that never got that far.
    const destination = await serve(silent());
    const source = await serve(redirect(`${destination.origin}/final`));

    const outcome = await probe(config({ url: source.origin, timeoutMs: 400 }), deps());

    expect(outcome.redirects).toBe(1);
    expect(outcome.failureClass).toBe('RESPONSE_TIMEOUT');
  });
});

describe('probe, total_ms excludes our own teardown', () => {
  /**
   * A real dispatcher that jumps the fake clock forward when it is destroyed.
   *
   * A Proxy rather than assigning `agent.destroy`: undici's own `destroy()`
   * re-enters through `this.destroy` when called without a callback, so an
   * overwritten method recurses into itself and never returns. Every access
   * here is bound to the target, so that internal call reaches the real
   * implementation.
   */
  function teardownJumps(advance: () => void): (options: PinnedConnectOptions) => Dispatcher {
    return (options) => {
      const agent = new Agent({ connect: createConnector(options) });
      return new Proxy(agent, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          const method = value.bind(target) as (...args: unknown[]) => unknown;
          if (prop !== 'destroy') return method;
          return (...args: unknown[]) => {
            advance();
            return method(...args);
          };
        },
      });
    };
  }

  /** A clock whose monotonic time only moves when the test says so. */
  function steppedClock(): { clock: ProbeDeps['clock']; jump: (ms: number) => void } {
    let now = 0;
    return {
      clock: { wallClock: () => 1_700_000_000_000, monotonic: () => now },
      jump: (ms) => {
        now += ms;
      },
    };
  }

  it('stops the clock when the request fails, not when cleanup finishes', async () => {
    // total_ms is a latency M6 persists and reports on. Folding probeboard's
    // own dispatcher teardown into it describes our cleanup rather than the
    // endpoint -- a measurement NFR-5 commits to being trustworthy.
    const server = await serve(respond('{}'));
    const port = server.port;
    await server.close();
    started.splice(started.indexOf(server), 1);
    const { clock, jump } = steppedClock();

    const outcome = await probe(
      config({ url: `http://127.0.0.1:${port}/` }),
      deps({ clock, dispatcherFactory: teardownJumps(() => jump(10_000)) }),
    );

    expect(outcome.failureClass).toBe('CONNECTION_REFUSED');
    // The 10s belongs to teardown, which happens after the endpoint already
    // refused us.
    expect(outcome.timings.totalMs).toBeLessThan(10_000);
  });

  it('stops the clock when an over-budget redirect is decided', async () => {
    const server = await serve(redirect('/next'));
    const { clock, jump } = steppedClock();

    const outcome = await probe(
      config({ url: `${server.origin}/0`, maxRedirects: 0 }),
      deps({ clock, dispatcherFactory: teardownJumps(() => jump(10_000)) }),
    );

    expect(outcome.failureClass).toBe('TOO_MANY_REDIRECTS');
    expect(outcome.timings.totalMs).toBeLessThan(10_000);
  });
});

describe('probe, TLS', () => {
  it('records the certificate expiry of a healthy endpoint (FR-22)', async () => {
    const restore = trustFixtureCa();
    try {
      const server = await serve(respond('{}'), { cert: 'valid' });

      const outcome = await probe(config({ url: `https://localhost:${server.port}/` }), deps());

      expect(outcome.success).toBe(true);
      expect(outcome.certExpiresAt).toBeInstanceOf(Date);
      expect(outcome.timings.tlsMs).toBeGreaterThanOrEqual(0);
    } finally {
      restore();
    }
  });

  it.each([
    ['expired', 'TLS_EXPIRED'],
    ['self-signed', 'TLS_UNTRUSTED'],
  ] as const)('classifies a %s certificate as %s', async (cert, expected) => {
    const server = await serve(respond('{}'), { cert });

    const outcome = await probe(config({ url: `https://localhost:${server.port}/` }), deps());

    expect(outcome.failureClass).toBe(expected);
    expect(outcome.success).toBe(false);
  });

  it('keeps cert_expires_at for a certificate that was rejected for expiring', async () => {
    const server = await serve(respond('{}'), { cert: 'expired' });

    const outcome = await probe(config({ url: `https://localhost:${server.port}/` }), deps());

    expect(outcome.certExpiresAt).toEqual(new Date('Jan 1 00:00:00 2021 GMT'));
  });
});

describe('probe, secrets on the wire (D11, §3.8)', () => {
  it('keeps a decrypted header value out of the outcome, the error and the logs', async () => {
    // Forced CONNECTION_REFUSED with a secret header configured. probe()
    // never receives a "this one is secret" flag, so the proof is that the
    // plaintext appears nowhere -- not that something redacted it.
    const secret = 'sk-live-9f3a2b7c4d1e';
    const logged: string[] = [];
    for (const stream of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      });
    }

    const server = await serve(respond('{}'));
    const port = server.port;
    await server.close();
    started.splice(started.indexOf(server), 1);

    const outcome = await probe(
      config({ url: `http://127.0.0.1:${port}/`, headers: { Authorization: `Bearer ${secret}` } }),
      deps(),
    );

    expect(outcome.failureClass).toBe('CONNECTION_REFUSED');
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
  });

  it('never sends a secret header to a redirect target on another origin', async () => {
    const secret = 'sk-live-0000deadbeef';
    const destination = await serve(respond('{}'));
    const source = await serve(redirect(`${destination.origin}/final`));

    await probe(
      config({ url: source.origin, headers: { Authorization: `Bearer ${secret}` } }),
      deps(),
    );

    expect(JSON.stringify(destination.received[0].headers)).not.toContain(secret);
  });
});

describe('probe, clock discipline (D37)', () => {
  it('measures durations on the monotonic clock, unaffected by a wall-clock step', async () => {
    // An NTP step or an operator adjusting the clock mid-probe must not
    // produce a negative or wildly inflated total_ms for a measurement NFR-5
    // commits to being trustworthy.
    const server = await serve(respond('{}'));
    let wall = 1_700_000_000_000;
    let mono = 0;

    const outcome = await probe(
      config({ url: server.origin }),
      deps({
        clock: {
          wallClock: () => {
            const now = wall;
            wall -= 60_000; // jumps backwards on every read
            return now;
          },
          monotonic: () => {
            mono += 10;
            return mono;
          },
        },
      }),
    );

    expect(outcome.startedAt).toBe(1_700_000_000_000);
    expect(outcome.timings.totalMs).toBeGreaterThan(0);
  });
});
