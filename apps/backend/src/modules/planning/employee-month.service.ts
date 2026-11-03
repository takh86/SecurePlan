import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { requireRow } from '../../auth/authorization/require-row.js';
import { DatabaseService } from '../../database/database.service.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';
import { AvailabilityService } from '../workforce/availability/availability.service.js';
import {
  dutyColumns,
  dutyRoleToDb,
  toDutyVersion,
  toMonthlyPlanResponse,
  type DutyRow,
  type MembershipRow,
} from './monthly-plan.mapper.js';
import { resolveDutyInterval } from './duty-time-resolver.js';
import {
  saveConflict,
  type Kind,
  type Reason,
  type SaveEmployeeMonth,
  type SaveResult,
  type SlotConflict,
} from './employee-month.contract.js';
import {
  creationContext,
  datesInMonth,
  dbKind,
  EMPLOYEE_COLUMNS,
  kindOf,
  liveDuties,
  liveMembers,
  MEMBER_COLUMNS,
  operatingState,
  projectRead,
  readSlot,
  selectedAssignment,
  signature,
  visibleMonth,
  type Employee,
} from './employee-month.store.js';
import { EmployeeMonthIdempotencyService } from './employee-month-idempotency.service.js';
import { assertPlanningSchemaComplete } from './planning-schema.js';

