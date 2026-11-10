import type { Endpoint, EndpointHealth, Header, Tag } from '../../../core/db/types.js';
import { type EffectiveState, effectiveState } from '../utils/effective-state.js';
import { type HeaderDto, mergeHeaders, toHeaderDto } from '../services/header-storage.service.js';
import { toTagDto, type TagDto } from './tag.dto.js';

export interface EndpointDto {
  id: string;
  serviceId: string;
  method: string;
  path: string;
  intervalS: number;
  timeoutMs: number;
  expectedStatus: { min: number; max: number }[];
  latencyWarnMs: number | null;
  failureThreshold: number;
  successThreshold: number;
  followRedirects: boolean;
  maxRedirects: number;
  assertions: unknown[];
  enabled: boolean;
  /** This endpoint's own headers only -- never the merged set (docs/m2-plan.md §5.2). */
  headers: HeaderDto[];
  /** `{...serviceHeaders, ...endpointHeaders}`, endpoint wins by name (B-4). */
  effectiveHeaders: HeaderDto[];
  tags: TagDto[];
  createdAt: string;
  updatedAt: string;
}

export function toEndpointDto(
  endpoint: Endpoint,
  endpointHeaders: Header[],
  serviceHeaders: Header[],
  tags: Tag[],
): EndpointDto {
  return {
    id: endpoint.id,
    serviceId: endpoint.service_id,
    method: endpoint.method,
    path: endpoint.path,
    intervalS: endpoint.interval_s,
    timeoutMs: endpoint.timeout_ms,
    expectedStatus: endpoint.expected_status,
    latencyWarnMs: endpoint.latency_warn_ms,
    failureThreshold: endpoint.failure_threshold,
    successThreshold: endpoint.success_threshold,
    followRedirects: endpoint.follow_redirects,
    maxRedirects: endpoint.max_redirects,
    assertions: endpoint.assertions,
    enabled: endpoint.enabled,
    headers: endpointHeaders.map(toHeaderDto),
    effectiveHeaders: mergeHeaders(serviceHeaders, endpointHeaders),
    tags: tags.map(toTagDto),
    createdAt: endpoint.created_at.toISOString(),
    updatedAt: endpoint.updated_at.toISOString(),
  };
}

/**
 * The current state on `GET /v1/endpoints/:id` (docs/m6-plan.md §3.10), so a
 * client can say "failing, 2 of 3" (03 §3.7). Lists stay without it: the
 * list's current status is M8's (FR-10).
 */
export interface EndpointHealthDto {
  state: EffectiveState;
  /** When that state began; `null` for paused, and for an endpoint never evaluated. */
  stateSince: string | null;
  consecutiveFailures: number;
  failureThreshold: number;
  openIncidentId: string | null;
  lastSuccessAt: string | null;
}

export type EndpointDetailDto = EndpointDto & { health: EndpointHealthDto };

export function toEndpointHealthDto(
  endpoint: Endpoint,
  stored: EndpointHealth | undefined,
  maintenanceSince: Date | null,
): EndpointHealthDto {
  const effective = effectiveState({
    enabled: endpoint.enabled,
    maintenanceSince,
    stored: stored ? { state: stored.state, stateSince: stored.state_since } : null,
  });
  return {
    state: effective.state,
    stateSince: effective.since?.toISOString() ?? null,
    consecutiveFailures: stored?.consecutive_failures ?? 0,
    failureThreshold: endpoint.failure_threshold,
    openIncidentId: stored?.open_incident_id ?? null,
    lastSuccessAt: stored?.last_success_at?.toISOString() ?? null,
  };
}
