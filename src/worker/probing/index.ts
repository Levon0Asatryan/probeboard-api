/**
 * The probing module's public surface.
 *
 * M4's scheduler imports `probe()` from here rather than reaching into
 * `utils/`, so the executor's internals stay free to move without touching
 * the caller. Nothing else in the module is exported: the helpers are
 * implementation detail, tested directly beside their own files.
 */
export { probe } from './utils/probe.js';
export type { EndpointProbeConfig, ProbeDeps, ProbeOutcome } from './utils/probe.js';
export { createConnector } from './utils/pinned-connect.js';
export type { PinnedConnectOptions, TlsVerdict } from './utils/pinned-connect.js';
export type { Clock } from './utils/timing.js';
export type { FailureClass } from './utils/failure-classes.js';
