/**
 * The probe executor: one endpoint, one result.
 *
 * Pure by construction — no database, no scheduler, no global state
 * (architecture §7.4). Everything that would otherwise reach outside is a
 * dependency: the resolver, the clock, and the dispatcher factory. That is
 * what lets the deadline, the DNS answers and the transport all be driven
 * deterministically in tests, and it is why `probe()` takes a plain config
 * object rather than an `Endpoint` row.
 *
 * The redirect loop is hand-rolled rather than delegated to the HTTP client
 * (`redirect: 'manual'`), because every CVE in §2.5's corpus is the same bug:
 * the first URL is validated, the client auto-follows a `3xx`, and the target
 * is never re-checked. Following manually is what makes re-validating each
 * hop possible at all.
 */
import { fetch, type Dispatcher, type Response } from 'undici';
import {
  assertSaveableUrl,
  type DnsResolver,
  type SsrfGuardConfig,
} from '../../../core/ssrf/host-validator.js';
import type { EndpointAssertion, StatusRange } from '../../../core/db/types.js';
import { evaluateAssertions } from '../assertions/evaluate.js';
import { readCappedBody } from './body-cap.js';
import {
  classifyAbort,
  classifyError,
  isAbortError,
  type FailureClass,
} from './failure-classes.js';
import type { PinnedConnectOptions, TlsVerdict } from './pinned-connect.js';
import { headersForHop, isFollowedRedirect, methodForRedirect } from './redirect-rules.js';
import { classifyGuardRejection, isGuardRejection } from './ssrf-pin.js';
import { createTiming, type Clock, type DerivedPhases } from './timing.js';

/** What `probe()` needs to know about one endpoint. Never an `Endpoint` row. */
export interface EndpointProbeConfig {
  /** Carried through to the outcome so a caller can correlate it. */
  monitorId: string;
  url: string;
  method: string;
  /**
   * The effective headers, **already decrypted** (D11). `probe()` never sees
   * ciphertext, a key, or a "this one is secret" flag — which is precisely
   * what makes it impossible for a secret to reach the outcome or a log: no
   * code path here holds a reference to which values were sensitive.
   */
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** Empty means "any 2xx", per FR-6. */
  expectedStatus: readonly StatusRange[];
  assertions: readonly EndpointAssertion[];
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
}

export interface ProbeDeps {
  resolver: DnsResolver;
  clock: Clock;
  dispatcherFactory: (options: PinnedConnectOptions) => Dispatcher;
  ssrf: SsrfGuardConfig;
  /** PROBE_MAX_TIMEOUT_MS. The deadline is the lesser of this and the config's. */
  maxTimeoutMs: number;
  /** PROBE_MAX_BODY_BYTES. */
  maxBodyBytes: number;
  /** PROBE_MAX_REDIRECTS_CAP. */
  maxRedirectsCap: number;
}

export interface ProbeOutcome {
  monitorId: string;
  /** Wall-clock instant the probe began — the one non-monotonic value (D37). */
  startedAt: number;
  success: boolean;
  /** The evaluated response's status, when one was received. */
  status?: number;
  /** Absent on success. */
  failureClass?: FailureClass;
  /**
   * The raw signal behind the class, kept even when unrecognised so an
   * operator is never sent to the wrong system by a plausible-looking guess
   * (architecture §7.4).
   */
  code?: string;
  /** Phase boundaries for the final hop, plus `totalMs` for the whole probe. */
  timings: DerivedPhases;
  /** The earliest expiry in the presented chain (FR-22). */
  certExpiresAt?: Date;
  /** Whether the body cap cut the read short. */
  truncated: boolean;
  /** How many redirects were followed. */
  redirects: number;
}

/** A terminal decision, before it is dressed up as a `ProbeOutcome`. */
interface Verdict {
  success: boolean;
  status?: number;
  failureClass?: FailureClass;
  code?: string;
  truncated?: boolean;
}

/** FR-6: no configured ranges means "any 2xx". */
function statusMatches(status: number, expected: readonly StatusRange[]): boolean {
  if (expected.length === 0) return status >= 200 && status < 300;
  return expected.some((range) => status >= range.min && status <= range.max);
}

/**
 * A promise that rejects when the deadline fires.
 *
 * Used to race DNS (D44). Node cannot cancel an in-flight `dns.resolve`, so
 * the underlying call still runs to completion — its late result is simply
 * discarded. Without the race, a name server that never answers holds the
 * probe open past `timeout_ms` regardless of every other bound, because the
 * guard runs before any socket the `AbortSignal` could reach.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

/**
 * Closes a hop's dispatcher without letting teardown mask the real outcome.
 *
 * `destroy()`, never `close()`. `close()` is the graceful form: it waits for
 * in-flight requests to finish, and on exactly the hops this is called for —
 * a connect that never completed, a body that stalled, a `3xx` discarded
 * mid-stream — there is a request that never finishes, so the cleanup itself
 * hangs past the deadline it exists to honour. Measured: with `close()` the
 * deadline test does not return at all and dies at the runner's 5s timeout.
 * Every hop here is already finished with, so there is nothing to be graceful
 * about.
 */
