import { promises as dns } from 'node:dns';
import { Agent } from 'undici';
import type { AppConfig } from '../../core/config/schema.js';
import { createConnector, type PinnedConnectOptions, type ProbeDeps } from '../probing/index.js';

/**
 * Assembles the real `ProbeDeps` from config -- the first production caller
 * of `probe()`. M3 built everything here injectable specifically so the
 * scheduler would not need its own copy: `resolve4`/`resolve6`, the real
 * clock, and `createConnector` wrapped in an `Agent` exactly as M3's own
 * "real dispatcher" test helper does (`probe.test.ts`), because that pairing
 * -- one `Agent` per call, built from the per-hop pin options `probe()`
 * passes in -- is what M3's pinning proof depends on.
 */
export function createProbeDeps(cfg: AppConfig): ProbeDeps {
  return {
    resolver: {
      resolve4: (hostname) => dns.resolve4(hostname),
      resolve6: (hostname) => dns.resolve6(hostname),
    },
    clock: { wallClock: () => Date.now(), monotonic: () => performance.now() },
    dispatcherFactory: (options: PinnedConnectOptions) =>
      new Agent({ connect: createConnector(options) }),
    ssrf: { enabled: cfg.SSRF_GUARD_ENABLED, blockedPorts: cfg.SSRF_BLOCKED_PORTS },
    maxTimeoutMs: cfg.PROBE_MAX_TIMEOUT_MS,
    maxBodyBytes: cfg.PROBE_MAX_BODY_BYTES,
    maxRedirectsCap: cfg.PROBE_MAX_REDIRECTS_CAP,
  };
}
