/**
 * SP-08b project shift-configuration API client (ADR-0003). Uses only the two
 * endpoints the backend provides; tenant and role are never sent. Responses
 * are shape-checked, including the version rules the UI relies on:
 * - GET answers the effective version for the requested month: its month is
 *   that month or an EARLIER one, or null with no shifts (A-SP08b-01);
 * - PATCH answers the version of exactly the month that was written.
 */
import { ApiError } from '../../shared/api/api-error';
import type { MonthKey } from '../../shared/time/month';
import type { SessionApi } from '../auth/session-api';
import { monthStartOf } from './project-assignments-api';

export type ShiftKind = 'DAY' | 'NIGHT';

/** Fixed display and payload order. */
export const SHIFT_KINDS: readonly ShiftKind[] = ['DAY', 'NIGHT'];

/** One stored shift rule; times are local wall-clock times `HH:mm` in the company time zone. */
export type ShiftRule = {
  id: string;
  shiftKind: ShiftKind;
  startLocal: string;
  endLocal: string;
};

export type ShiftRuleInput = Omit<ShiftRule, 'id'>;

export type ShiftConfiguration = {
  projectId: string;
  /** `YYYY-MM` of the effective version, or null when nothing is configured up to the month. */
  effectiveFromMonth: MonthKey | null;
  shifts: ShiftRule[];
};

export interface ShiftConfigurationApi {
  /** Effective configuration for `month` (may come from an earlier month). */
  get(projectId: string, month: MonthKey, signal?: AbortSignal): Promise<ShiftConfiguration>;
  /** Full replacement of the shift set of exactly `month` (a new version if none exists yet). */
  replace(projectId: string, month: MonthKey, shifts: readonly ShiftRuleInput[]): Promise<ShiftConfiguration>;
}

/** Canonical API local time: `HH:mm`, 24-hour clock. */
export const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ApiError('invalid-response', null, null, null);
}

function toRule(value: unknown): ShiftRule {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !SHIFT_KINDS.includes(value.shiftKind as ShiftKind) ||
    typeof value.startLocal !== 'string' ||
    typeof value.endLocal !== 'string' ||
    !LOCAL_TIME_PATTERN.test(value.startLocal) ||
    !LOCAL_TIME_PATTERN.test(value.endLocal)
  ) {
    invalid();
  }
  // Only the known fields are kept.
  return {
    id: value.id as string,
    shiftKind: value.shiftKind as ShiftKind,
    startLocal: value.startLocal as string,
    endLocal: value.endLocal as string,
  };
}

function toConfiguration(value: unknown, projectId: string): ShiftConfiguration {
  if (!isRecord(value) || typeof value.projectId !== 'string' || !Array.isArray(value.shifts)) invalid();
  // The server canonicalizes ids to lower case; an answer for another project is a contract defect.
  if ((value.projectId as string).toLowerCase() !== projectId.toLowerCase()) invalid();
  const month = value.effectiveFromMonth;
  if (month !== null && (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(month))) invalid();
  const shifts = (value.shifts as unknown[]).map(toRule);
  // A-SP08b-01: null exactly when nothing is configured; a version has one or two distinct kinds.
  if ((month === null) !== (shifts.length === 0) || shifts.length > 2) invalid();
  if (new Set(shifts.map((rule) => rule.shiftKind)).size !== shifts.length) invalid();
  return {
    projectId: value.projectId as string,
    effectiveFromMonth: month === null ? null : (month as string).slice(0, 7),
    shifts: [...shifts].sort((a, b) => SHIFT_KINDS.indexOf(a.shiftKind) - SHIFT_KINDS.indexOf(b.shiftKind)),
  };
}

function shiftConfigurationPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/shift-configuration`;
}

export function createShiftConfigurationApi(api: SessionApi): ShiftConfigurationApi {
  return {
    async get(projectId, month, signal) {
      const params = new URLSearchParams({ effectiveForMonth: monthStartOf(month) });
      const configuration = toConfiguration(
        await api.request<unknown>(`${shiftConfigurationPath(projectId)}?${params.toString()}`, { signal }),
        projectId,
      );
      // The effective version can never start after the requested month.
      if (configuration.effectiveFromMonth !== null && configuration.effectiveFromMonth > month) invalid();
      return configuration;
    },
    async replace(projectId, month, shifts) {
      const body = {
        effectiveFromMonth: monthStartOf(month),
        shifts: shifts.map(({ shiftKind, startLocal, endLocal }) => ({ shiftKind, startLocal, endLocal })),
      };
      const configuration = toConfiguration(
        await api.request<unknown>(shiftConfigurationPath(projectId), { method: 'PATCH', body }),
        projectId,
      );
      if (configuration.effectiveFromMonth !== month) invalid();
      return configuration;
    },
  };
}
