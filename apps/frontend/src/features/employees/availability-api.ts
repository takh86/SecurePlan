import { ApiError } from '../../shared/api/api-error';
import type { SessionApi } from '../auth/session-api';

export type AvailabilityStatus = 'SICK' | 'LEAVE';
export type AvailabilitySelection = { operation: 'SET'; fromDate: string; toDate: string; status: AvailabilityStatus; conflictPolicy?: 'REJECT' | 'REPLACE' }
  | { operation: 'CLEAR'; fromDate: string; toDate: string };
export type AvailabilityDay = { employeeId: string; day: string; status: AvailabilityStatus };
export type PreviewDay = { day: string; currentStatus: AvailabilityStatus | null; effect: 'CREATE' | 'UNCHANGED' | 'CONFLICT' | 'REPLACE' | 'CLEAR' };
export type AvailabilityPreview = AvailabilitySelection & { employeeId: string; previewToken: string; expiresAt: string; canCommit: boolean; days: PreviewDay[] };
export type AvailabilityCommit = AvailabilitySelection & { previewToken: string; confirmation?: 'CLEAR' | 'REPLACE' };
export type AvailabilityResult = { employeeId: string; changedDayCount: number; unchangedDayCount: number };
export interface AvailabilityApi {
  list(id: string, monthStart: string, signal?: AbortSignal): Promise<AvailabilityDay[]>;
  preview(id: string, selection: AvailabilitySelection, signal?: AbortSignal): Promise<AvailabilityPreview>;
  commit(id: string, body: AvailabilityCommit, key: string): Promise<AvailabilityResult>;
}
export const AVAILABILITY_LABELS = { SICK: 'Krank', LEAVE: 'Urlaub (genehmigt)' } as const;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function status(value: unknown): value is AvailabilityStatus { return value === 'SICK' || value === 'LEAVE'; }
function invalid(): never { throw new ApiError('invalid-response', null, null, null); }
export function civilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function rangeCount(from: string, to: string): number {
  if (!civilDate(from) || !civilDate(to)) return 0;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}
function base(id: string) { return `/api/v1/employees/${encodeURIComponent(id)}/availability`; }
export function createAvailabilityApi(api: SessionApi): AvailabilityApi {
  return {
    async list(id, monthStart, signal) {
      const value = await api.request<unknown>(`${base(id)}?monthStart=${encodeURIComponent(monthStart)}`, { signal });
      if (!record(value) || !Array.isArray(value.items) || value.items.length > 31) invalid();
      let previous = '';
      return value.items.map((item: unknown) => {
        if (!record(item) || item.employeeId !== id || !civilDate(item.day) || !item.day.startsWith(monthStart.slice(0, 7)) ||
            item.day <= previous || !status(item.status)) invalid();
        previous = item.day;
        return { employeeId: id, day: item.day, status: item.status };
      });
    },
    async preview(id, selection, signal) {
      const value = await api.request<unknown>(`${base(id)}/preview`, { method: 'POST', body: selection, signal });
      const count = rangeCount(selection.fromDate, selection.toDate);
      if (!record(value) || value.employeeId !== id || value.operation !== selection.operation || value.fromDate !== selection.fromDate ||
          value.toDate !== selection.toDate || count < 1 || count > 93 ||
          typeof value.previewToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.previewToken) ||
          typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
          typeof value.canCommit !== 'boolean' || !Array.isArray(value.days) || value.days.length !== count) invalid();
      if (selection.operation === 'SET' && (value.status !== selection.status || value.conflictPolicy !== (selection.conflictPolicy ?? 'REJECT'))) invalid();
      if (selection.operation === 'CLEAR' && ('status' in value || 'conflictPolicy' in value)) invalid();
      const days = value.days.map((item: unknown, index: number): PreviewDay => {
        const day = new Date(Date.parse(`${selection.fromDate}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
        if (!record(item) || item.day !== day || !(item.currentStatus === null || status(item.currentStatus))) invalid();
        const expected = selection.operation === 'CLEAR' ? (item.currentStatus === null ? 'UNCHANGED' : 'CLEAR') :
          item.currentStatus === null ? 'CREATE' : item.currentStatus === selection.status ? 'UNCHANGED' :
            selection.conflictPolicy === 'REPLACE' ? 'REPLACE' : 'CONFLICT';
        if (item.effect !== expected) invalid();
        return { day, currentStatus: item.currentStatus, effect: expected };
      });
      if (value.canCommit !== !days.some((day) => day.effect === 'CONFLICT')) invalid();
      const normalized = selection.operation === 'SET' ? { ...selection, conflictPolicy: selection.conflictPolicy ?? 'REJECT' } as const : selection;
      return { ...normalized, employeeId: id, previewToken: value.previewToken, expiresAt: value.expiresAt, canCommit: value.canCommit, days };
    },
    async commit(id, body, key) {
      const value = await api.request<unknown>(`${base(id)}/batch`, { method: 'POST', body, idempotencyKey: key });
      if (!record(value) || value.employeeId !== id || !Number.isInteger(value.changedDayCount) || !Number.isInteger(value.unchangedDayCount) ||
          (value.changedDayCount as number) < 0 || (value.unchangedDayCount as number) < 0 ||
          (value.changedDayCount as number) + (value.unchangedDayCount as number) !== rangeCount(body.fromDate, body.toDate)) invalid();
      return { employeeId: id, changedDayCount: value.changedDayCount as number, unchangedDayCount: value.unchangedDayCount as number };
    },
  };
}
