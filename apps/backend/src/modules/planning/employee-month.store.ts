import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { requireRow } from '../../auth/authorization/require-row.js';
import {
  dutyColumns,
  monthlyPlanColumns,
  toDutyAssignmentResponse,
  toDutyVersion,
  toMonthlyPlanResponse,
  type DutyRow,
  type MembershipRow,
  type MonthlyPlanRow,
} from './monthly-plan.mapper.js';
import {
  creationFingerprint,
  type Assignment,
  type Calendar,
  type Kind,
  type ReadSlot,
} from './employee-month.contract.js';

export const MEMBER_COLUMNS =
  'pa.id, pa.duty_id, pa.employee_id, pa.duty_function, pa.source';
export type Employee = {
  id: string;
  status: string;
  employment_start: string | null;
  employment_end: string | null;
  shift_eligibility: string;
};
export const EMPLOYEE_COLUMNS = `id, status, shift_eligibility, to_char(employment_start,'YYYY-MM-DD') AS employment_start,
  to_char(employment_end,'YYYY-MM-DD') AS employment_end`;
export type Rule = {
  id: string;
  kind: Kind;
  month: string;
  start: string;
  end: string;
};
export const kindOf = (d: DutyRow): Kind => {
  if (d.shift_kind === 'TAG') return 'DAY';
  if (d.shift_kind === 'NACHT') return 'NIGHT';
  throw new Error('Invalid stored shift');
};
export const dbKind = (kind: Kind): string =>
  kind === 'DAY' ? 'TAG' : 'NACHT';
