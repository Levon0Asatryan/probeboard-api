/**
 * Partition periods, in UTC and nothing else.
 *
 * Bounds and names are computed here from `Date.UTC`, never from a session
 * time zone, so a partition's range and its name cannot disagree with each
 * other or between workers (docs/m5-plan.md §3.6).
 */

export type PeriodKind = 'day' | 'month';

export interface Period {
  /** `YYYYMMDD` for a day, `YYYYMM` for a month. */
  suffix: string;
  from: Date;
  to: Date;
}

/** One partitioned parent that the maintenance job keeps ahead of need. */
export interface PartitionFamily {
  /** A constant of this codebase, never user input -- it is interpolated as an identifier. */
  parent: string;
  kind: PeriodKind;
}

export const PARTITION_FAMILIES: readonly PartitionFamily[] = [
  { parent: 'probe_results', kind: 'day' },
  { parent: 'claim_log', kind: 'day' },
  { parent: 'probe_stats_m1', kind: 'day' },
  { parent: 'probe_stats_h1', kind: 'month' },
];

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

export function periodStart(kind: PeriodKind, at: Date): Date {
  return kind === 'day'
    ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
    : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function nextPeriodStart(kind: PeriodKind, start: Date): Date {
  return kind === 'day'
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1))
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

export function periodSuffix(kind: PeriodKind, start: Date): string {
  const ym = `${pad(start.getUTCFullYear(), 4)}${pad(start.getUTCMonth() + 1, 2)}`;
  return kind === 'day' ? `${ym}${pad(start.getUTCDate(), 2)}` : ym;
}

/** Every period whose start lies in `[periodStart(from), to]`, oldest first. */
export function periodsCovering(kind: PeriodKind, from: Date, to: Date): Period[] {
  const out: Period[] = [];
  for (let start = periodStart(kind, from); start <= to; start = nextPeriodStart(kind, start)) {
    out.push({ suffix: periodSuffix(kind, start), from: start, to: nextPeriodStart(kind, start) });
  }
  return out;
}

export function partitionName(family: PartitionFamily, period: Pick<Period, 'suffix'>): string {
  return `${family.parent}_p${period.suffix}`;
}

/** `now + months`, in UTC, clamped to day 1 so month arithmetic never overflows. */
export function addUtcMonths(at: Date, months: number): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1));
}

export function addUtcDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

/** The UTC start of the period a partition suffix names, or `null` if it is not one. */
export function periodFromSuffix(kind: PeriodKind, suffix: string): Date | null {
  const pattern = kind === 'day' ? /^(\d{4})(\d{2})(\d{2})$/ : /^(\d{4})(\d{2})$/;
  const m = pattern.exec(suffix);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = kind === 'day' ? Number(m[3]) : 1;
  const start = new Date(Date.UTC(y, mo - 1, d));
  // Reject a suffix Date.UTC would silently normalise (month 13, day 32).
  return start.getUTCFullYear() === y && start.getUTCMonth() === mo - 1 && start.getUTCDate() === d
    ? start
    : null;
}
