/**
 * SP-11 foundation plus owner-approved SP-12 duty edits/removal and leases.
 * COMPANY_ADMIN only. SP-13 adds initial publication; replacement is separate.
 * CR-03 allows authorized, revalidated mutation of current PUBLISHED plans.
 *
 * Tenant rules (SP-06): companyId, accountId and role come only from the
 * trusted TenantContext; every statement filters by company_id on every
 * relation; unknown, foreign and ARCHIVED-project resources are an
 * indistinguishable 404.
 *
 * Writes follow LOCK-01-L1 (T1): A accounts (lockAccountsPrefix, actor SHARE)
 * -> C company SHARE -> E employees (sorted, NO KEY UPDATE) -> P project SHARE
 * -> M monthly assignments (sorted, SHARE) -> L plan SHARE -> D UPDATE/inserts
 * -> A2 memberships UPDATE/inserts -> Q lease UPDATE -> W1/W2 reconciliation -> Z audit. Every check
 * after a lock is a NEW statement (READ COMMITTED sees
 * what the writers it waited for committed). The parent locks also protect
 * absent rows: assignment, employment, absence and deactivation writers hold
 * conflicting employee locks; project status and configuration writers hold
 * the project NO KEY UPDATE lock. Concurrent identical inserts are decided by
 * the unique indexes and mapped to the catalogued 409.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PlanningMutationDispatcher } from '../../common/transactions/planning-mutation.js';
import { DatabaseService } from '../../database/database.service.js';
import { requireRow } from '../../auth/authorization/require-row.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { uniqueViolationConstraint } from '../../common/database/unique-violation.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { AvailabilityService } from '../workforce/availability/availability.service.js';
import { validCivilDate } from '../workforce/availability/availability.rules.js';
import { shiftKindToDb } from '../workforce/shift-configurations/shift-configuration.mapper.js';
import type {
  CreateMonthlyPlanDto,
  CreateMonthlyPlanEntryDto,
  ListMonthlyPlanEntriesQueryDto,
  ListMonthlyPlansQueryDto,
  UpdateMonthlyPlanEntryDto,
} from './dto/monthly-plan.dto.js';
import { DutyTimeZoneError, assertDutyTimeResolverReady, resolveDutyInterval } from './duty-time-resolver.js';
import {
  availabilityKey,
  dutyColumns,
  dutyOrder,
  dutyRoleToDb,
  monthlyPlanColumns,
  toMonthlyPlanEntryResponse,
  toMonthlyPlanResponse,
  toDutyAssignmentResponse,
  toDutyVersion,
  type DutyRow,
  type MembershipRow,
  type MonthlyPlanRow,
} from './monthly-plan.mapper.js';
import type {
  MonthlyPlanEntryCollection,
  MonthlyPlanEntryResponse,
  MonthlyPlanPage,
  MonthlyPlanResponse,
} from './monthly-plan.types.js';
import { PLANNING_WRITER_TIMEOUTS } from './planning-locks.js';
import { assertPlanningSchemaComplete } from './planning-schema.js';
import { acquireDutyLease, assertDutyLease, editLeaseTtl, releaseDutyLease, renewDutyLease, type EditLeaseResponse } from './duty-edit-leases.js';
import { PublishIdempotencyService } from './publish-idempotency.service.js';
import { assertOperatingDay } from './operating-calendar-guard.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';

const ADMIN_ONLY = ['COMPANY_ADMIN'] as const;
const DEFAULT_PAGE_SIZE = 25;
const PLAN_MONTH_CONSTRAINT = 'uq_monthly_plans__project_month';
const LIVE_SLOT_CONSTRAINT = 'uq_duties__live_slot';
const MEMBERSHIP_COLUMNS = 'pa.id, pa.duty_id, pa.employee_id, pa.duty_function, pa.source';

type Queryable = Pick<PoolClient, 'query'>;

function conflict(code: string): never {
  throw new ConflictException({ code });
}

/** A real civil date (no year 0000, no 30 February) that is the first of its month. */
function assertPlanMonth(monthStart: string): void {
  if (!validCivilDate(monthStart)) throw new BadRequestException({ code: 'INVALID_DATE' });
  if (!monthStart.endsWith('-01')) throw new BadRequestException({ code: 'INVALID_MONTH_START' });
}

/** Proleptic Gregorian; no Date.UTC, which maps the years 0-99 to 1900-1999. */
function lastDayOfMonth(monthStart: string): string {
  const [year, month] = monthStart.split('-').map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return `${monthStart.slice(0, 8)}${String(days).padStart(2, '0')}`;
}

type LockedEmployee = {
  id: string;
  status: string;
  employment_start: string | null;
  employment_end: string | null;
  shift_eligibility: string;
};

type DutySnapshot = DutyRow & {
  time_zone: string;
  config_month: string;
  start_local: string;
  end_local: string;
};
const snapshotColumns = (alias: string) => `${dutyColumns(alias)}, ${alias}.time_zone,
  to_char(${alias}.config_effective_from_month, 'YYYY-MM-DD') AS config_month,
  left(${alias}.start_local::text, 5) AS start_local, left(${alias}.end_local::text, 5) AS end_local`;
const removalColumn = `to_char(removed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS removed_at`;
const memberValues = (row: MembershipRow) => {
  const member = toDutyAssignmentResponse(row);
  return { dutyId: row.duty_id, employeeId: member.employeeId, dutyRole: member.dutyRole, source: member.source };
};
const dutyValues = (planId: string, row: DutyRow) => {
  const entry = toMonthlyPlanEntryResponse(row, [], new Set());
  return { planId, dutyDate: entry.dutyDate, shiftKind: entry.shiftKind, startsAt: entry.startsAt, endsAt: entry.endsAt, version: entry.version };
};
const memberSignature = (members: MembershipRow[]) => JSON.stringify([...members].sort((a, b) => a.id.localeCompare(b.id)));

