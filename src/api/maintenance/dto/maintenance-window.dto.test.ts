import { describe, expect, it } from 'vitest';
import type { MaintenanceWindow } from '../../../core/db/types.js';
import { toMaintenanceWindowDto } from './maintenance-window-response.dto.js';
import {
  createMaintenanceWindowSchema,
  maintenanceWindowQuerySchema,
  updateMaintenanceWindowSchema,
} from './maintenance-window.dto.js';

const SERVICE = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const times = { startsAt: '2033-03-10T10:00:00Z', endsAt: '2033-03-10T11:00:00+01:00' };

describe('createMaintenanceWindowSchema', () => {
  it('accepts one target with offset-bearing times', () => {
    expect(createMaintenanceWindowSchema.safeParse({ serviceId: SERVICE, ...times }).success).toBe(
      false, // 11:00+01:00 is 10:00Z: not after startsAt
    );
    const ok = { startsAt: times.startsAt, endsAt: '2033-03-10T12:00:00+01:00' };
    expect(createMaintenanceWindowSchema.safeParse({ serviceId: SERVICE, ...ok }).success).toBe(
      true,
    );
    expect(createMaintenanceWindowSchema.safeParse({ endpointId: ENDPOINT, ...ok }).success).toBe(
      true,
    );
  });

  it('refuses both targets, neither, an unknown field and a time without an offset', () => {
    const ok = { startsAt: times.startsAt, endsAt: '2033-03-10T12:00:00Z' };
    for (const body of [
      { serviceId: SERVICE, endpointId: ENDPOINT, ...ok },
      { ...ok },
      { serviceId: SERVICE, ...ok, recurring: true },
      { serviceId: SERVICE, startsAt: '2033-03-10T10:00:00', endsAt: ok.endsAt },
    ]) {
      expect(createMaintenanceWindowSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('bounds the reason', () => {
    const ok = { serviceId: SERVICE, startsAt: times.startsAt, endsAt: '2033-03-10T12:00:00Z' };
    expect(
      createMaintenanceWindowSchema.safeParse({ ...ok, reason: 'x'.repeat(500) }).success,
    ).toBe(true);
    expect(
      createMaintenanceWindowSchema.safeParse({ ...ok, reason: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(createMaintenanceWindowSchema.safeParse({ ...ok, reason: '' }).success).toBe(false);
  });
});

describe('updateMaintenanceWindowSchema', () => {
  it('lets reason be cleared with null, and refuses a target', () => {
    expect(updateMaintenanceWindowSchema.safeParse({ reason: null }).success).toBe(true);
    expect(updateMaintenanceWindowSchema.safeParse({ serviceId: SERVICE }).success).toBe(false);
  });
});

describe('maintenanceWindowQuerySchema', () => {
  it('reads active as a boolean, and refuses anything but true or false', () => {
    expect(maintenanceWindowQuerySchema.parse({ active: 'true' }).active).toBe(true);
    expect(maintenanceWindowQuerySchema.parse({ active: 'false' }).active).toBe(false);
    expect(maintenanceWindowQuerySchema.parse({}).active).toBeUndefined();
    expect(maintenanceWindowQuerySchema.safeParse({ active: '1' }).success).toBe(false);
  });
});

describe('toMaintenanceWindowDto', () => {
  const w: MaintenanceWindow = {
    id: 'w-1',
    user_id: 'u-1',
    service_id: SERVICE,
    endpoint_id: null,
    starts_at: new Date('2033-03-10T10:00:00Z'),
    ends_at: new Date('2033-03-10T11:00:00Z'),
    reason: null,
    created_at: new Date('2033-03-01T00:00:00Z'),
    updated_at: new Date('2033-03-01T00:00:00Z'),
  };

  it('is active on [startsAt, endsAt): in at the start, out at the end', () => {
    expect(toMaintenanceWindowDto(w, w.starts_at.getTime()).active).toBe(true);
    expect(toMaintenanceWindowDto(w, w.ends_at.getTime() - 1).active).toBe(true);
    expect(toMaintenanceWindowDto(w, w.ends_at.getTime()).active).toBe(false);
    expect(toMaintenanceWindowDto(w, w.starts_at.getTime() - 1).active).toBe(false);
  });

  it('maps every field', () => {
    expect(toMaintenanceWindowDto(w, 0)).toEqual({
      id: 'w-1',
      serviceId: SERVICE,
      endpointId: null,
      startsAt: '2033-03-10T10:00:00.000Z',
      endsAt: '2033-03-10T11:00:00.000Z',
      reason: null,
      active: false,
      createdAt: '2033-03-01T00:00:00.000Z',
      updatedAt: '2033-03-01T00:00:00.000Z',
    });
  });
});
