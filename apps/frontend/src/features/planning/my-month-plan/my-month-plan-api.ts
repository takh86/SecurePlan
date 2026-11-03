import { ApiError } from '../../../shared/api/api-error';
import { isCivilDate, isNamedTimeZone, isUtcSecond } from '../../../shared/time/civil-time';
import type { ReadSource } from '../../../shared/data/data-source';
import { parseBaseIdentity, parseMeIdentity, type IdentityContext, type MeIdentity } from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';
import type { MyDuty, MyMonthlyPlan, MyMonthlyPlansResponse } from './my-month-plan-types';

function invalid(): never { throw new ApiError('invalid-response', 200, null, null); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string') invalid(); return value; }
function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) invalid();
  return result;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) invalid();
  return value;
}
/** Whole-response validation, including relational shape and strict server ordering. */
export function parseMyMonthlyPlans(value: unknown, requestedMonth: string): MyMonthlyPlansResponse {
  if (!isCivilDate(requestedMonth) || !requestedMonth.endsWith('-01')) invalid();
  const envelope = record(value, ['items']);
  const plans = new Set<string>(), projects = new Set<string>(), duties = new Set<string>(), slots = new Set<string>();
  let previousPlan = '';
  const items: MyMonthlyPlan[] = array(envelope.items).map((raw) => {
    const plan = record(raw, ['planId', 'project', 'monthStart', 'duties']);
    const project = record(plan.project, ['id', 'name']);
    const planId = uuid(plan.planId), projectId = uuid(project.id), monthStart = text(plan.monthStart);
    if (monthStart !== requestedMonth || plans.has(planId.toLowerCase()) || projects.has(projectId.toLowerCase())) invalid();
    const order = `${monthStart}\0${projectId.toLowerCase()}\0${planId.toLowerCase()}`;
    if (order <= previousPlan) invalid();
    previousPlan = order; plans.add(planId.toLowerCase()); projects.add(projectId.toLowerCase());
    let previousDuty = '';
    const ownDuties: MyDuty[] = array(plan.duties).map((rawDuty) => {
      const duty = record(rawDuty, ['dutyId', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt', 'dutyRole', 'timeZone']);
      const dutyId = uuid(duty.dutyId);
      if (!isCivilDate(duty.dutyDate) || duty.dutyDate.slice(0, 7) !== monthStart.slice(0, 7) ||
        (duty.shiftKind !== 'DAY' && duty.shiftKind !== 'NIGHT') || (duty.dutyRole !== 'EMPLOYEE' && duty.dutyRole !== 'SHIFT_LEAD') ||
        !isUtcSecond(duty.startsAt) || !isUtcSecond(duty.endsAt) || duty.endsAt <= duty.startsAt || !isNamedTimeZone(duty.timeZone)) invalid();
      const dutyOrder = `${duty.dutyDate}\0${duty.shiftKind}\0${dutyId.toLowerCase()}`;
      const slot = `${planId.toLowerCase()}\0${duty.dutyDate}\0${duty.shiftKind}`;
      if (dutyOrder <= previousDuty || duties.has(dutyId.toLowerCase()) || slots.has(slot)) invalid();
      previousDuty = dutyOrder; duties.add(dutyId.toLowerCase()); slots.add(slot);
      return { dutyId, dutyDate: duty.dutyDate, shiftKind: duty.shiftKind, startsAt: duty.startsAt, endsAt: duty.endsAt, dutyRole: duty.dutyRole, timeZone: duty.timeZone };
    });
    return { planId, project: { id: projectId, name: text(project.name) }, monthStart, duties: ownDuties };
  });
  return { items };
}
export type PersonalMonthRead = { context: MeIdentity; response: MyMonthlyPlansResponse | null };
export function createMyMonthPlanSource(api: SessionApi, principal: IdentityContext, revalidate: () => void): ReadSource<string, PersonalMonthRead> {
  let redirectContext: MeIdentity | null = null;
  async function context(signal: AbortSignal): Promise<MeIdentity> {
    const value = await api.request<unknown>('/api/v1/me', { signal });
    signal.throwIfAborted();
    const result = parseBaseIdentity(value);
    if (result.accountId.toLowerCase() !== principal.accountId.toLowerCase() || result.companyId.toLowerCase() !== principal.companyId.toLowerCase() || result.role !== principal.role) {
      revalidate(); throw new Error('Session identity changed');
    }
    return parseMeIdentity(value);
  }
  return { kind: 'api', async load(month, signal) {
    if (month === '') { redirectContext = await context(signal); return { context: redirectContext, response: null }; }
    const current = redirectContext ?? await context(signal); redirectContext = null;
    signal.throwIfAborted();
    const response = await api.request<unknown>(`/api/v1/me/monthly-plans?monthStart=${month}-01`, { signal });
    signal.throwIfAborted();
    return { context: current, response: parseMyMonthlyPlans(response, `${month}-01`) };
  } };
}