@Injectable()
export class MonthlyPlansService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
    private readonly availability: AvailabilityService,
    private readonly publishIdempotency: PublishIdempotencyService,
    private readonly mutations: PlanningMutationDispatcher,
  ) {}

  /** T6: the application does not start if the resolver misses an approved D6 golden. */
  onModuleInit(): void {
    assertDutyTimeResolverReady();
    editLeaseTtl();
  }

  async list(tenant: TenantContext, query: ListMonthlyPlansQueryDto): Promise<MonthlyPlanPage> {
    if (query.monthStart !== undefined) assertPlanMonth(query.monthStart);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const params: unknown[] = [tenant.companyId];
    // ARCHIVED projects stay invisible through planning reads (ADR-0002 addendum).
    const where = ['mp.company_id = $1', "p.status IN ('ACTIVE', 'INACTIVE')"];
    if (query.projectId !== undefined) {
      params.push(query.projectId);
      where.push(`mp.project_id = $${params.length}`);
    }
    if (query.monthStart !== undefined) {
      params.push(query.monthStart);
      where.push(`mp.planning_month = $${params.length}::date`);
    }
    if (query.status !== undefined) {
      params.push(query.status);
      where.push(`mp.status = $${params.length}`);
    }
    const from = `public.monthly_plans AS mp
      JOIN projects AS p ON p.company_id = mp.company_id AND p.id = mp.project_id
      WHERE ${where.join(' AND ')}`;

    return this.database.withTransaction(async (client) => {
      // Count and page from ONE snapshot, so totals match the returned page.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await assertPlanningSchemaComplete(client);
      const counted = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${from}`, params);
      const rows = await client.query<MonthlyPlanRow>(
        `SELECT ${monthlyPlanColumns('mp')} FROM ${from}
         ORDER BY mp.planning_month DESC, mp.id ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const totalItems = counted.rows[0].total;
      return {
        items: rows.rows.map(toMonthlyPlanResponse),
        pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
      };
    });
  }

  async get(tenant: TenantContext, planId: string): Promise<MonthlyPlanResponse> {
    return this.database.withTransaction(async (client) => {
      await assertPlanningSchemaComplete(client);
      return toMonthlyPlanResponse(await this.visiblePlan(client, tenant, planId));
    });
  }

  /**
   * First publication only. The idempotency component rechecks the actor and
   * visibility in both its short claim and business transactions. It owns I
   * before this callback takes E/P/M/L/D/A2; audit and completion share this
   * transaction. CR-03 duty mutations keep their existing direct-write path.
   */
  publish(tenant: TenantContext, planId: string, key: string, correlationId: string) {
    return this.publishIdempotency.execute(tenant, planId, key, async (client) => {
      await assertPlanningSchemaComplete(client);
      return this.visiblePlan(client, tenant, planId);
    }, async (client) => {
      const discovery = await this.visiblePlan(client, tenant, planId);
      const discoveredDuties = (await client.query<DutySnapshot>(
        `SELECT ${snapshotColumns('d')} FROM public.duties AS d
         WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.removed_at IS NULL ORDER BY d.id`,
        [tenant.companyId, planId],
      )).rows;
      const discoveredMembers = await this.activeMembers(client, tenant, discoveredDuties.map((duty) => duty.id));
      const employeeIds = [...new Set(discoveredMembers.map((member) => member.employee_id))].sort();
      const employees = employeeIds.length === 0 ? [] : (await client.query<LockedEmployee>(
        `SELECT id, status, shift_eligibility, to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
                to_char(employment_end, 'YYYY-MM-DD') AS employment_end
         FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
        [tenant.companyId, employeeIds],
      )).rows;
      if (employees.length !== employeeIds.length) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      const project = requireRow(await client.query<{ status: string }>(
        `SELECT status FROM projects WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE') FOR SHARE`,
        [tenant.companyId, discovery.project_id],
      ));
      const links = employeeIds.length === 0 ? [] : (await client.query<{ employee_id: string; project_id: string }>(
        `SELECT employee_id, project_id FROM project_assignments
         WHERE company_id = $1 AND employee_id = ANY($2::uuid[]) AND planning_month = $3::date ORDER BY id FOR SHARE`,
        [tenant.companyId, employeeIds, discovery.month_start],
      )).rows;
      // Take UPDATE at L immediately. Never upgrade SHARE or acquire a late E.
      const plan = requireRow(await client.query<MonthlyPlanRow>(
        `SELECT ${monthlyPlanColumns('mp')} FROM public.monthly_plans AS mp
         WHERE mp.company_id = $1 AND mp.id = $2 FOR UPDATE`, [tenant.companyId, planId],
      ));
      if (plan.status === 'PUBLISHED') conflict('MONTHLY_PLAN_ALREADY_PUBLISHED');
      if (plan.status !== 'UNPUBLISHED') throw new Error('Unexpected publish lifecycle');
      if (plan.project_id !== discovery.project_id || plan.month_start !== discovery.month_start) conflict('PLAN_CONCURRENT_MODIFICATION');
      const duties = (await client.query<DutySnapshot>(
        `SELECT ${snapshotColumns('d')} FROM public.duties AS d
         WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.removed_at IS NULL ORDER BY d.id FOR UPDATE`,
        [tenant.companyId, planId],
      )).rows;
      const members = duties.length === 0 ? [] : (await client.query<MembershipRow>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM public.plan_assignments AS pa
         WHERE pa.company_id = $1 AND pa.duty_id = ANY($2::uuid[]) AND pa.state = 'ACTIVE' ORDER BY pa.id FOR UPDATE`,
        [tenant.companyId, duties.map((duty) => duty.id)],
      )).rows;
      if (JSON.stringify(discoveredDuties) !== JSON.stringify(duties)
        || memberSignature(discoveredMembers) !== memberSignature(members)) conflict('PLAN_CONCURRENT_MODIFICATION');
      if (project.status !== 'ACTIVE') conflict('PROJECT_INACTIVE');
      // No staffing minimum. Check every live duty, including unstaffed ones;
      // validate existing saved UTC intervals without changing their provenance.
      await assertSessionInTransaction(client, tenant);
      // A missing calendar also blocks an empty plan's First Publish.
      const calendar = await client.query(`SELECT 1 FROM public.project_operating_calendars
        WHERE company_id = $1 AND project_id = $2 AND effective_from_month <= $3::date LIMIT 1`,
      [tenant.companyId, plan.project_id, plan.month_start]);
      if (calendar.rowCount !== 1) conflict('PROJECT_CALENDAR_MISSING');
      for (const duty of duties) {
        await assertOperatingDay(client, tenant.companyId, plan.project_id, duty.duty_date);
        await this.effectiveRule(client, tenant, plan.project_id, plan.month_start, duty.shift_kind);
        const roster = new Set(members.filter((member) => member.duty_id === duty.id).map((member) => member.employee_id));
        await this.assertStaffing(client, tenant, employees.filter((employee) => roster.has(employee.id)), links,
          plan.project_id, duty.duty_date, duty.shift_kind, { startsAt: duty.starts_at, endsAt: duty.ends_at }, duty.id);
      }
      const published = await client.query<MonthlyPlanRow>(
        `UPDATE public.monthly_plans AS mp SET status = 'PUBLISHED', published_at = clock_timestamp(),
           published_by_account_id = $3, updated_at = clock_timestamp()
         WHERE mp.company_id = $1 AND mp.id = $2 AND mp.status = 'UNPUBLISHED'
         RETURNING ${monthlyPlanColumns('mp')}`, [tenant.companyId, planId, tenant.accountId],
      );
      if (published.rowCount !== 1) conflict('MONTHLY_PLAN_ALREADY_PUBLISHED');
      const result = toMonthlyPlanResponse(published.rows[0]);
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'MONTHLY_PLAN_PUBLISHED',
        resourceType: 'MONTHLY_PLAN', resourceId: planId,
        oldValues: { status: 'UNPUBLISHED', publishedAt: null },
        newValues: { status: 'PUBLISHED', publishedAt: result.publishedAt }, correlationId,
      });
      return result;
    });
  }

  /** Whole latest configuration version, shared by create, edit and publish. */
  private async effectiveRule(client: Queryable, tenant: TenantContext, projectId: string, month: string, kind: string) {
    const rule = await client.query<{ effective_from_month: string; start_local: string; end_local: string }>(
      `SELECT to_char(sc.effective_from_month, 'YYYY-MM-DD') AS effective_from_month,
              left(sc.start_local::text, 5) AS start_local, left(sc.end_local::text, 5) AS end_local
       FROM shift_configurations AS sc
       WHERE sc.company_id = $1 AND sc.project_id = $2 AND sc.shift_kind = $4
         AND sc.effective_from_month = (
           SELECT max(v.effective_from_month) FROM shift_configurations AS v
           WHERE v.company_id = $1 AND v.project_id = $2 AND v.effective_from_month <= $3::date)`,
      [tenant.companyId, projectId, month, kind],
    );
    if (rule.rowCount !== 1) conflict('SHIFT_CONFIGURATION_MISSING');
    return rule.rows[0];
  }

  /**
   * Precedence: 400 INVALID_DATE / INVALID_MONTH_START -> [transaction] 401/403
   * actor -> 500 unusable planning schema -> 404 project (unknown, foreign,
   * ARCHIVED) -> 409 PROJECT_INACTIVE -> 409 MONTHLY_PLAN_ALREADY_EXISTS ->
   * plan + MONTHLY_PLAN_CREATED audit. No past-month restriction is invented.
   */
  async create(tenant: TenantContext, dto: CreateMonthlyPlanDto, correlationId: string): Promise<MonthlyPlanResponse> {
    assertPlanMonth(dto.monthStart);
    return this.database.withTransaction(async (client) => {
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ADMIN_ONLY);
      await assertPlanningSchemaComplete(client);
      // P SHARE: excluded by a concurrent project status change (NO KEY UPDATE).
      const project = requireRow(await client.query<{ status: string }>(
        `SELECT status FROM projects
         WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE')
         FOR SHARE`,
        [tenant.companyId, dto.projectId],
      ));
      if (project.status !== 'ACTIVE') conflict('PROJECT_INACTIVE');

      // Deterministic 409 for the common case; the UNIQUE constraint decides races.
      await assertSessionInTransaction(client, tenant);
      const existing = await client.query(
        'SELECT 1 FROM public.monthly_plans WHERE company_id = $1 AND project_id = $2 AND planning_month = $3::date',
        [tenant.companyId, dto.projectId, dto.monthStart],
      );
      if (existing.rowCount !== 0) conflict('MONTHLY_PLAN_ALREADY_EXISTS');

      let row: MonthlyPlanRow;
      try {
        row = (await client.query<MonthlyPlanRow>(
          `INSERT INTO public.monthly_plans AS mp (company_id, project_id, planning_month)
           VALUES ($1, $2, $3::date)
           RETURNING ${monthlyPlanColumns('mp')}`,
          [tenant.companyId, dto.projectId, dto.monthStart],
        )).rows[0];
      } catch (error) {
        if (uniqueViolationConstraint(error) === PLAN_MONTH_CONSTRAINT) conflict('MONTHLY_PLAN_ALREADY_EXISTS');
        throw error;
      }
      const plan = toMonthlyPlanResponse(row);

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'MONTHLY_PLAN_CREATED',
        resourceType: 'MONTHLY_PLAN',
        resourceId: plan.id,
        newValues: { projectId: plan.projectId, monthStart: plan.monthStart, status: plan.status },
        correlationId,
      });
      return plan;
    });
  }

  async listEntries(
    tenant: TenantContext,
    planId: string,
    query: ListMonthlyPlanEntriesQueryDto,
  ): Promise<MonthlyPlanEntryCollection> {
    return this.database.withTransaction(async (client) => {
      // Plan, duties, members and absence facts from ONE snapshot.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await assertPlanningSchemaComplete(client);
      const plan = await this.visiblePlan(client, tenant, planId);
      const params: unknown[] = [tenant.companyId, plan.id];
      let kindFilter = '';
      if (query.shiftKind !== undefined) {
        params.push(shiftKindToDb(query.shiftKind));
        kindFilter = `AND d.shift_kind = $${params.length}`;
      }
      const duties = await client.query<DutyRow>(
        `SELECT ${dutyColumns('d')} FROM public.duties AS d
         WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.removed_at IS NULL ${kindFilter}
         ORDER BY ${dutyOrder('d')}`,
        params,
      );
      const members = await this.activeMembers(client, tenant, duties.rows.map((duty) => duty.id));
      const unavailable = await this.unavailableKeys(client, tenant, members, plan.month_start, lastDayOfMonth(plan.month_start));
      return {
        items: duties.rows.map((duty) =>
          toMonthlyPlanEntryResponse(duty, members.filter((member) => member.duty_id === duty.id), unavailable)),
      };
    });
  }

  /**
   * SP-12: the same current aggregate as the collection, scoped to its exact
   * plan and tenant. Tombstones and ARCHIVED projects remain concealed. One
   * read-only snapshot keeps the duty version, memberships and neutral absence
   * conflicts consistent if a writer commits between the component reads.
   * No lease/version precondition or business success audit applies to a GET.
   */
  async getEntry(tenant: TenantContext, planId: string, entryId: string): Promise<MonthlyPlanEntryResponse> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await assertPlanningSchemaComplete(client);
      const plan = await this.visiblePlan(client, tenant, planId);
      const duty = requireRow(await client.query<DutyRow>(
        `SELECT ${dutyColumns('d')} FROM public.duties AS d
         WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.id = $3 AND d.removed_at IS NULL`,
        [tenant.companyId, plan.id, entryId],
      ));
      const members = await this.activeMembers(client, tenant, [duty.id]);
      const unavailable = await this.unavailableKeys(client, tenant, members, duty.duty_date, duty.duty_date);
      return toMonthlyPlanEntryResponse(duty, members, unavailable);
    });
  }

  /**
   * One duty with its initial members (empty allowed; no staffing minimum),
   * atomically with DUTY_CREATED and one DUTY_MEMBERSHIP_ADDED per member.
   *
   * Precedence (T5): DTO 400 -> 400 INVALID_DATE -> [transaction] 401/403 actor
   * -> 500 unusable planning schema -> 404 plan (unknown, foreign, ARCHIVED
   * project) -> 400 DUTY_DATE_OUTSIDE_PLAN_MONTH (structural, before any 409) ->
   * 404 submitted employee -> locks -> 409 PROJECT_INACTIVE -> 409
   * DUTY_ALREADY_EXISTS -> 409 PROJECT_CALENDAR_MISSING / PROJECT_CLOSED_WEEKDAY
   * -> 409 SHIFT_CONFIGURATION_MISSING -> D6 resolution ->
   * 409 DUTY_TIME_RANGE_INVALID -> staffing per employee in id order: 409
   * EMPLOYEE_INACTIVE -> EMPLOYEE_NOT_EMPLOYED_FOR_DAY ->
   * EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH -> EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT ->
   * EMPLOYEE_UNAVAILABLE -> EMPLOYEE_DAILY_SHIFT_CONFLICT -> DUTY_ASSIGNMENT_CONFLICT -> writes + audit.
   * An unrecognised company zone is a sanitized 500. The plan's lifecycle state
   * is not checked: under CR-03 a PUBLISHED plan takes direct, revalidated
   * changes; this slice itself cannot publish.
   */
  async createEntry(
    tenant: TenantContext,
    planId: string,
    dto: CreateMonthlyPlanEntryDto,
    correlationId: string,
  ): Promise<MonthlyPlanEntryResponse> {
    if (!validCivilDate(dto.dutyDate)) throw new BadRequestException({ code: 'INVALID_DATE' });
    const roster = new Map<string, string>();
    for (const assignment of dto.assignments ?? []) {
      roster.set(assignment.employeeId.toLowerCase(), dutyRoleToDb(assignment.dutyRole));
    }
    const employeeIds = [...roster.keys()].sort();
    const kind = shiftKindToDb(dto.shiftKind);

    return this.database.withTransaction(async (client) => {
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ADMIN_ONLY);
      await assertPlanningSchemaComplete(client);
      // Discovery read: plan identity (its project and month are immutable).
      const plan = await this.visiblePlan(client, tenant, planId);
      if (dto.dutyDate.slice(0, 8) !== plan.month_start.slice(0, 8)) {
        throw new BadRequestException({ code: 'DUTY_DATE_OUTSIDE_PLAN_MONTH' });
      }

      // E: every submitted employee, ascending id, NO KEY UPDATE; foreign or unknown -> 404.
      const employees = employeeIds.length === 0 ? [] : (await client.query<LockedEmployee>(
        `SELECT id, status, shift_eligibility,
                to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
                to_char(employment_end, 'YYYY-MM-DD') AS employment_end
         FROM employees
         WHERE company_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id
         FOR NO KEY UPDATE`,
        [tenant.companyId, employeeIds],
      )).rows;
      if (employees.length !== employeeIds.length) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      // P: the plan's project, SHARE (status and configuration writers hold NO KEY UPDATE).
      const project = requireRow(await client.query<{ status: string }>(
        `SELECT status FROM projects
         WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE')
         FOR SHARE`,
        [tenant.companyId, plan.project_id],
      ));
      // M: the members' monthly assignments of the plan month, ascending id, SHARE.
      const links = employeeIds.length === 0 ? [] : (await client.query<{ employee_id: string; project_id: string }>(
        `SELECT employee_id, project_id FROM project_assignments
         WHERE company_id = $1 AND employee_id = ANY($2::uuid[]) AND planning_month = $3::date
         ORDER BY id
         FOR SHARE`,
        [tenant.companyId, employeeIds, plan.month_start],
      )).rows;
      // L: the plan lifecycle row, SHARE (a first publication takes UPDATE).
      requireRow(await client.query(
        'SELECT 1 FROM public.monthly_plans WHERE company_id = $1 AND id = $2 FOR SHARE',
        [tenant.companyId, plan.id],
      ));

      if (project.status !== 'ACTIVE') conflict('PROJECT_INACTIVE');
      const slot = await client.query(
        `SELECT 1 FROM public.duties
         WHERE company_id = $1 AND monthly_plan_id = $2 AND duty_date = $3::date AND shift_kind = $4
           AND removed_at IS NULL`,
        [tenant.companyId, plan.id, dto.dutyDate, kind],
      );
      if (slot.rowCount !== 0) conflict('DUTY_ALREADY_EXISTS');

      // The WHOLE latest version <= plan month; a kind missing from it is not inherited.
      await assertSessionInTransaction(client, tenant);
      await assertOperatingDay(client, tenant.companyId, plan.project_id, dto.dutyDate);
      const configuration = await this.effectiveRule(client, tenant, plan.project_id, plan.month_start, kind);

      const zone = await this.companyZone(client, tenant);
      const interval = resolveDutyInterval({
        zone,
        dutyDate: dto.dutyDate,
        startLocal: configuration.start_local,
        endLocal: configuration.end_local,
      });
      if (interval === null) conflict('DUTY_TIME_RANGE_INVALID');

      await this.assertStaffing(client, tenant, employees, links, plan.project_id, dto.dutyDate, kind, interval);

      let duty: DutyRow;
      try {
        duty = (await client.query<DutyRow>(
          `INSERT INTO public.duties AS d (
             company_id, project_id, monthly_plan_id, planning_month, duty_date, shift_kind,
             starts_at, ends_at, time_zone, config_effective_from_month, start_local, end_local
           )
           VALUES ($1, $2, $3, $4::date, $5::date, $6, $7::timestamptz, $8::timestamptz, $9, $10::date,
                   $11::time, $12::time)
           RETURNING ${dutyColumns('d')}`,
          [tenant.companyId, plan.project_id, plan.id, plan.month_start, dto.dutyDate, kind,
            interval.startsAt, interval.endsAt, zone, configuration.effective_from_month,
            configuration.start_local, configuration.end_local],
        )).rows[0];
      } catch (error) {
        if (uniqueViolationConstraint(error) === LIVE_SLOT_CONSTRAINT) conflict('DUTY_ALREADY_EXISTS');
        throw error;
      }

      const members = employeeIds.length === 0 ? [] : (await client.query<MembershipRow>(
        `INSERT INTO public.plan_assignments AS pa (company_id, duty_id, employee_id, duty_function)
         SELECT $1, $2, t.employee_id, t.duty_function
         FROM unnest($3::uuid[], $4::text[]) AS t(employee_id, duty_function)
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [tenant.companyId, duty.id, employeeIds, employeeIds.map((id) => roster.get(id))],
      )).rows;

      const entry = toMonthlyPlanEntryResponse(
        duty,
        members,
        await this.unavailableKeys(client, tenant, members, dto.dutyDate, dto.dutyDate),
      );
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'DUTY_CREATED',
        resourceType: 'DUTY',
        resourceId: entry.id,
        newValues: {
          planId: plan.id,
          dutyDate: entry.dutyDate,
          shiftKind: entry.shiftKind,
          startsAt: entry.startsAt,
          endsAt: entry.endsAt,
          version: entry.version,
        },
        correlationId,
      });
      for (const member of entry.assignments) {
        await this.audit.recordBusinessAction(client, {
          companyId: tenant.companyId,
          actorAccountId: tenant.accountId,
          action: 'DUTY_MEMBERSHIP_ADDED',
          resourceType: 'DUTY_ASSIGNMENT',
          resourceId: member.id,
          newValues: { dutyId: entry.id, employeeId: member.employeeId, dutyRole: member.dutyRole, source: member.source },
          correlationId,
        });
      }
      return entry;
    });
  }

  acquireLease(tenant: TenantContext, planId: string, dutyId: string): Promise<EditLeaseResponse> {
    return this.leaseCommand(tenant, planId, dutyId, (client) => acquireDutyLease(client, tenant, dutyId));
  }

  renewLease(tenant: TenantContext, planId: string, dutyId: string, token: string | string[]): Promise<EditLeaseResponse> {
    return this.leaseCommand(tenant, planId, dutyId, (client) => renewDutyLease(client, tenant, dutyId, token));
  }

  releaseLease(tenant: TenantContext, planId: string, dutyId: string, token: string | string[]): Promise<void> {
    return this.leaseCommand(tenant, planId, dutyId, (client) => releaseDutyLease(client, tenant, dutyId, token));
  }

  /** Lease commands have no employee work: A/C -> P SHARE -> L SHARE -> D UPDATE -> Q. */
  private leaseCommand<T>(tenant: TenantContext, planId: string, dutyId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.withTransaction(async (client) => {
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ADMIN_ONLY);
      await assertPlanningSchemaComplete(client);
      const plan = await this.visiblePlan(client, tenant, planId);
      requireRow(await client.query(
        `SELECT 1 FROM projects WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE') FOR SHARE`,
        [tenant.companyId, plan.project_id],
      ));
      requireRow(await client.query('SELECT 1 FROM public.monthly_plans WHERE company_id = $1 AND id = $2 FOR SHARE', [tenant.companyId, plan.id]));
      requireRow(await client.query(
        `SELECT 1 FROM public.duties WHERE company_id = $1 AND monthly_plan_id = $2 AND id = $3 AND removed_at IS NULL FOR UPDATE`,
        [tenant.companyId, plan.id, dutyId],
      ));
      await assertSessionInTransaction(client, tenant);
      return work(client);
    });
  }

  /**
   * Discovery determines the complete employee lock set; it never authorizes
   * eligibility. Fresh reads after every wait, then L/D/A2/Q in L1 order.
   * A changed discovery set aborts; never acquire a newly discovered E lock late.
   * Lease authentication precedes version/drift conflicts and true no-op.
   */
  private async lockMutation(
    client: PoolClient, tenant: TenantContext, planId: string, dutyId: string,
    expectedVersion: number, token: string | string[], dto?: UpdateMonthlyPlanEntryDto,
  ) {
    await client.query(PLANNING_WRITER_TIMEOUTS);
    await lockAccountsPrefix(client, tenant, ADMIN_ONLY);
    await assertPlanningSchemaComplete(client);
    const plan = await this.visiblePlan(client, tenant, planId);
    if (dto?.dutyDate !== undefined && dto.dutyDate.slice(0, 8) !== plan.month_start.slice(0, 8)) {
      throw new BadRequestException({ code: 'DUTY_DATE_OUTSIDE_PLAN_MONTH' });
    }
    const discovery = requireRow(await client.query<DutySnapshot>(
      `SELECT ${snapshotColumns('d')} FROM public.duties AS d
       WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.id = $3 AND d.removed_at IS NULL`,
      [tenant.companyId, plan.id, dutyId],
    ));
    const discoveredMembers = await this.activeMembers(client, tenant, [dutyId]);
    const roster = dto?.assignments === undefined
      ? new Map(discoveredMembers.map((member) => [member.employee_id, member.duty_function]))
      : new Map(dto.assignments.map((member) => [member.employeeId.toLowerCase(), dutyRoleToDb(member.dutyRole)]));
    const employeeIds = [...new Set([...roster.keys(), ...discoveredMembers.map((member) => member.employee_id)])].sort();
    const employees = employeeIds.length === 0 ? [] : (await client.query<LockedEmployee>(
      `SELECT id, status, shift_eligibility, to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
              to_char(employment_end, 'YYYY-MM-DD') AS employment_end
       FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
      [tenant.companyId, employeeIds],
    )).rows;
    if (employees.length !== employeeIds.length) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    const project = requireRow(await client.query<{ status: string }>(
      `SELECT status FROM projects WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE') FOR SHARE`,
      [tenant.companyId, plan.project_id],
    ));
    const links = employeeIds.length === 0 ? [] : (await client.query<{ employee_id: string; project_id: string }>(
      `SELECT employee_id, project_id FROM project_assignments
       WHERE company_id = $1 AND employee_id = ANY($2::uuid[]) AND planning_month = $3::date ORDER BY id FOR SHARE`,
      [tenant.companyId, employeeIds, plan.month_start],
    )).rows;
    requireRow(await client.query('SELECT 1 FROM public.monthly_plans WHERE company_id = $1 AND id = $2 FOR SHARE', [tenant.companyId, plan.id]));
    const duty = requireRow(await client.query<DutySnapshot>(
      `SELECT ${snapshotColumns('d')} FROM public.duties AS d
       WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.id = $3 AND d.removed_at IS NULL FOR UPDATE`,
      [tenant.companyId, plan.id, dutyId],
    ));
    const members = (await client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM public.plan_assignments AS pa
       WHERE pa.company_id = $1 AND pa.duty_id = $2 AND pa.state = 'ACTIVE' ORDER BY pa.id FOR UPDATE`,
      [tenant.companyId, dutyId],
    )).rows;
    await assertDutyLease(client, tenant, dutyId, token);
    await assertSessionInTransaction(client, tenant);
    if (toDutyVersion(duty.version) !== expectedVersion || JSON.stringify(discovery) !== JSON.stringify(duty)
      || memberSignature(discoveredMembers) !== memberSignature(members)) conflict('PLAN_CONCURRENT_MODIFICATION');
    return { plan, duty, members, roster, employees, links, project };
  }

  async updateEntry(
    tenant: TenantContext, planId: string, dutyId: string, dto: UpdateMonthlyPlanEntryDto,
    expectedVersion: number, token: string | string[], correlationId: string,
  ): Promise<MonthlyPlanEntryResponse> {
    if (dto.dutyDate === undefined && dto.shiftKind === undefined && dto.assignments === undefined) {
      throw new BadRequestException({ code: 'EMPTY_PATCH' });
    }
    if (dto.dutyDate !== undefined && !validCivilDate(dto.dutyDate)) throw new BadRequestException({ code: 'INVALID_DATE' });
    return this.database.withTransaction(async (client) => {
      const { plan, duty, members, roster, employees, links, project } =
        await this.lockMutation(client, tenant, planId, dutyId, expectedVersion, token, dto);
      const day = dto.dutyDate ?? duty.duty_date;
      const kind = dto.shiftKind === undefined ? duty.shift_kind : shiftKindToDb(dto.shiftKind);
      const timeChanged = day !== duty.duty_date || kind !== duty.shift_kind;
      const rosterChanged = roster.size !== members.length || members.some((member) => roster.get(member.employee_id) !== member.duty_function);
      if (!timeChanged && !rosterChanged) {
        return toMonthlyPlanEntryResponse(duty, members, await this.unavailableKeys(client, tenant, members, day, day));
      }
      if (project.status !== 'ACTIVE') conflict('PROJECT_INACTIVE');
      const slot = await client.query(
        `SELECT 1 FROM public.duties WHERE company_id = $1 AND monthly_plan_id = $2 AND duty_date = $3::date
           AND shift_kind = $4 AND id <> $5 AND removed_at IS NULL`,
        [tenant.companyId, plan.id, day, kind, dutyId],
      );
      if (slot.rowCount !== 0) conflict('DUTY_ALREADY_EXISTS');
      // Pure removals can correct unknown/closed legacy dates and dual staffing.
      // Retained unchanged members are not new assignments; role/time changes are.
      const changedEmployees = employees.filter((employee) => roster.has(employee.id)
        && (timeChanged || !members.some((member) => member.employee_id === employee.id
          && member.duty_function === roster.get(employee.id))));
      if (timeChanged || changedEmployees.length > 0) {
        await assertOperatingDay(client, tenant.companyId, plan.project_id, day);
      }
      const configuration = await this.effectiveRule(client, tenant, plan.project_id, plan.month_start, kind);
      const zone = timeChanged ? await this.companyZone(client, tenant) : duty.time_zone;
      const interval = timeChanged ? resolveDutyInterval({ zone, dutyDate: day, startLocal: configuration.start_local, endLocal: configuration.end_local })
        : { startsAt: duty.starts_at, endsAt: duty.ends_at };
      if (interval === null) conflict('DUTY_TIME_RANGE_INVALID');
      await this.assertStaffing(client, tenant, employees.filter((employee) => roster.has(employee.id)), links,
        plan.project_id, day, kind, interval, dutyId, new Set(changedEmployees.map((employee) => employee.id)));

      let updated: DutyRow;
      try {
        const result = await client.query<DutyRow>(
          `UPDATE public.duties AS d SET duty_date = $4::date, shift_kind = $5, starts_at = $6::timestamptz, ends_at = $7::timestamptz,
             time_zone = $8, config_effective_from_month = $9::date, start_local = $10::time, end_local = $11::time,
             concurrency_version = concurrency_version + 1, updated_at = clock_timestamp()
           WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.id = $3 AND d.removed_at IS NULL
             AND d.concurrency_version = $12 RETURNING ${dutyColumns('d')}`,
          [tenant.companyId, plan.id, dutyId, day, kind, interval.startsAt, interval.endsAt, zone,
            timeChanged ? configuration.effective_from_month : duty.config_month,
            timeChanged ? configuration.start_local : duty.start_local, timeChanged ? configuration.end_local : duty.end_local, expectedVersion],
        );
        if (result.rowCount !== 1) conflict('PLAN_CONCURRENT_MODIFICATION');
        updated = result.rows[0];
      } catch (error) {
        if (uniqueViolationConstraint(error) === LIVE_SLOT_CONSTRAINT) conflict('DUTY_ALREADY_EXISTS');
        throw error;
      }
      const removed = members.filter((member) => !roster.has(member.employee_id));
      const removedRows = removed.length === 0 ? [] : (await client.query<MembershipRow & { removed_at: string }>(
        `UPDATE public.plan_assignments AS pa SET state = 'REMOVED', removed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE pa.company_id = $1 AND pa.duty_id = $2 AND pa.id = ANY($3::uuid[]) AND pa.state = 'ACTIVE'
         RETURNING ${MEMBERSHIP_COLUMNS}, ${removalColumn}`,
        [tenant.companyId, dutyId, removed.map((member) => member.id)],
      )).rows;
      const changed = members.filter((member) => roster.has(member.employee_id) && roster.get(member.employee_id) !== member.duty_function);
      const changedRows = changed.length === 0 ? [] : (await client.query<MembershipRow>(
        `UPDATE public.plan_assignments AS pa SET duty_function = t.role, updated_at = clock_timestamp()
         FROM unnest($3::uuid[], $4::text[]) AS t(id, role)
         WHERE pa.company_id = $1 AND pa.duty_id = $2 AND pa.id = t.id AND pa.state = 'ACTIVE' RETURNING ${MEMBERSHIP_COLUMNS}`,
        [tenant.companyId, dutyId, changed.map((member) => member.id), changed.map((member) => roster.get(member.employee_id))],
      )).rows;
      const oldIds = new Set(members.map((member) => member.employee_id));
      const added = [...roster.keys()].filter((id) => !oldIds.has(id)).sort();
      const addedRows = added.length === 0 ? [] : (await client.query<MembershipRow>(
        `INSERT INTO public.plan_assignments AS pa (company_id, duty_id, employee_id, duty_function)
         SELECT $1, $2, t.employee_id, t.role FROM unnest($3::uuid[], $4::text[]) AS t(employee_id, role)
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [tenant.companyId, dutyId, added, added.map((id) => roster.get(id))],
      )).rows;
      await this.mutations.dispatch(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, correlationId, cause: 'DUTY_PATCH',
        changes: [{ dutyId, removedAssignmentIds: removedRows.map((member) => member.id) }],
      });
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'DUTY_UPDATED',
        resourceType: 'DUTY', resourceId: dutyId, oldValues: dutyValues(plan.id, duty), newValues: dutyValues(plan.id, updated), correlationId,
      });
      for (const member of removedRows) await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'DUTY_MEMBERSHIP_REMOVED',
        resourceType: 'DUTY_ASSIGNMENT', resourceId: member.id, oldValues: memberValues(member),
        newValues: { dutyId, state: 'REMOVED', removedAt: member.removed_at }, correlationId,
      });
      for (const member of changedRows) await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'DUTY_MEMBERSHIP_UPDATED',
        resourceType: 'DUTY_ASSIGNMENT', resourceId: member.id, oldValues: memberValues(members.find((old) => old.id === member.id)!),
        newValues: memberValues(member), correlationId,
      });
      for (const member of addedRows) await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'DUTY_MEMBERSHIP_ADDED',
        resourceType: 'DUTY_ASSIGNMENT', resourceId: member.id, newValues: memberValues(member), correlationId,
      });
      const currentMembers = await this.activeMembers(client, tenant, [dutyId]);
      return toMonthlyPlanEntryResponse(updated, currentMembers, await this.unavailableKeys(client, tenant, currentMembers, day, day));
    });
  }

  async removeEntry(
    tenant: TenantContext, planId: string, dutyId: string, expectedVersion: number, token: string | string[], correlationId: string,
  ): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const { plan, duty } = await this.lockMutation(client, tenant, planId, dutyId, expectedVersion, token);
      const removed = await client.query<DutyRow & { removed_at: string }>(
        `UPDATE public.duties AS d SET removed_at = clock_timestamp(), concurrency_version = concurrency_version + 1, updated_at = clock_timestamp()
         WHERE d.company_id = $1 AND d.monthly_plan_id = $2 AND d.id = $3 AND d.concurrency_version = $4 AND d.removed_at IS NULL
         RETURNING ${dutyColumns('d')}, ${removalColumn}`,
        [tenant.companyId, plan.id, dutyId, expectedVersion],
      );
      if (removed.rowCount !== 1) conflict('PLAN_CONCURRENT_MODIFICATION');
      const timestamp = removed.rows[0].removed_at;
      const memberships = await client.query<MembershipRow & { removed_at: string }>(
        `UPDATE public.plan_assignments AS pa SET state = 'REMOVED', removed_at = $3::timestamptz, updated_at = clock_timestamp()
         WHERE pa.company_id = $1 AND pa.duty_id = $2 AND pa.state = 'ACTIVE' RETURNING ${MEMBERSHIP_COLUMNS}, ${removalColumn}`,
        [tenant.companyId, dutyId, timestamp],
      );
      await client.query('UPDATE public.edit_leases SET released_at = $3::timestamptz WHERE company_id = $1 AND duty_id = $2', [tenant.companyId, dutyId, timestamp]);
      await this.mutations.dispatch(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, correlationId, cause: 'DUTY_DELETE',
        changes: [{ dutyId, removedAssignmentIds: memberships.rows.map((member) => member.id) }],
      });
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'DUTY_REMOVED', resourceType: 'DUTY', resourceId: dutyId,
        oldValues: dutyValues(plan.id, duty), newValues: { version: toDutyVersion(removed.rows[0].version), removedAt: timestamp }, correlationId,
      });
      for (const member of memberships.rows) await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'DUTY_MEMBERSHIP_REMOVED', resourceType: 'DUTY_ASSIGNMENT', resourceId: member.id,
        oldValues: memberValues(member), newValues: { dutyId, state: 'REMOVED', removedAt: member.removed_at }, correlationId,
      });
    });
  }

  /**
   * Staffing rules per employee in ascending id order; the first violation
   * rejects the whole command. Employment uses the inclusive local duty date
   * (missing start = no evidence). Absence and overlap are fresh set-based
   * reads under the employee locks (absence writers and other staffing writers
   * hold conflicting employee locks). Overlap is half-open on UTC instants
   * across all live duties of either plan state; adjacency is allowed.
   * Same-project/local-date exclusivity separately rejects the other kind even
   * when its UTC interval is adjacent. Unchanged legacy members can remain
   * during an unrelated corrective removal; new/moved/role-mutated work cannot.
   */
  private async assertStaffing(
    client: Queryable,
    tenant: TenantContext,
    employees: readonly LockedEmployee[],
    links: readonly { employee_id: string; project_id: string }[],
    projectId: string,
    dutyDate: string,
    kind: string,
    interval: { startsAt: string; endsAt: string },
    excludingDuty: string | null = null,
    changedEmployeeIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (employees.length === 0) return;
    const ids = employees.map((employee) => employee.id);
    const absent = new Set(
      (await this.availability.listUnavailableDays(client, tenant, ids, dutyDate, dutyDate)).map((fact) => fact.employeeId),
    );
    const dual = new Set((await client.query<{ employee_id: string }>(
      `SELECT DISTINCT pa.employee_id FROM public.plan_assignments pa
       JOIN public.duties d ON d.company_id = pa.company_id AND d.id = pa.duty_id
       WHERE pa.company_id = $1 AND pa.employee_id = ANY($2::uuid[]) AND pa.state = 'ACTIVE'
       AND d.removed_at IS NULL AND d.project_id = $3 AND d.duty_date = $4::date AND d.shift_kind <> $5
       AND ($6::uuid IS NULL OR d.id <> $6::uuid)`,
      [tenant.companyId, ids, projectId, dutyDate, kind, excludingDuty],
    )).rows.map((row) => row.employee_id));
    const overlapping = new Set((await client.query<{ employee_id: string }>(
      `SELECT DISTINCT pa.employee_id
       FROM public.plan_assignments AS pa
       JOIN public.duties AS d ON d.company_id = pa.company_id AND d.id = pa.duty_id
       WHERE pa.company_id = $1 AND pa.employee_id = ANY($2::uuid[]) AND pa.state = 'ACTIVE'
         AND d.removed_at IS NULL
         AND ($5::uuid IS NULL OR d.id <> $5::uuid)
         AND d.starts_at < $4::timestamptz AND d.ends_at > $3::timestamptz`,
      [tenant.companyId, ids, interval.startsAt, interval.endsAt, excludingDuty],
    )).rows.map((row) => row.employee_id));

    for (const employee of employees) {
      if (employee.status !== 'ACTIVE') conflict('EMPLOYEE_INACTIVE');
      // YYYY-MM-DD strings compare chronologically.
      const employed = employee.employment_start !== null && employee.employment_start <= dutyDate
        && (employee.employment_end === null || employee.employment_end >= dutyDate);
      if (!employed) conflict('EMPLOYEE_NOT_EMPLOYED_FOR_DAY');
      const link = links.find((candidate) => candidate.employee_id === employee.id);
      if (link?.project_id !== projectId) conflict('EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH');
      if (employee.shift_eligibility !== 'BOTH' && employee.shift_eligibility !== kind) {
        conflict('EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT');
      }
      if (absent.has(employee.id)) conflict('EMPLOYEE_UNAVAILABLE');
      if (dual.has(employee.id) && (changedEmployeeIds === undefined || changedEmployeeIds.has(employee.id))) conflict('EMPLOYEE_DAILY_SHIFT_CONFLICT');
      if (overlapping.has(employee.id)) conflict('DUTY_ASSIGNMENT_CONFLICT');
    }
  }

  /** Tenant plan whose project is visible (ACTIVE/INACTIVE); otherwise 404. */
  private async visiblePlan(client: Queryable, tenant: TenantContext, planId: string): Promise<MonthlyPlanRow> {
    return requireRow(await client.query<MonthlyPlanRow>(
      `SELECT ${monthlyPlanColumns('mp')}
       FROM public.monthly_plans AS mp
       JOIN projects AS p ON p.company_id = mp.company_id AND p.id = mp.project_id
       WHERE mp.company_id = $1 AND mp.id = $2 AND p.status IN ('ACTIVE', 'INACTIVE')`,
      [tenant.companyId, planId],
    ));
  }

  private async activeMembers(client: Queryable, tenant: TenantContext, dutyIds: readonly string[]): Promise<MembershipRow[]> {
    if (dutyIds.length === 0) return [];
    return (await client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM public.plan_assignments AS pa
       WHERE pa.company_id = $1 AND pa.duty_id = ANY($2::uuid[]) AND pa.state = 'ACTIVE'`,
      [tenant.companyId, [...dutyIds]],
    )).rows;
  }

  private async unavailableKeys(
    client: Queryable,
    tenant: TenantContext,
    members: readonly MembershipRow[],
    fromDay: string,
    toDay: string,
  ): Promise<Set<string>> {
    const facts = await this.availability.listUnavailableDays(
      client, tenant, [...new Set(members.map((member) => member.employee_id))], fromDay, toDay,
    );
    return new Set(facts.map((fact) => availabilityKey(fact.employeeId, fact.day)));
  }

  /** The company's IANA zone; the actor recheck holds the company row SHARE. */
  private async companyZone(client: Queryable, tenant: TenantContext): Promise<string> {
    const company = requireRow(await client.query<{ time_zone: string; named: boolean }>(
      `SELECT c.time_zone,
              EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS tz WHERE tz.name = c.time_zone) AS named
       FROM companies AS c WHERE c.id = $1`,
      [tenant.companyId],
    ));
    // PostgreSQL also accepts POSIX strings; only a named IANA zone is a company zone.
    if (!company.named) throw new DutyTimeZoneError();
    return company.time_zone;
  }
}