type Delta = {
  duty: DutyRow;
  before: MembershipRow | undefined;
  role: string | null;
  created: boolean;
};
@Injectable()
export class EmployeeMonthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly availability: AvailabilityService,
    private readonly audit: BusinessAuditService,
    private readonly receipts: EmployeeMonthIdempotencyService,
  ) {}

  async read(t: TenantContext, planId: string, employeeId: string) {
    return this.database.withTransaction(async (c) => {
      await c.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      await assertPlanningSchemaComplete(c);
      const plan = await visibleMonth(c, t, planId, employeeId);
      const context = await creationContext(c, t, plan);
      const duties = await liveDuties(c, t, planId),
        members = await liveMembers(
          c,
          t,
          duties.map((d) => d.id),
        );
      const dates = datesInMonth(plan.month_start);
      const unavailable = await this.availability.listUnavailableDays(
        c,
        t,
        [employeeId],
        dates[0],
        dates.at(-1)!,
      );
      return projectRead(
        plan,
        employeeId,
        context,
        duties,
        members,
        unavailable.map((f) => f.day).sort(),
      );
    });
  }
  lookup(t: TenantContext, planId: string, employeeId: string, key: string) {
    return this.receipts.lookup(t, planId, employeeId, key);
  }
  async save(
    t: TenantContext,
    planId: string,
    employeeId: string,
    key: string,
    dto: SaveEmployeeMonth,
    correlationId: string,
  ) {
    // Conceal route before plan-relative structural errors, before claiming a key.
    await this.database.withTransaction(async (c) => {
      const plan = await visibleMonth(c, t, planId, employeeId);
      const dates = datesInMonth(plan.month_start);
      if (
        dto.days.length !== dates.length ||
        dto.days.some((d, i) => d.date !== dates[i])
      )
        throw new BadRequestException({ code: 'DUTY_DATE_OUTSIDE_PLAN_MONTH' });
    });
    return this.receipts.execute(t, planId, employeeId, key, dto, (c) =>
      this.mutate(c, t, planId, employeeId, dto, correlationId),
    );
  }

  private async mutate(
    c: PoolClient,
    t: TenantContext,
    planId: string,
    employeeId: string,
    dto: SaveEmployeeMonth,
    correlationId: string,
  ): Promise<SaveResult> {
    // A/C/I already held by receipt executor. Discovery precedes ALL E locks.
    const discovered = await liveDuties(c, t, planId),
      discoveredMembers = await liveMembers(
        c,
        t,
        discovered.map((d) => d.id),
      );
    const ids = [
      ...new Set([employeeId, ...discoveredMembers.map((m) => m.employee_id)]),
    ].sort();
    const employees = (
      await c.query<Employee>(
        `SELECT ${EMPLOYEE_COLUMNS} FROM public.employees
      WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
        [t.companyId, ids],
      )
    ).rows;
    if (employees.length !== ids.length) saveConflict('PRECONDITION');
    const initialPlan = await visibleMonth(c, t, planId, employeeId);
    const project = requireRow(
      await c.query<{ status: string }>(
        `SELECT status FROM public.projects WHERE company_id=$1 AND id=$2 FOR SHARE`,
        [t.companyId, initialPlan.project_id],
      ),
    );
    const links = (
      await c.query<{ employee_id: string; project_id: string }>(
        `SELECT employee_id,project_id FROM public.project_assignments
      WHERE company_id=$1 AND employee_id=ANY($2::uuid[]) AND planning_month=$3::date ORDER BY id FOR SHARE`,
        [t.companyId, ids, initialPlan.month_start],
      )
    ).rows;
    await c.query(
      'SELECT id FROM public.monthly_plans WHERE company_id=$1 AND id=$2 FOR UPDATE',
      [t.companyId, planId],
    );
    const plan = await visibleMonth(c, t, planId, employeeId);
    const duties = await liveDuties(c, t, planId),
      membersAfterL = await liveMembers(
        c,
        t,
        duties.map((d) => d.id),
      );
    const drift =
      signature(discovered, discoveredMembers) !==
      signature(duties, membersAfterL);
    const context = await creationContext(c, t, plan);
    const mismatches: SlotConflict[] = [];
    for (const day of dto.days)
      for (const kind of ['DAY', 'NIGHT'] as const) {
        const d = duties.find(
            (d) => d.duty_date === day.date && kindOf(d) === kind,
          ),
          expected = day.expected[kind === 'DAY' ? 'day' : 'night'];
        if (
          d
            ? !expected ||
              d.id !== expected.id ||
              toDutyVersion(d.version) !== expected.version
            : expected !== null
        )
          mismatches.push({
            date: day.date,
            shiftKind: kind,
            reason: 'PLAN_CONCURRENT_MODIFICATION',
          });
      }
    const lifecycle =
      dto.expectedPlan.status === plan.status &&
      dto.expectedPlan.publishedAt === plan.published_at;
    const calendarMatch =
      JSON.stringify(dto.expectedCalendar) ===
      JSON.stringify(
        context.calendar === null
          ? null
          : { id: context.calendar.id, version: context.calendar.version },
      );
    const missing = dto.days.filter(
      (d) =>
        d.desired.state !== 'OFF' &&
        !duties.some(
          (x) => x.duty_date === d.date && kindOf(x) === d.desired.state,
        ),
    );
    const contextMatch =
      missing.length === 0 ||
      dto.expectedCreationContext === context.fingerprint;
    const preconditions =
      !drift &&
      !mismatches.length &&
      lifecycle &&
      calendarMatch &&
      contextMatch;
    // Allocate tentative D identities before acquiring D. Merge inserts/locks in UUID order.
    // Invalid preconditions never create even tentative duties. Failures below roll these back.
    const candidates: {
      id: string;
      existing?: DutyRow;
      create?: {
        date: string;
        kind: Kind;
        rule: (typeof context.rules)[number];
        interval: { startsAt: string; endsAt: string };
      };
    }[] = duties.map((d) => ({ id: d.id, existing: d }));
    const pending: SlotConflict[] = [];
    if (preconditions)
      for (const day of missing) {
        const kind = day.desired.state as Kind,
          rule = context.rules.find((r) => r.kind === kind);
        const interval = rule
          ? resolveDutyInterval({
              zone: context.zone,
              dutyDate: day.date,
              startLocal: rule.start,
              endLocal: rule.end,
            })
          : null;
        if (!rule || !interval) {
          const state = operatingState(day.date, context.calendar);
          pending.push({
            date: day.date,
            shiftKind: kind,
            reason:
              state === 'MISSING'
                ? 'PROJECT_CALENDAR_MISSING'
                : state === 'CLOSED'
                  ? 'PROJECT_CLOSED_WEEKDAY'
                  : rule
                    ? 'DUTY_TIME_RANGE_INVALID'
                    : 'SHIFT_CONFIGURATION_MISSING',
          });
          continue;
        }
        const id = (
          await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')
        ).rows[0].id;
        candidates.push({
          id,
          create: { date: day.date, kind, rule, interval },
        });
      }
    const newIds = new Set<string>();
    for (const item of candidates.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (item.existing) {
        await c.query(
          'SELECT id FROM public.duties WHERE company_id=$1 AND id=$2 FOR UPDATE',
          [t.companyId, item.id],
        );
      } else {
        const x = item.create!;
        const d = (
          await c.query<DutyRow>(
            `INSERT INTO public.duties AS d(id,company_id,project_id,monthly_plan_id,planning_month,
          duty_date,shift_kind,starts_at,ends_at,time_zone,config_effective_from_month,start_local,end_local)
          VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8::timestamptz,$9::timestamptz,$10,$11::date,$12::time,$13::time)
          RETURNING ${dutyColumns('d')}`,
            [
              item.id,
              t.companyId,
              plan.project_id,
              planId,
              plan.month_start,
              x.date,
              dbKind(x.kind),
              x.interval.startsAt,
              x.interval.endsAt,
              context.zone,
              x.rule.month,
              x.rule.start,
              x.rule.end,
            ],
          )
        ).rows[0];
        duties.push(d);
        newIds.add(d.id);
      }
    }
    const members = await liveMembers(
      c,
      t,
      duties.map((d) => d.id),
      true,
    ); // ALL A2 after ALL D
    await c.query(
      `SELECT id FROM public.edit_leases WHERE company_id=$1 AND duty_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
      [t.companyId, duties.map((d) => d.id)],
    );
    await assertSessionInTransaction(c, t);
    // Never use a newly discovered roster employee after an L wait.
    const changed: Delta[] = [];
    for (const d of duties) {
      const before = members.find(
          (m) => m.duty_id === d.id && m.employee_id === employeeId,
        ),
        want = dto.days.find((x) => x.date === d.duty_date)!.desired;
      const role =
        want.state !== 'OFF' && want.state === kindOf(d)
          ? dutyRoleToDb(want.role)
          : null;
      if ((before?.duty_function ?? null) !== role)
        changed.push({ duty: d, before, role, created: newIds.has(d.id) });
    }
    const liveLeases = new Set(
      (
        await c.query<{ duty_id: string }>(
          `SELECT duty_id FROM public.edit_leases WHERE company_id=$1
      AND duty_id=ANY($2::uuid[]) AND released_at IS NULL AND expires_at>clock_timestamp()`,
          [
            t.companyId,
            changed.filter((x) => !x.created).map((x) => x.duty.id),
          ],
        )
      ).rows.map((x) => x.duty_id),
    );
    if (liveLeases.size)
      saveConflict(
        'LEASE',
        changed
          .filter((x) => liveLeases.has(x.duty.id))
          .map((x) => ({
            date: x.duty.duty_date,
            shiftKind: kindOf(x.duty),
            reason: 'ACTIVE_DUTY_EDIT',
          })),
      );
    if (!preconditions) saveConflict('PRECONDITION', mismatches);
    if (changed.length || pending.length) {
      if (project.status !== 'ACTIVE')
        saveConflict('VALIDATION', [
          {
            date: changed[0]?.duty.duty_date ?? pending[0].date,
            shiftKind: changed[0]
              ? kindOf(changed[0].duty)
              : pending[0].shiftKind,
            reason: 'PROJECT_INACTIVE',
          },
        ]);
      // The final overlay replaces only the target's memberships in this plan.
      const overlay = members
        .filter((m) => m.employee_id !== employeeId)
        .map((m) => ({
          duty: duties.find((d) => d.id === m.duty_id)!,
          employeeId: m.employee_id,
        }));
      for (const day of dto.days)
        if (day.desired.state !== 'OFF') {
          const d = duties.find(
            (d) => d.duty_date === day.date && kindOf(d) === day.desired.state,
          );
          if (d) overlay.push({ duty: d, employeeId });
        }
      const errors = new Map<string, SlotConflict>();
      const add = (d: DutyRow, reason: Reason) => {
        if (!errors.has(d.id))
          errors.set(d.id, { date: d.duty_date, shiftKind: kindOf(d), reason });
      };
      for (const p of pending) errors.set(`${p.date}/${p.shiftKind}`, p);
      // External assignments retain saved UTC instants, including adjacent months.
      const external = (
        await c.query<DutyRow & { employee_id: string; project_id: string }>(
          `SELECT ${dutyColumns('d')},pa.employee_id,d.project_id
        FROM public.plan_assignments pa JOIN public.duties d ON d.company_id=pa.company_id AND d.id=pa.duty_id
        WHERE pa.company_id=$1 AND pa.employee_id=ANY($2::uuid[]) AND pa.state='ACTIVE' AND d.removed_at IS NULL
          AND d.monthly_plan_id<>$3`,
          [t.companyId, ids, planId],
        )
      ).rows;
      const dates = datesInMonth(plan.month_start);
      const absent = new Set(
        (
          await this.availability.listUnavailableDays(
            c,
            t,
            ids,
            dates[0],
            dates.at(-1)!,
          )
        ).map((f) => `${f.employeeId}/${f.day}`),
      );
      for (const delta of changed) {
        const d = delta.duty,
          kind = kindOf(d);
        // A1: pure corrective removals don't require an open calendar date.
        if (delta.role !== null) {
          const state = operatingState(d.duty_date, context.calendar);
          if (state !== 'OPEN')
            add(
              d,
              state === 'MISSING'
                ? 'PROJECT_CALENDAR_MISSING'
                : 'PROJECT_CLOSED_WEEKDAY',
            );
        }
        if (!context.rules.some((r) => r.kind === kind))
          add(d, 'SHIFT_CONFIGURATION_MISSING');
        for (const row of overlay.filter((x) => x.duty.id === d.id)) {
          const e = employees.find((e) => e.id === row.employeeId)!;
          let reason: Reason | undefined;
          if (e.status !== 'ACTIVE') reason = 'EMPLOYEE_INACTIVE';
          else if (
            e.employment_start === null ||
            e.employment_start > d.duty_date ||
            (e.employment_end !== null && e.employment_end < d.duty_date)
          )
            reason = 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY';
          else if (
            links.find((l) => l.employee_id === e.id)?.project_id !==
            plan.project_id
          )
            reason = 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH';
          else if (
            e.shift_eligibility !== 'BOTH' &&
            e.shift_eligibility !== d.shift_kind
          )
            reason = 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT';
          else if (absent.has(`${e.id}/${d.duty_date}`))
            reason = 'EMPLOYEE_UNAVAILABLE';
          else {
            const others = [
              ...overlay
                .filter((x) => x.employeeId === e.id && x.duty.id !== d.id)
                .map((x) => ({ ...x.duty, project_id: plan.project_id })),
              ...external.filter((x) => x.employee_id === e.id),
            ];
            const effective = e.id === employeeId && delta.role !== null;
            if (
              effective &&
              others.some(
                (x) =>
                  x.project_id === plan.project_id &&
                  x.duty_date === d.duty_date &&
                  x.shift_kind !== d.shift_kind,
              )
            )
              reason = 'EMPLOYEE_DAILY_SHIFT_CONFLICT';
            else if (
              others.some(
                (x) => x.starts_at < d.ends_at && x.ends_at > d.starts_at,
              )
            )
              reason = 'DUTY_ASSIGNMENT_CONFLICT';
          }
          if (reason)
            add(d, e.id === employeeId ? reason : 'PRESERVED_ROSTER_CONFLICT');
        }
      }
      if (errors.size) saveConflict('VALIDATION', [...errors.values()]);
    }
    const counts = {
      createdDuties: 0,
      changedDuties: 0,
      addedMemberships: 0,
      removedMemberships: 0,
      updatedMemberships: 0,
    };
    const changes: SaveResult['changes'] = [];
    for (const x of changed.sort((a, b) => (a.duty.id < b.duty.id ? -1 : 1))) {
      const old = x.duty;
      const d = x.created
        ? old
        : (
            await c.query<DutyRow>(
              `UPDATE public.duties AS d SET concurrency_version=concurrency_version+1,
        updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 RETURNING ${dutyColumns('d')}`,
              [t.companyId, old.id],
            )
          ).rows[0];
      let member: MembershipRow | undefined, removedAt: string | undefined;
      if (x.before && x.role === null) {
        const r = await c.query<{ removed_at: string }>(
          `UPDATE public.plan_assignments SET state='REMOVED',removed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE company_id=$1 AND id=$2 RETURNING to_char(removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS removed_at`,
          [t.companyId, x.before.id],
        );
        removedAt = r.rows[0].removed_at;
        counts.removedMemberships++;
      } else if (x.before) {
        member = (
          await c.query<MembershipRow>(
            `UPDATE public.plan_assignments AS pa SET duty_function=$3,updated_at=clock_timestamp()
          WHERE company_id=$1 AND id=$2 RETURNING ${MEMBER_COLUMNS}`,
            [t.companyId, x.before.id, x.role],
          )
        ).rows[0];
        counts.updatedMemberships++;
      } else {
        member = (
          await c.query<MembershipRow>(
            `INSERT INTO public.plan_assignments AS pa(company_id,duty_id,employee_id,duty_function)
          VALUES($1,$2,$3,$4) RETURNING ${MEMBER_COLUMNS}`,
            [t.companyId, d.id, employeeId, x.role],
          )
        ).rows[0];
        counts.addedMemberships++;
      }
      counts[x.created ? 'createdDuties' : 'changedDuties']++;
      const dutyValues = (v: DutyRow) => ({
        planId,
        dutyDate: v.duty_date,
        shiftKind: kindOf(v),
        startsAt: v.starts_at,
        endsAt: v.ends_at,
        version: toDutyVersion(v.version),
      });
      const memberValues = (m: MembershipRow) => ({
        dutyId: m.duty_id,
        employeeId: m.employee_id,
        dutyRole: selectedAssignment(m)!.dutyRole,
        source: m.source,
      });
      const base = {
        companyId: t.companyId,
        actorAccountId: t.accountId,
        correlationId,
      };
      await this.audit.recordBusinessAction(c, {
        ...base,
        action: x.created ? 'DUTY_CREATED' : 'DUTY_UPDATED',
        resourceType: 'DUTY',
        resourceId: d.id,
        ...(x.created ? {} : { oldValues: dutyValues(old) }),
        newValues: dutyValues(d),
      });
      await this.audit.recordBusinessAction(c, {
        ...base,
        action: !x.before
          ? 'DUTY_MEMBERSHIP_ADDED'
          : x.role === null
            ? 'DUTY_MEMBERSHIP_REMOVED'
            : 'DUTY_MEMBERSHIP_UPDATED',
        resourceType: 'DUTY_ASSIGNMENT',
        resourceId: (member ?? x.before)!.id,
        ...(x.before ? { oldValues: memberValues(x.before) } : {}),
        newValues: member
          ? memberValues(member)
          : { dutyId: d.id, state: 'REMOVED', removedAt: removedAt! },
      });
      changes.push({
        date: d.duty_date,
        shiftKind: kindOf(d),
        ...readSlot(d, member)!,
      });
    }
    const moment = (
      await c.query<{ id: string; at: string }>(
        `SELECT gen_random_uuid() AS id,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
      )
    ).rows[0];
    return {
      commandId: moment.id,
      outcome: changes.length ? 'APPLIED' : 'NO_OP',
      completedAt: moment.at,
      plan: toMonthlyPlanResponse(plan),
      employeeId,
      counts,
      changes: changes.sort((a, b) =>
        a.date === b.date
          ? a.shiftKind === 'DAY'
            ? -1
            : 1
          : a.date < b.date
            ? -1
            : 1,
      ),
    };
  }
}
