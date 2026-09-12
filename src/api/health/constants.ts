/**
 * The health endpoint paths, defined once.
 *
 * They appear in two places — the controller's route decorators and the global
 * prefix exclusions — and renaming one without the other would silently move a
 * health endpoint under `/v1`, where an orchestrator would not find it.
 */
export const LIVENESS_PATH = 'healthz';
export const READINESS_PATH = 'readyz';

export const HEALTH_PATHS = [LIVENESS_PATH, READINESS_PATH];
