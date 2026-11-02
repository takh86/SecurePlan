/**
 * SP-11 PR-1 planning slice (SP11A-R1 Rev3.1 with K1-K3; COMPANY_ADMIN only):
 * create/list/read monthly plans and create/list duties (MonthlyPlanEntry).
 * No publish, edit, removal, lease or replacement route exists in this slice,
 * so plans created here stay UNPUBLISHED (the accepted pre-publication boundary).
 *
 * Tenant rules (SP-06): companyId, accountId and role come only from the
 * trusted TenantContext; every statement filters by company_id on every
 * relation; unknown, foreign and ARCHIVED-project resources are an
 * indistinguishable 404.
 *
 * Writes follow LOCK-01-L1 (T1): A accounts (lockAccountsPrefix, actor SHARE)
 * -> C company SHARE -> E employees (sorted, NO KEY UPDATE) -> P project SHARE
 * -> M monthly assignments (sorted, SHARE) -> L plan SHARE -> D/A2 inserts ->
 * Z audit. Every check after a lock is a NEW statement (READ COMMITTED sees
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

@Injectable()
export class MonthlyPlansService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
    private readonly availability: AvailabilityService,
  ) {}

  /** T6: the application does not start if the resolver misses an approved D6 golden. */
  onModuleInit(): void {
    assertDutyTimeResolverReady();
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
    const from = `monthly_plans AS mp
      JOIN projects AS p ON p.company_id = mp.company_id AND p.id = mp.project_id
      WHERE ${where.join(' AND ')}`;

    return this.database.withTransaction(async (client) => {
      // Count and page from ONE snapshot, so totals match the returned page.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
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
    return this.database.withTransaction(async (client) =>
      toMonthlyPlanResponse(await this.visiblePlan(client, tenant, planId)));
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
      const existing = await client.query(
        'SELECT 1 FROM monthly_plans WHERE company_id = $1 AND project_id = $2 AND planning_month = $3::date',
        [tenant.companyId, dto.projectId, dto.monthStart],
      );
      if (existing.rowCount !== 0) conflict('MONTHLY_PLAN_ALREADY_EXISTS');

      let row: MonthlyPlanRow;
      try {
        row = (await client.query<MonthlyPlanRow>(
          `INSERT INTO monthly_plans AS mp (company_id, project_id, planning_month)
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
      const plan = await this.visiblePlan(client, tenant, planId);
      const params: unknown[] = [tenant.companyId, plan.id];
      let kindFilter = '';
      if (query.shiftKind !== undefined) {
        params.push(shiftKindToDb(query.shiftKind));
        kindFilter = `AND d.shift_kind = $${params.length}`;
      }
      const duties = await client.query<DutyRow>(
        `SELECT ${dutyColumns('d')} FROM duties AS d
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
   * One duty with its initial members (empty allowed; no staffing minimum),
   * atomically with DUTY_CREATED and one DUTY_MEMBERSHIP_ADDED per member.
   *
   * Precedence (T5): DTO 400 -> 400 INVALID_DATE -> [transaction] 401/403 actor
   * -> 500 unusable planning schema -> 404 plan (unknown, foreign, ARCHIVED
   * project) -> 400 DUTY_DATE_OUTSIDE_PLAN_MONTH (structural, before any 409) ->
   * 404 submitted employee -> locks -> 409 PROJECT_INACTIVE -> 409
   * DUTY_ALREADY_EXISTS -> 409 SHIFT_CONFIGURATION_MISSING -> D6 resolution ->
   * 409 DUTY_TIME_RANGE_INVALID -> staffing per employee in id order: 409
   * EMPLOYEE_INACTIVE -> EMPLOYEE_NOT_EMPLOYED_FOR_DAY ->
   * EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH -> EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT ->
   * EMPLOYEE_UNAVAILABLE -> DUTY_ASSIGNMENT_CONFLICT -> writes + audit.
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
        'SELECT 1 FROM monthly_plans WHERE company_id = $1 AND id = $2 FOR SHARE',
        [tenant.companyId, plan.id],
      ));

      if (project.status !== 'ACTIVE') conflict('PROJECT_INACTIVE');
      const slot = await client.query(
        `SELECT 1 FROM duties
         WHERE company_id = $1 AND monthly_plan_id = $2 AND duty_date = $3::date AND shift_kind = $4
           AND removed_at IS NULL`,
        [tenant.companyId, plan.id, dto.dutyDate, kind],
      );
      if (slot.rowCount !== 0) conflict('DUTY_ALREADY_EXISTS');

      // The WHOLE latest version <= plan month; a kind missing from it is not inherited.
      const rule = await client.query<{ effective_from_month: string; start_local: string; end_local: string }>(
        `SELECT to_char(sc.effective_from_month, 'YYYY-MM-DD') AS effective_from_month,
                left(sc.start_local::text, 5) AS start_local, left(sc.end_local::text, 5) AS end_local
         FROM shift_configurations AS sc
         WHERE sc.company_id = $1 AND sc.project_id = $2 AND sc.shift_kind = $4
           AND sc.effective_from_month = (
             SELECT max(v.effective_from_month) FROM shift_configurations AS v
             WHERE v.company_id = $1 AND v.project_id = $2 AND v.effective_from_month <= $3::date)`,
        [tenant.companyId, plan.project_id, plan.month_start, kind],
      );
      if (rule.rowCount !== 1) conflict('SHIFT_CONFIGURATION_MISSING');
      const configuration = rule.rows[0];

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
          `INSERT INTO duties AS d (
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
        `INSERT INTO plan_assignments AS pa (company_id, duty_id, employee_id, duty_function)
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

  /**
   * Staffing rules per employee in ascending id order; the first violation
   * rejects the whole command. Employment uses the inclusive local duty date
   * (missing start = no evidence). Absence and overlap are fresh set-based
   * reads under the employee locks (absence writers and other staffing writers
   * hold conflicting employee locks). Overlap is half-open on UTC instants
   * across all live duties of either plan state; adjacency is allowed.
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
  ): Promise<void> {
    if (employees.length === 0) return;
    const ids = employees.map((employee) => employee.id);
    const absent = new Set(
      (await this.availability.listUnavailableDays(client, tenant, ids, dutyDate, dutyDate)).map((fact) => fact.employeeId),
    );
    const overlapping = new Set((await client.query<{ employee_id: string }>(
      `SELECT DISTINCT pa.employee_id
       FROM plan_assignments AS pa
       JOIN duties AS d ON d.company_id = pa.company_id AND d.id = pa.duty_id
       WHERE pa.company_id = $1 AND pa.employee_id = ANY($2::uuid[]) AND pa.state = 'ACTIVE'
         AND d.removed_at IS NULL
         AND d.starts_at < $4::timestamptz AND d.ends_at > $3::timestamptz`,
      [tenant.companyId, ids, interval.startsAt, interval.endsAt],
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
      if (overlapping.has(employee.id)) conflict('DUTY_ASSIGNMENT_CONFLICT');
    }
  }

  /** Tenant plan whose project is visible (ACTIVE/INACTIVE); otherwise 404. */
  private async visiblePlan(client: Queryable, tenant: TenantContext, planId: string): Promise<MonthlyPlanRow> {
    return requireRow(await client.query<MonthlyPlanRow>(
      `SELECT ${monthlyPlanColumns('mp')}
       FROM monthly_plans AS mp
       JOIN projects AS p ON p.company_id = mp.company_id AND p.id = mp.project_id
       WHERE mp.company_id = $1 AND mp.id = $2 AND p.status IN ('ACTIVE', 'INACTIVE')`,
      [tenant.companyId, planId],
    ));
  }

  private async activeMembers(client: Queryable, tenant: TenantContext, dutyIds: readonly string[]): Promise<MembershipRow[]> {
    if (dutyIds.length === 0) return [];
    return (await client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM plan_assignments AS pa
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
