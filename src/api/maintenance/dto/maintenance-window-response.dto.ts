import type { MaintenanceWindow } from '../../../core/db/types.js';

export interface MaintenanceWindowDto {
  id: string;
  serviceId: string | null;
  endpointId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  /** Covers `now`: `startsAt <= now < endsAt`. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toMaintenanceWindowDto(w: MaintenanceWindow, now: number): MaintenanceWindowDto {
  return {
    id: w.id,
    serviceId: w.service_id,
    endpointId: w.endpoint_id,
    startsAt: w.starts_at.toISOString(),
    endsAt: w.ends_at.toISOString(),
    reason: w.reason,
    active: w.starts_at.getTime() <= now && now < w.ends_at.getTime(),
    createdAt: w.created_at.toISOString(),
    updatedAt: w.updated_at.toISOString(),
  };
}
