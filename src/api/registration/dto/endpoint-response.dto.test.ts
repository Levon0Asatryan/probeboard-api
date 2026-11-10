import { describe, expect, it } from 'vitest';
import { toEndpointDto, toEndpointHealthDto } from './endpoint-response.dto.js';
import type { Endpoint, EndpointHealth, Header } from '../../../core/db/types.js';

const endpoint: Endpoint = {
  id: 'ep-1',
  service_id: 'svc-1',
  user_id: 'user-1',
  method: 'GET',
  path: '/orders',
  interval_s: 60,
  timeout_ms: 10000,
  expected_status: [{ min: 200, max: 299 }],
  latency_warn_ms: null,
  failure_threshold: 3,
  success_threshold: 2,
  follow_redirects: true,
  max_redirects: 5,
  assertions: [],
  enabled: true,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
};

function header(name: string, value: string, id = name): Header {
  return {
    id,
    service_id: null,
    endpoint_id: 'ep-1',
    name,
    is_secret: false,
    value,
    secret_ciphertext: null,
    secret_iv: null,
    secret_auth_tag: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('toEndpointDto', () => {
  it('maps every scalar field', () => {
    const dto = toEndpointDto(endpoint, [], [], []);
    expect(dto).toMatchObject({
      id: 'ep-1',
      serviceId: 'svc-1',
      method: 'GET',
      path: '/orders',
      intervalS: 60,
      timeoutMs: 10000,
      expectedStatus: [{ min: 200, max: 299 }],
      latencyWarnMs: null,
      failureThreshold: 3,
      successThreshold: 2,
      followRedirects: true,
      maxRedirects: 5,
      assertions: [],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it("headers is the endpoint's own set only, unmerged", () => {
    const dto = toEndpointDto(
      endpoint,
      [header('X-Foo', 'endpoint-value')],
      [header('X-Bar', 'svc')],
      [],
    );
    expect(dto.headers).toEqual([{ name: 'X-Foo', isSecret: false, value: 'endpoint-value' }]);
  });

  it('effectiveHeaders merges service and endpoint headers, endpoint winning by name (B-4)', () => {
    const dto = toEndpointDto(
      endpoint,
      [header('X-Api-Key', 'endpoint-value')],
      [header('x-api-key', 'service-value'), header('X-Other', 'other')],
      [],
    );
    const byName = Object.fromEntries(dto.effectiveHeaders.map((h) => [h.name.toLowerCase(), h]));
    expect(byName['x-api-key']).toMatchObject({ value: 'endpoint-value' });
    expect(byName['x-other']).toMatchObject({ value: 'other' });
    expect(dto.effectiveHeaders).toHaveLength(2);
  });

  it('maps tags', () => {
    const dto = toEndpointDto(
      endpoint,
      [],
      [],
      [{ id: 't1', service_id: null, endpoint_id: 'ep-1', key: 'env', value: 'prod' }],
    );
    expect(dto.tags).toEqual([{ key: 'env', value: 'prod' }]);
  });
});

describe('toEndpointHealthDto (docs/m6-plan.md §3.10)', () => {
  const stored: EndpointHealth = {
    endpoint_id: endpoint.id,
    state: 'pending',
    state_since: new Date('2033-03-10T10:01:00Z'),
    consecutive_failures: 2,
    consecutive_successes: 0,
    run_started_at: new Date('2033-03-10T10:01:00Z'),
    run_failure_class: 'connection_refused',
    run_failure_code: null,
    run_status_code: null,
    run_failure_detail: null,
    recovery_started_at: null,
    open_incident_id: null,
    last_success_at: new Date('2033-03-10T10:00:00Z'),
    applied_started_at: null,
    applied_attempt_id: null,
    updated_at: new Date('2033-03-10T10:01:05Z'),
  };

  it('reports the stored run against the threshold: failing, 2 of N', () => {
    expect(toEndpointHealthDto(endpoint, stored, null)).toEqual({
      state: 'pending',
      stateSince: '2033-03-10T10:01:00.000Z',
      consecutiveFailures: 2,
      failureThreshold: endpoint.failure_threshold,
      openIncidentId: null,
      lastSuccessAt: '2033-03-10T10:00:00.000Z',
    });
  });

  it('is unknown with zero failures for an endpoint never evaluated', () => {
    expect(toEndpointHealthDto(endpoint, undefined, null)).toMatchObject({
      state: 'unknown',
      stateSince: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
    });
  });

  it('lets a window covering now override the stored state, keeping the counters', () => {
    const since = new Date('2033-03-10T09:00:00Z');
    expect(toEndpointHealthDto(endpoint, stored, since)).toMatchObject({
      state: 'maintenance',
      stateSince: since.toISOString(),
      consecutiveFailures: 2,
    });
  });
});