async function closeDispatcher(dispatcher: Dispatcher | undefined): Promise<void> {
  if (dispatcher === undefined) return;
  try {
    await dispatcher.destroy();
  } catch {
    // A dispatcher that is already destroyed, or whose socket died, throws
    // here. The probe's result is already decided; letting cleanup overwrite
    // it would report a failure for a probe that succeeded.
  }
}

/** Discards a hop we are not going to evaluate (D26, D46). */
async function discardHop(response: Response, dispatcher: Dispatcher | undefined): Promise<void> {
  try {
    // `cancel()` on the stream, not through a reader: nothing ever read this
    // body, so nothing holds a lock on it. The evaluated response is the
    // opposite case and goes through body-cap's `releaseLock` instead (D38).
    await response.body?.cancel();
  } catch {
    // Already errored or consumed. Nothing to release either way.
  }
  await closeDispatcher(dispatcher);
}

/**
 * Probes one endpoint and reports what happened.
 *
 * Never throws for a network condition: every failure the taxonomy has a row
 * for comes back as a `ProbeOutcome` with a `failureClass`. A thrown error
 * from here would mean a bug in probeboard, not a problem with the endpoint.
 */
export async function probe(config: EndpointProbeConfig, deps: ProbeDeps): Promise<ProbeOutcome> {
  // D24: the unconditional anchor, before any validation. Anchoring on
  // `dns_start` instead leaves `total_ms` uncomputable for an IP-literal
  // target and for every cheap policy rejection.
  const timing = createTiming(deps.clock);

  // D35: the persisted timeout is not trusted on its own. An endpoint saved
  // before the cap was lowered would otherwise keep its old, larger budget.
  const deadlineMs = Math.min(config.timeoutMs, deps.maxTimeoutMs);
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new DOMException('probe deadline exceeded', 'TimeoutError'));
  }, deadlineMs);
  deadline.unref?.();

  const origin = new URL(config.url);
  const maxRedirects = Math.min(config.maxRedirects, deps.maxRedirectsCap);

  let target = origin;
  let method = config.method.toUpperCase();
  let headers: Record<string, string> = { ...config.headers };
  let headersDropped = false;
  let redirects = 0;
  let certExpiresAt: Date | undefined;

  try {
    for (;;) {
      // D45: never automatic. A `3xx` has headers, so `first_byte` is set for
      // that hop; a stale one would make the abort classifier report a body
      // stall for a hop that never got that far.
      if (redirects > 0) timing.resetHop();

      const verdict = await attemptHop();
      if (verdict !== undefined) return finish(verdict);
    }
  } catch (error) {
    timing.markTerminal('failed_at');
    // D16: which phase the deadline fired in is read from the boundaries,
    // because an abort carries none of undici's phase-timeout codes.
    //
    // Measured rather than assumed: undici propagates the `DOMException` we
    // abort with, so the error arrives here with `name: 'TimeoutError'` and
    // `isAbortError` recognises it. An additional `controller.signal.aborted`
    // check was tried and removed — no test could tell the difference, which
    // makes it unproven code, not defence in depth.
    const classification = isAbortError(error)
      ? {
          failureClass: classifyAbort(timing.boundaries(), { https: target.protocol === 'https:' }),
        }
      : classifyError(error);
    return outcome({ success: false, ...classification });
  } finally {
    clearTimeout(deadline);
  }

  /**
   * One hop. Returns a verdict when the probe is over, or `undefined` to
   * follow a redirect.
   */
  async function attemptHop(): Promise<Verdict | undefined> {
    // Re-run for every hop, with no special case for "this is a redirect"
    // (D29). The guard does not distinguish them and neither does the
    // classification built on it -- a redirect to a name that fails DNS is a
    // DNS failure, not a policy refusal.
    let pin: PinnedConnectOptions;
    try {
      timing.mark('dns_start');
      pin = await Promise.race([resolvePin(), rejectOnAbort(controller.signal)]);
      timing.mark('dns_done');
    } catch (error) {
      if (isGuardRejection(error)) {
        timing.markTerminal('blocked_at');
        return { success: false, ...classifyGuardRejection(error) };
      }
      throw error;
    }

    const dispatcher = deps.dispatcherFactory({
      ...pin,
      onBoundary: (boundary) => timing.mark(boundary),
      onTls: (tls: TlsVerdict) => {
        // Recorded whether or not the peer was authorised: an expired
        // certificate is exactly where cert_expires_at earns its keep.
        certExpiresAt = tls.certExpiresAt ?? certExpiresAt;
      },
      timeoutMs: deadlineMs,
    });

    let response: Response;
    try {
      response = await fetch(target, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : config.body,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
      });
    } catch (error) {
      // The dispatcher is closed here rather than in a `finally`: on the
      // success path it has to outlive this block, because the response body
      // is still being streamed through it (D41).
      await closeDispatcher(dispatcher);
      throw error;
    }

    // D21: the moment the status line and headers arrive, not the first body
    // chunk. Calling it at the first chunk would report a bodyless 204 as
    // having no time to first byte at all.
    timing.mark('first_byte');

    const followable = config.followRedirects && isFollowedRedirect(response.status);
    if (!followable) return evaluate(response, dispatcher);

    if (redirects >= maxRedirects) {
      // D46: the over-budget `3xx` is the last iteration but is still a
      // discarded hop, not an evaluated one. Left to the evaluated path it
      // would stall on an unread streaming body until the deadline.
      await discardHop(response, dispatcher);
      timing.markTerminal('failed_at');
      return { success: false, failureClass: 'TOO_MANY_REDIRECTS' };
    }

    const location = response.headers.get('location');
    if (location === null || location === '') {
      // A followed status with no Location is not a redirect we can act on.
      return evaluate(response, dispatcher);
    }

    // Parsed before anything else is touched, and inside its own try: a
    // malformed `Location` throws, and thrown from here it would escape past
    // `discardHop` below, leaving this hop's body streaming and its
    // dispatcher open for the rest of the process's life.
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      await discardHop(response, dispatcher);
      timing.markTerminal('failed_at');
      // No taxonomy row fits a `3xx` whose Location is not a URL, and
      // inventing a plausible-looking one would send an operator to the
      // wrong system (architecture §7.4). The raw signal is kept instead.
      return { success: false, failureClass: 'UNKNOWN_ERROR', code: 'INVALID_LOCATION' };
    }

    const nextMethod = methodForRedirect(response.status, method);
    const hop = headersForHop({
      headers,
      target: next,
      origin,
      alreadyDropped: headersDropped,
      rewrittenToGet: nextMethod !== method,
    });

    await discardHop(response, dispatcher);

    target = next;
    method = nextMethod;
    headers = hop.headers;
    headersDropped = hop.dropped;
    redirects += 1;
    return undefined;
  }

  /** Resolves and classifies this hop's target, yielding what to pin to. */
  async function resolvePin(): Promise<PinnedConnectOptions> {
    const validated = await assertSaveableUrl(target.toString(), deps.ssrf, deps.resolver);
    // D19: a *disabled* guard short-circuits before resolving and returns no
    // addresses, so there is nothing to pin to and an unpinned connector is
    // what "disabled" means. An *enabled* guard with no addresses never gets
    // here -- that is the URL_UNRESOLVABLE rejection above.
    if (!deps.ssrf.enabled || validated.addresses.length === 0) return {};
    // D9: the first address in resolution order, and only that one. A
    // fallback to the second would connect somewhere the first check did not
    // authorise.
    return { address: validated.addresses[0] };
  }

  /** Reads and judges the one response that is actually evaluated. */
  async function evaluate(response: Response, dispatcher: Dispatcher): Promise<Verdict> {
    try {
      const body = await readCappedBody(response.body, deps.maxBodyBytes);
      timing.markTerminal('transfer_done');

      if (!statusMatches(response.status, config.expectedStatus)) {
        return {
          success: false,
          status: response.status,
          failureClass: 'STATUS_MISMATCH',
          truncated: body.truncated,
        };
      }

      const assertion = evaluateAssertions(config.assertions, body);
      if (!assertion.passed) {
        return {
          success: false,
          status: response.status,
          failureClass: 'ASSERTION_FAILED',
          truncated: body.truncated,
        };
      }

      return { success: true, status: response.status, truncated: body.truncated };
    } finally {
      // D41: the final hop's dispatcher, closed after the reader was
      // released and never by cancelling a stream a reader still holds.
      // Without this every ordinary one-hop probe leaks a socket.
      await closeDispatcher(dispatcher);
    }
  }

  function finish(verdict: Verdict): ProbeOutcome {
    // D22: every terminal path records a boundary, or `total_ms` would be
    // uncomputable for most of the taxonomy.
    if (!timing.hasEnded()) timing.markTerminal(verdict.success ? 'transfer_done' : 'failed_at');
    return outcome(verdict);
  }

  function outcome(verdict: Verdict): ProbeOutcome {
    return {
      monitorId: config.monitorId,
      startedAt: timing.startedAt,
      success: verdict.success,
      status: verdict.status,
      failureClass: verdict.failureClass,
      code: verdict.code,
      timings: timing.derived(),
      certExpiresAt,
      truncated: verdict.truncated ?? false,
      redirects,
    };
  }
}
