import { describe, expect, it } from 'vitest';
import type { Incident } from '../../../core/db/types.js';
import { toIncidentDto } from './incident-response.dto.js';

const base: Incident = {
  id: 'i-1',
  endpoint_id: 'e-1',
  service_id: 's-1',
  user_id: 'u-1',
  opened_at: new Date('2033-03-10T10:01:00Z'),
  confirmed_at: new Date('2033-03-10T10:03:00Z'),
  failures_to_open: 3,
  cause_class: 'connection_refused',
  cause_code: 'ECONNREFUSED',
  cause_status_code: null,
  cause_detail: null,
  closed_at: null,
  close_confirmed_at: null,
};

describe('toIncidentDto (docs/m6-plan.md §3.10)', () => {
  it('times a closed incident from its first failure to its first success', () => {
    const dto = toIncidentDto({
      ...base,
      closed_at: new Date('2033-03-10T10:04:00Z'),
      close_confirmed_at: new Date('2033-03-10T10:05:00Z'),
    });
    expect(dto).toMatchObject({
      status: 'closed',
      durationMs: 180_000,
      detectionLatencyMs: 120_000,
      closedAt: '2033-03-10T10:04:00.000Z',
      closeConfirmedAt: '2033-03-10T10:05:00.000Z',
    });
  });

  it('has no duration while open, and still reports the detection latency', () => {
    expect(toIncidentDto(base)).toMatchObject({
      status: 'open',
      durationMs: null,
      closedAt: null,
      closeConfirmedAt: null,
      detectionLatencyMs: 120_000,
    });
  });

  it('carries the cause as copied, including which assertion failed', () => {
    const detail = {
      index: 0,
      code: 'value_mismatch' as const,
      assertion: { type: 'json_path' as const, path: '$.ok', equals: true },
    };
    expect(
      toIncidentDto({
        ...base,
        cause_class: 'assertion_failed',
        cause_code: null,
        cause_status_code: 200,
        cause_detail: detail,
      }).cause,
    ).toEqual({ class: 'assertion_failed', code: null, statusCode: 200, assertion: detail });
  });
});
