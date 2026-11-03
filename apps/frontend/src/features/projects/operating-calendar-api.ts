/**
 * F-A1-2 client of the merged A1 project operating calendar API (#92,
 * docs/api/project-operating-calendar.md). Uses only GET/PATCH
 * `/projects/{id}/operating-calendar`; tenant and role are never sent.
 *
 * The PATCH preconditions (exact version of the edited month, effective
 * version, next applicability boundary) are always derived from the read the
 * administrator reviewed (`basis`), never assembled by a screen. Responses are
 * shape-checked; a defect is an `invalid-response` error (for a write: outcome
 * unknown, the caller must read again before another write).
 */
import { ApiError } from '../../shared/api/api-error';
import type { MonthKey } from '../../shared/time/month';
import type { SessionApi } from '../auth/session-api';
import { monthStartOf } from './project-assignments-api';

/** ISO weekday: Monday = 1 … Sunday = 7 (display order Mo–So). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

export type CalendarVersionRef = { id: string; version: number };

export type CalendarRead = {
  projectId: string;
  /** The month the read is for (`YYYY-MM`). */
  month: MonthKey;
  state: 'CONFIGURED' | 'MISSING';
  /** The version in force for `month` (own or from an earlier month), or null when MISSING. */
  effective: (CalendarVersionRef & { effectiveFromMonth: MonthKey; operatingWeekdays: IsoWeekday[] }) | null;
  /** The version stored for exactly `month`, or null. */
  exactVersion: CalendarVersionRef | null;
  /** First month of the next stored version after `month`, or null. */
  nextEffectiveFromMonth: MonthKey | null;
};

export type CalendarWriteResult = CalendarRead & { outcome: 'APPLIED' | 'NO_OP' };

export type CalendarWrite = {
  /** The read the administrator reviewed; its month is the month written. */
  basis: CalendarRead;
  operatingWeekdays: readonly IsoWeekday[];
  /** The approved one-time historical bootstrap (only valid without any stored version). */
  bootstrap: boolean;
};

export interface OperatingCalendarApi {
  get(projectId: string, month: MonthKey, signal?: AbortSignal): Promise<CalendarRead>;
  replace(projectId: string, write: CalendarWrite): Promise<CalendarWriteResult>;
}

/**
 * True exactly when the project has no stored calendar version at all: the read
 * finds neither a version at/before the month nor one after it. Only then can
 * the one-time bootstrap be requested (the server still decides the month).
 */
export function hasNoCalendarVersions(read: CalendarRead): boolean {
  return read.state === 'MISSING' && read.nextEffectiveFromMonth === null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_START = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

function toMonth(value: unknown): MonthKey {
  if (typeof value !== 'string' || !MONTH_START.test(value)) invalid();
  return (value as string).slice(0, 7);
}

function toRef(value: unknown): CalendarVersionRef {
  if (!isRecord(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) invalid();
  return { id: (value.id as string).toLowerCase(), version: value.version as number };
}

/** 1–7 distinct ISO weekdays in ascending order, as the server sends them. */
function toWeekdays(value: unknown): IsoWeekday[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) invalid();
  const days = value as unknown[];
  days.forEach((day, index) => {
    if (typeof day !== 'number' || !ISO_WEEKDAYS.includes(day as IsoWeekday)) invalid();
    if (index > 0 && (day as number) <= (days[index - 1] as number)) invalid();
  });
  return days as IsoWeekday[];
}

export function toCalendarRead(value: unknown, projectId: string, month: MonthKey): CalendarRead {
  if (!isRecord(value) || typeof value.projectId !== 'string') invalid();
  // An answer for another project or month is a contract defect, never shown.
  if ((value.projectId as string).toLowerCase() !== projectId.toLowerCase()) invalid();
  if (toMonth(value.effectiveForMonth) !== month) invalid();
  if (value.state !== 'CONFIGURED' && value.state !== 'MISSING') invalid();
  let effective: CalendarRead['effective'] = null;
  if (value.effective !== null) {
    if (!isRecord(value.effective)) invalid();
    const raw = value.effective as Record<string, unknown>;
    effective = {
      ...toRef(raw),
      effectiveFromMonth: toMonth(raw.effectiveFromMonth),
      operatingWeekdays: toWeekdays(raw.operatingWeekdays),
    };
    if (effective.effectiveFromMonth > month) invalid();
  }
  if ((value.state === 'CONFIGURED') !== (effective !== null)) invalid();
  const exactVersion = value.exactVersion === null ? null : toRef(value.exactVersion);
  // The exact version is the effective one when it starts in this month, and absent otherwise.
  const ownMonth = effective !== null && effective.effectiveFromMonth === month;
  if (ownMonth !== (exactVersion !== null)) invalid();
  if (exactVersion && effective && (exactVersion.id !== effective.id || exactVersion.version !== effective.version)) invalid();
  const next = value.nextEffectiveFromMonth === null ? null : toMonth(value.nextEffectiveFromMonth);
  if (next !== null && next <= month) invalid();
  return {
    projectId: value.projectId as string,
    month,
    state: value.state as CalendarRead['state'],
    effective,
    exactVersion,
    nextEffectiveFromMonth: next,
  };
}

function calendarPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/operating-calendar`;
}

export function createOperatingCalendarApi(api: SessionApi): OperatingCalendarApi {
  return {
    async get(projectId, month, signal) {
      const params = new URLSearchParams({ effectiveForMonth: monthStartOf(month) });
      return toCalendarRead(
        await api.request<unknown>(`${calendarPath(projectId)}?${params.toString()}`, { signal }),
        projectId,
        month,
      );
    },
    async replace(projectId, { basis, operatingWeekdays, bootstrap }) {
      const weekdays = [...new Set(operatingWeekdays)].sort((a, b) => a - b);
      // Caller defects: never send an empty or out-of-range set, or a read of another project.
      if (weekdays.length === 0 || weekdays.some((day) => !ISO_WEEKDAYS.includes(day))) {
        throw new Error('Operating weekdays must be 1-7 distinct ISO weekdays');
      }
      if (basis.projectId.toLowerCase() !== projectId.toLowerCase()) throw new Error('Calendar basis belongs to another project');
      const body = {
        effectiveFromMonth: monthStartOf(basis.month),
        expectedExactVersion: basis.exactVersion ? { id: basis.exactVersion.id, version: basis.exactVersion.version } : null,
        expectedEffective: basis.effective ? { id: basis.effective.id, version: basis.effective.version } : null,
        expectedNextEffectiveFromMonth: basis.nextEffectiveFromMonth === null ? null : monthStartOf(basis.nextEffectiveFromMonth),
        operatingWeekdays: weekdays,
        bootstrap,
      };
      const value = await api.request<unknown>(calendarPath(projectId), { method: 'PATCH', body });
      const read = toCalendarRead(value, projectId, basis.month);
      const outcome = isRecord(value) ? value.outcome : undefined;
      if (outcome !== 'APPLIED' && outcome !== 'NO_OP') invalid();
      // After APPLIED or NO_OP the edited month holds exactly the sent set.
      if (read.exactVersion === null || read.effective === null
        || read.effective.operatingWeekdays.join(',') !== weekdays.join(',')) invalid();
      return { ...read, outcome: outcome as CalendarWriteResult['outcome'] };
    },
  };
}
