import { ApiError } from '../../../shared/api/api-error';
import { isCivilDate } from '../../../shared/time/civil-time';
import type { ReadSource } from '../../../shared/data/data-source';
import {
  parseBaseIdentity,
  parseMeIdentity,
  type IdentityContext,
  type MeIdentity,
} from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';

export type PlanningStatisticsResponse = {
  monthStart: string;
  plannedWorkdays: number;
  dayShiftCount: number;
  nightShiftCount: number;
};
function invalid(): never {
  throw new ApiError('invalid-response', 200, null, null);
}
/** Validate the whole contract before any private value reaches a card. */
export function parsePlanningStatistics(
  value: unknown,
  requestedMonth: string,
): PlanningStatisticsResponse {
  const keys = [
    'monthStart',
    'plannedWorkdays',
    'dayShiftCount',
    'nightShiftCount',
  ];
  if (
    !isCivilDate(requestedMonth) ||
    !requestedMonth.endsWith('-01') ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  const row = value as Record<string, unknown>;
  if (row.monthStart !== requestedMonth) invalid();
  const count = (raw: unknown): number => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)
      invalid();
    return raw;
  };
  const plannedWorkdays = count(row.plannedWorkdays),
    dayShiftCount = count(row.dayShiftCount),
    nightShiftCount = count(row.nightShiftCount);
  // BigInt avoids losing precision when two individually safe counts are added.
  const total = BigInt(dayShiftCount) + BigInt(nightShiftCount);
  if (
    plannedWorkdays > 31 ||
    (plannedWorkdays > 0 &&
      !isCivilDate(
        `${requestedMonth.slice(0, 7)}-${String(plannedWorkdays).padStart(2, '0')}`,
      )) ||
    BigInt(plannedWorkdays) > total ||
    (plannedWorkdays === 0) !== (total === 0n)
  )
    invalid();
  return {
    monthStart: requestedMonth,
    plannedWorkdays,
    dayShiftCount,
    nightShiftCount,
  };
}
export type StatisticsRead = {
  context: MeIdentity;
  response: PlanningStatisticsResponse | null;
};
export function createPlanningStatisticsSource(
  api: SessionApi,
  principal: IdentityContext,
  revalidate: () => void,
): ReadSource<string, StatisticsRead> {
  let redirectContext: MeIdentity | null = null;
  async function context(signal: AbortSignal): Promise<MeIdentity> {
    const value = await api.request<unknown>('/api/v1/me', { signal });
    signal.throwIfAborted();
    const result = parseBaseIdentity(value);
    if (
      result.accountId.toLowerCase() !== principal.accountId.toLowerCase() ||
      result.companyId.toLowerCase() !== principal.companyId.toLowerCase() ||
      result.role !== principal.role
    ) {
      revalidate();
      throw new Error('Session identity changed');
    }
    return parseMeIdentity(value);
  }
  return {
    kind: 'api',
    async load(month, signal) {
      if (month === '') {
        redirectContext = await context(signal);
        return { context: redirectContext, response: null };
      }
      const current = redirectContext ?? (await context(signal));
      redirectContext = null;
      signal.throwIfAborted();
      const response = await api.request<unknown>(
        `/api/v1/me/planning-statistics?monthStart=${month}-01`,
        { signal },
      );
      signal.throwIfAborted();
      return {
        context: current,
        response: parsePlanningStatistics(response, `${month}-01`),
      };
    },
  };
}