export function datesInMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const n = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return Array.from(
    { length: n },
    (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}`,
  );
}
export const signature = (
  duties: DutyRow[],
  members: MembershipRow[],
): string =>
  JSON.stringify([
    [...duties].sort((a, b) => (a.id < b.id ? -1 : 1)),
    [...members].sort((a, b) => (a.id < b.id ? -1 : 1)),
  ]);
export async function visibleMonth(
  client: PoolClient,
  tenant: TenantContext,
  planId: string,
  employeeId: string,
): Promise<MonthlyPlanRow> {
  const plan = requireRow(
    await client.query<MonthlyPlanRow>(
      `SELECT ${monthlyPlanColumns('mp')} FROM public.monthly_plans mp
     JOIN public.projects p ON p.company_id=mp.company_id AND p.id=mp.project_id
     WHERE mp.company_id=$1 AND mp.id=$2 AND p.status IN ('ACTIVE','INACTIVE')`,
      [tenant.companyId, planId],
    ),
  );
  const employee = await client.query(
    'SELECT id FROM public.employees WHERE company_id=$1 AND id=$2',
    [tenant.companyId, employeeId],
  );
  if (employee.rowCount !== 1)
    throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  return plan;
}
export async function liveDuties(
  client: PoolClient,
  tenant: TenantContext,
  planId: string,
  lock = false,
): Promise<DutyRow[]> {
  return (
    await client.query<DutyRow>(
      `SELECT ${dutyColumns('d')} FROM public.duties d
    WHERE d.company_id=$1 AND d.monthly_plan_id=$2 AND d.removed_at IS NULL ORDER BY d.id${lock ? ' FOR UPDATE' : ''}`,
      [tenant.companyId, planId],
    )
  ).rows;
}
export async function liveMembers(
  client: PoolClient,
  tenant: TenantContext,
  ids: string[],
  lock = false,
): Promise<MembershipRow[]> {
  if (!ids.length) return [];
  return (
    await client.query<MembershipRow>(
      `SELECT ${MEMBER_COLUMNS} FROM public.plan_assignments pa
    WHERE pa.company_id=$1 AND pa.duty_id=ANY($2::uuid[]) AND pa.state='ACTIVE' ORDER BY pa.id${lock ? ' FOR UPDATE' : ''}`,
      [tenant.companyId, ids],
    )
  ).rows;
}
export async function creationContext(
  client: PoolClient,
  tenant: TenantContext,
  plan: MonthlyPlanRow,
) {
  const zone = requireRow(
    await client.query<{ time_zone: string; named: boolean }>(
      `SELECT time_zone,
    EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=c.time_zone) AS named FROM public.companies c WHERE id=$1`,
      [tenant.companyId],
    ),
  );
  if (!zone.named) throw new Error('Invalid company time zone');
  const rules = (
    await client.query<Rule>(
      `SELECT id, CASE shift_kind WHEN 'TAG' THEN 'DAY' ELSE 'NIGHT' END AS kind,
    to_char(effective_from_month,'YYYY-MM-DD') AS month, left(start_local::text,5) AS start, left(end_local::text,5) AS end
    FROM public.shift_configurations WHERE company_id=$1 AND project_id=$2 AND effective_from_month=(
      SELECT max(effective_from_month) FROM public.shift_configurations WHERE company_id=$1 AND project_id=$2 AND effective_from_month<=$3::date)
    ORDER BY CASE shift_kind WHEN 'TAG' THEN 0 ELSE 1 END`,
      [tenant.companyId, plan.project_id, plan.month_start],
    )
  ).rows;
  const c = (
    await client.query<{
      id: string;
      version: string;
      month: string;
      mask: number;
    }>(
      `SELECT id, version::text,
    to_char(effective_from_month,'YYYY-MM-DD') AS month, weekday_mask::int AS mask
    FROM public.project_operating_calendars WHERE company_id=$1 AND project_id=$2 AND effective_from_month<=$3::date
    ORDER BY effective_from_month DESC LIMIT 1`,
      [tenant.companyId, plan.project_id, plan.month_start],
    )
  ).rows[0];
  const calendar: Calendar = c
    ? {
        id: c.id,
        version: toDutyVersion(c.version),
        effectiveFromMonth: c.month,
        operatingWeekdays: Array.from({ length: 7 }, (_, i) => i + 1).filter(
          (d) => (c.mask & (1 << (d - 1))) !== 0,
        ),
      }
    : null;
  const fingerprint = creationFingerprint(
    plan.project_id,
    plan.month_start,
    zone.time_zone,
    rules,
    calendar,
  );
  return { zone: zone.time_zone, rules, calendar, fingerprint };
}
export const selectedAssignment = (
  m: MembershipRow | undefined,
): Assignment | null => {
  if (!m) return null;
  const a = toDutyAssignmentResponse(m);
  return { id: a.id, dutyRole: a.dutyRole, source: a.source };
};
export const readSlot = (
  d: DutyRow | undefined,
  m: MembershipRow | undefined,
): ReadSlot | null =>
  d
    ? {
        dutyId: d.id,
        version: toDutyVersion(d.version),
        startsAt: d.starts_at,
        endsAt: d.ends_at,
        assignment: selectedAssignment(m),
      }
    : null;
export function operatingState(
  day: string,
  calendar: Calendar,
): 'MISSING' | 'OPEN' | 'CLOSED' {
  if (calendar === null) return 'MISSING';
  // ISO input, including years 0001..0099; no Date.UTC year coercion.
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
  return calendar.operatingWeekdays.includes(weekday) ? 'OPEN' : 'CLOSED';
}
export function projectRead(
  plan: MonthlyPlanRow,
  employeeId: string,
  context: Awaited<ReturnType<typeof creationContext>>,
  duties: DutyRow[],
  members: MembershipRow[],
  unavailableDates: string[],
) {
  return {
    plan: toMonthlyPlanResponse(plan),
    employeeId,
    creationContextFingerprint: context.fingerprint,
    operatingCalendar: {
      state: context.calendar === null ? 'MISSING' : 'CONFIGURED',
      effective: context.calendar,
    },
    unavailableDates,
    days: datesInMonth(plan.month_start).map((date) => {
      const slot = (kind: Kind) => {
        const d = duties.find(
          (d) => d.duty_date === date && kindOf(d) === kind,
        );
        return readSlot(
          d,
          members.find(
            (m) => m.duty_id === d?.id && m.employee_id === employeeId,
          ),
        );
      };
      const day = slot('DAY'),
        night = slot('NIGHT');
      const currentState = day?.assignment
        ? night?.assignment
          ? 'INVALID_DUAL'
          : 'DAY'
        : night?.assignment
          ? 'NIGHT'
          : 'OFF';
      const state = operatingState(date, context.calendar);
      return {
        date,
        day,
        night,
        currentState,
        operatingState: state,
        violations: [
          ...(currentState === 'INVALID_DUAL' ? ['INVALID_DUAL'] : []),
          ...(state === 'MISSING'
            ? ['PROJECT_CALENDAR_MISSING']
            : state === 'CLOSED'
              ? ['PROJECT_CLOSED_WEEKDAY']
              : []),
        ],
      };
    }),
  };
}
