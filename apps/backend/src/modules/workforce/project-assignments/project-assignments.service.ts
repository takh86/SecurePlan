/**
 * SP-09 Workforce & Projects: month-scoped employee -> project assignment
 * (COMPANY_ADMIN only): create, read, the correction PATCH
 * (Phase 8.4 D-8.4-13/14; owner decisions D1-D5 of 26.10.2026) and the
 * removal of FUTURE assignments (#73, PO decisions D73-1..8, TL sign-off R2).
 *
 * Version (#73 S-2 R2): every response carries `version`, the row's
 * `updated_at` in epoch microseconds. Every effective UPDATE applies
 * PROJECT_ASSIGNMENT_TOUCH and a genuine no-op writes nothing, so the version
 * strictly increases with each committed change (no ABA, no collision).
 *
 * Tenant rules (SP-06), as in EmployeesService:
 * - companyId/accountId/role come ONLY from the trusted TenantContext;
 *   employeeId/projectId from the body are only looked up INSIDE that company;
 * - an unknown or foreign employee/project is indistinguishable (404);
 * - every write re-asserts the acting account under row locks first.
 *
 * Integrity: the database (UNIQUE company/employee/month + month-start CHECK +
 * composite FKs) is the authority; the checks below give precise error codes.
 * Lock order: actor account/company (SHARE) -> employee (NO KEY UPDATE) ->
 * project (SHARE). The employee lock serializes assignment writes for the same
 * person and concurrent deactivation; the project lock serializes against a
 * concurrent switch to INACTIVE.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service.js';
import { assertActorInTransaction } from '../../../auth/authorization/actor-in-transaction.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { uniqueViolationConstraint } from '../../../common/database/unique-violation.js';
import { WALL_CLOCK, type WallClock } from '../../../common/time/wall-clock.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import type {
  CreateProjectAssignmentDto,
  ListFutureProjectAssignmentsQueryDto,
  ListProjectAssignmentsQueryDto,
  UpdateProjectAssignmentDto,
} from './dto/project-assignment.dto.js';
import { assertPlanningDependencyCheckImplemented } from './planning-dependency-guard.js';
import {
  PROJECT_ASSIGNMENT_COLUMNS,
  PROJECT_ASSIGNMENT_TOUCH,
  assignmentVersionSql,
  isMonthStart,
  toAssignmentVersion,
  toProjectAssignmentResponse,
  toFutureProjectAssignmentResponse,
  type FutureProjectAssignmentRow,
  type ProjectAssignmentRow,
} from './project-assignment.mapper.js';
import type { FutureProjectAssignmentPage, ProjectAssignmentPage, ProjectAssignmentResponse } from './project-assignment.types.js';

const ADMIN_ONLY = ['COMPANY_ADMIN'] as const;
const DEFAULT_PAGE_SIZE = 25;
const EMPLOYEE_MONTH_CONSTRAINT = 'uq_project_assignments__employee_month';

function assertMonthStart(monthStart: string): void {
  if (!isMonthStart(monthStart)) throw new BadRequestException({ code: 'INVALID_MONTH_START' });
}

@Injectable()
export class ProjectAssignmentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
    @Inject(WALL_CLOCK) private readonly clock: WallClock,
  ) {}

  /**
   * S-9 / D73-7: one employee's future monthly links, including deactivated
   * employees and invisible project references. No write locks or business
   * audit. Parent, zone, count and labels belong to one read-only snapshot;
   * separate HTTP pages deliberately get fresh snapshots.
   */
  async listFutureForEmployee(
    tenant: TenantContext,
    employeeId: string,
    query: ListFutureProjectAssignmentsQueryDto,
  ): Promise<FutureProjectAssignmentPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      requireRow(await client.query(
        'SELECT 1 FROM employees WHERE company_id = $1 AND id = $2',
        [tenant.companyId, employeeId],
      ));
      // AT TIME ZONE also accepts POSIX strings (e.g. Invalid/S9). Discovery
      // requires a named IANA zone, not a guessed numeric offset. Keep the
      // existing write helper/contracts unchanged.
      const companyMonth = requireRow(await client.query<{ current_month: string | null }>(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS tz WHERE tz.name = c.time_zone)
                     THEN to_char(date_trunc('month', $2::timestamptz AT TIME ZONE c.time_zone), 'YYYY-MM-DD')
                     ELSE NULL END AS current_month
         FROM companies AS c WHERE c.id = $1`,
        [tenant.companyId, this.clock().toISOString()],
      ));
      if (companyMonth.current_month === null) throw new Error('Invalid company IANA time zone');
      const currentMonth = companyMonth.current_month;
      const params = [tenant.companyId, employeeId, currentMonth];
      const filter = 'pa.company_id = $1 AND pa.employee_id = $2 AND pa.planning_month > $3::date';
      const counted = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM project_assignments AS pa WHERE ${filter}`,
        params,
      );
      const rows = await client.query<FutureProjectAssignmentRow>(
        `SELECT pa.id, pa.employee_id, pa.project_id,
                to_char(pa.planning_month, 'YYYY-MM-DD') AS month_start,
                ${assignmentVersionSql('pa.updated_at')} AS version,
                p.name AS project_name, p.status AS project_status
         FROM project_assignments AS pa
         LEFT JOIN projects AS p ON p.company_id = pa.company_id AND p.id = pa.project_id
                                  AND p.status IN ('ACTIVE', 'INACTIVE')
         WHERE ${filter}
         ORDER BY pa.planning_month ASC, pa.id ASC
         LIMIT $4 OFFSET $5`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const totalItems = counted.rows[0].total;
      return {
        items: rows.rows.map(toFutureProjectAssignmentResponse),
        pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
      };
    });
  }

  async list(tenant: TenantContext, query: ListProjectAssignmentsQueryDto): Promise<ProjectAssignmentPage> {
    assertMonthStart(query.monthStart);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const params: unknown[] = [tenant.companyId, query.monthStart];
    const where = ['pa.company_id = $1', 'pa.planning_month = $2::date'];
    // Optional narrowing filters; they never broaden the tenant scope.
    if (query.projectId !== undefined) {
      params.push(query.projectId);
      where.push(`pa.project_id = $${params.length}`);
    }
    if (query.employeeId !== undefined) {
      params.push(query.employeeId);
      where.push(`pa.employee_id = $${params.length}`);
    }
    const from = `project_assignments AS pa
      JOIN employees AS e ON e.company_id = pa.company_id AND e.id = pa.employee_id
      WHERE ${where.join(' AND ')}`;

    return this.database.withTransaction(async (client) => {
      // Count and page from ONE snapshot, so totals match the returned page.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const counted = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${from}`, params);
      const rows = await client.query<ProjectAssignmentRow>(
        `SELECT pa.id, pa.employee_id, pa.project_id,
                to_char(pa.planning_month, 'YYYY-MM-DD') AS month_start,
                ${assignmentVersionSql('pa.updated_at')} AS version
         FROM ${from}
         ORDER BY e.employee_number ASC, pa.id ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const totalItems = counted.rows[0].total;
      return {
        items: rows.rows.map(toProjectAssignmentResponse),
        pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
      };
    });
  }

  /**
   * Error precedence: 404 employee -> 404 project -> 409 EMPLOYEE_INACTIVE ->
   * 409 PROJECT_INACTIVE -> 409 EMPLOYEE_NOT_EMPLOYED_FOR_MONTH (owner decision
   * F-1: documented employment must overlap the target month on at least one day,
   * for past, current and future months; missing start = no evidence) ->
   * 409 existing assignment for that month.
   */
  async create(
    tenant: TenantContext,
    dto: CreateProjectAssignmentDto,
    correlationId: string,
  ): Promise<ProjectAssignmentResponse> {
    assertMonthStart(dto.monthStart);

    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      const employee = requireRow(
        await client.query<{ status: string; employment_start: string | null; employment_end: string | null }>(
          `SELECT status,
                  to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
                  to_char(employment_end, 'YYYY-MM-DD') AS employment_end
           FROM employees
           WHERE company_id = $1 AND id = $2
           FOR NO KEY UPDATE`,
          [tenant.companyId, dto.employeeId],
        ),
      );
      const project = requireRow(
        await client.query<{ status: string }>(
          `SELECT status FROM projects
           WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE')
           FOR SHARE`,
          [tenant.companyId, dto.projectId],
        ),
      );
      if (employee.status !== 'ACTIVE') throw new ConflictException({ code: 'EMPLOYEE_INACTIVE' });
      // ARCHIVED projects are invisible (404 above, ADR-0002 addendum); INACTIVE blocks.
      if (project.status !== 'ACTIVE') throw new ConflictException({ code: 'PROJECT_INACTIVE' });
      if (!employmentCovers(employee, dto.monthStart)) {
        throw new ConflictException({ code: 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH' });
      }

      // Compared as uuid in SQL: the DTO accepts any letter case for ids.
      const existing = await client.query<{ same_project: boolean }>(
        `SELECT project_id = $4::uuid AS same_project FROM project_assignments
         WHERE company_id = $1 AND employee_id = $2 AND planning_month = $3::date`,
        [tenant.companyId, dto.employeeId, dto.monthStart, dto.projectId],
      );
      if (existing.rowCount !== 0) {
        throw new ConflictException({
          code: existing.rows[0].same_project ? 'PROJECT_ASSIGNMENT_ALREADY_EXISTS' : 'PROJECT_ASSIGNMENT_CONFLICT',
        });
      }

      let row: ProjectAssignmentRow;
      try {
        const inserted = await client.query<ProjectAssignmentRow>(
          `INSERT INTO project_assignments (company_id, employee_id, project_id, planning_month)
           VALUES ($1, $2, $3, $4::date)
           RETURNING ${PROJECT_ASSIGNMENT_COLUMNS}`,
          [tenant.companyId, dto.employeeId, dto.projectId, dto.monthStart],
        );
        row = inserted.rows[0];
      } catch (error) {
        // Phase 8.5 §7: a recognized employee/month uniqueness race is a conflict.
        if (uniqueViolationConstraint(error) === EMPLOYEE_MONTH_CONSTRAINT) {
          throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CONFLICT' });
        }
        throw error;
      }

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'PROJECT_ASSIGNMENT_CREATED',
        resourceType: 'PROJECT_ASSIGNMENT',
        resourceId: row.id,
        newValues: { employeeId: row.employee_id, projectId: row.project_id, monthStart: row.month_start },
        correlationId,
      });
      return toProjectAssignmentResponse(row);
    });
  }

  /**
   * Correction of an existing assignment (Phase 8.4 5.3). Rules:
   * - the complete resulting employee/project/month tuple is validated again;
   * - FUTURE correction (old and new month after the company's current month):
   *   the resulting employee and project must be ACTIVE, and the resulting
   *   employee needs the same employment evidence for the resulting month as
   *   POST (#64 case 1, owner decision 1a of 28.10.2026), whichever field changed;
   * - HISTORICAL correction (old or new month is the current or a past month,
   *   in the company's IANA time zone): an already referenced inactive employee
   *   or project may stay, but a NEWLY referenced one must be ACTIVE, and a newly
   *   referenced employee needs documented employment covering that month
   *   (missing evidence is never treated as valid);
   * - HISTORICAL correction into a FUTURE target month (owner decision B of
   *   28.10.2026): the resulting employee needs employment evidence for the
   *   target month even if unchanged (POST's code); an employee change keeps
   *   the historical code. Since the #64 future-target status guard (owner
   *   decision of 28.10.2026) the resulting employee and project must also be
   *   ACTIVE, even if unchanged, as in a FUTURE correction; the scope stays
   *   HISTORICAL;
   * - ARCHIVED project (F-3): newly referenced it is 404 before the row lock;
   *   unchanged with a future target month it is PROJECT_INACTIVE, as for a
   *   FUTURE correction; unchanged within history it may stay;
   * - error precedence after the no-op check: EMPLOYEE_INACTIVE ->
   *   PROJECT_INACTIVE -> missing employment evidence -> planning guard ->
   *   target month taken;
   * - planning data: see assertPlanningDependencyCheckImplemented (fail closed);
   * - lock order (deterministic, independent of the change direction): actor ->
   *   employees by id -> projects by id -> assignment row; the row is re-read
   *   under its lock and a concurrent change is a 409, never a blind retry.
   * No-op corrections answer 200 without a write or audit entry, with the
   * LOCKED row, so the version is current even after a concurrent A->B->A (#73).
   */
  async correct(
    tenant: TenantContext,
    assignmentId: string,
    dto: UpdateProjectAssignmentDto,
    correlationId: string,
  ): Promise<ProjectAssignmentResponse> {
    if (dto.employeeId === undefined && dto.projectId === undefined && dto.monthStart === undefined) {
      throw new BadRequestException({ code: 'EMPTY_PATCH' });
    }
    if (dto.monthStart !== undefined) assertMonthStart(dto.monthStart);

    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      const current = requireRow(
        await client.query<ProjectAssignmentRow>(
          `SELECT ${PROJECT_ASSIGNMENT_COLUMNS} FROM project_assignments
           WHERE company_id = $1 AND id = $2`,
          [tenant.companyId, assignmentId],
        ),
      );
      const next = {
        employeeId: dto.employeeId?.toLowerCase() ?? current.employee_id,
        projectId: dto.projectId?.toLowerCase() ?? current.project_id,
        monthStart: dto.monthStart ?? current.month_start,
      };
      const employeeChanged = next.employeeId !== current.employee_id;
      const projectChanged = next.projectId !== current.project_id;
      const monthChanged = next.monthStart !== current.month_start;

      // Locks in ascending id order, whatever the direction of the change.
      const employees = await client.query<{
        id: string;
        status: string;
        employment_start: string | null;
        employment_end: string | null;
      }>(
        `SELECT id, status,
                to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
                to_char(employment_end, 'YYYY-MM-DD') AS employment_end
         FROM employees
         WHERE company_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id
         FOR NO KEY UPDATE`,
        [tenant.companyId, [...new Set([current.employee_id, next.employeeId])]],
      );
      const projects = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM projects
         WHERE company_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id
         FOR SHARE`,
        [tenant.companyId, [...new Set([current.project_id, next.projectId])]],
      );
      const nextEmployee = employees.rows.find((row) => row.id === next.employeeId);
      const nextProject = projects.rows.find((row) => row.id === next.projectId);
      // Unknown, foreign and (for a newly referenced project) archived: all 404.
      if (!nextEmployee) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      if (!nextProject || (projectChanged && !['ACTIVE', 'INACTIVE'].includes(nextProject.status))) {
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      }

      // The row is changed only if it still is what the lock-free read saw.
      const locked = requireRow(
        await client.query<ProjectAssignmentRow>(
          `SELECT ${PROJECT_ASSIGNMENT_COLUMNS} FROM project_assignments
           WHERE company_id = $1 AND id = $2
           FOR UPDATE`,
          [tenant.companyId, assignmentId],
        ),
      );
      if (
        locked.employee_id !== current.employee_id ||
        locked.project_id !== current.project_id ||
        locked.month_start !== current.month_start
      ) {
        throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CONFLICT' });
      }
      if (!employeeChanged && !projectChanged && !monthChanged) return toProjectAssignmentResponse(locked);

      const zone = await this.currentMonth(client, tenant.companyId);
      const historical = current.month_start <= zone || next.monthStart <= zone;
      const scope = historical ? 'HISTORICAL' : 'FUTURE';

      // Status and employment dates come from the rows locked above, so concurrent changes are serialized.
      const statusConflict = correctionStatusConflict(
        employeeChanged, projectChanged, nextEmployee, nextProject, next.monthStart, zone,
      );
      if (statusConflict !== null) throw new ConflictException({ code: statusConflict });
      const employmentConflict = correctionEmploymentConflict(scope, employeeChanged, nextEmployee, next.monthStart, zone);
      if (employmentConflict !== null) throw new ConflictException({ code: employmentConflict });

      await assertPlanningDependencyCheckImplemented(client);

      const target = await client.query<{ same_project: boolean }>(
        `SELECT project_id = $4::uuid AS same_project FROM project_assignments
         WHERE company_id = $1 AND employee_id = $2 AND planning_month = $3::date AND id <> $5`,
        [tenant.companyId, next.employeeId, next.monthStart, next.projectId, assignmentId],
      );
      if (target.rowCount !== 0) {
        throw new ConflictException({
          code: target.rows[0].same_project ? 'PROJECT_ASSIGNMENT_ALREADY_EXISTS' : 'PROJECT_ASSIGNMENT_CONFLICT',
        });
      }

      let updated: ProjectAssignmentRow;
      try {
        updated = requireRow(
          await client.query<ProjectAssignmentRow>(
            `UPDATE project_assignments
             SET employee_id = $3, project_id = $4, planning_month = $5::date, ${PROJECT_ASSIGNMENT_TOUCH}
             WHERE company_id = $1 AND id = $2
             RETURNING ${PROJECT_ASSIGNMENT_COLUMNS}`,
            [tenant.companyId, assignmentId, next.employeeId, next.projectId, next.monthStart],
          ),
        );
      } catch (error) {
        if (uniqueViolationConstraint(error) === EMPLOYEE_MONTH_CONSTRAINT) {
          throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CONFLICT' });
        }
        throw error;
      }

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = { scope };
      if (employeeChanged) {
        oldValues.employeeId = current.employee_id;
        newValues.employeeId = updated.employee_id;
      }
      if (projectChanged) {
        oldValues.projectId = current.project_id;
        newValues.projectId = updated.project_id;
      }
      if (monthChanged) {
        oldValues.monthStart = current.month_start;
        newValues.monthStart = updated.month_start;
      }
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'PROJECT_ASSIGNMENT_CORRECTED',
        resourceType: 'PROJECT_ASSIGNMENT',
        resourceId: assignmentId,
        oldValues,
        newValues,
        correlationId,
      });
      return toProjectAssignmentResponse(updated);
    });
  }

  /**
   * #73: physical removal of ONE assignment of a month after the company's
   * current month (D73-1), with one PROJECT_ASSIGNMENT_REMOVED audit event in
   * the same transaction. The caller must present the version it confirmed
   * (R1); the controller has already parsed it. Precedence after the actor
   * recheck: 404 unknown/foreign/already removed -> locks (employee NO KEY
   * UPDATE -> project SHARE -> row FOR UPDATE, as in correct()) -> 404 vanished
   * / 409 PROJECT_ASSIGNMENT_CONFLICT tuple changed -> 409
   * PROJECT_ASSIGNMENT_CONFLICT stale version -> 409
   * PROJECT_ASSIGNMENT_CORRECTION_CONFLICT current or past month (D73-2) -> 409
   * planning guard (E-10, unchanged) -> DELETE + audit.
   * Employee and project status and employment are deliberately NOT checked
   * (PO): an unwanted future link of a deactivated person must be removable.
   * Nothing cascades: no vacancy, no replacement, no employment-date change.
   */
  async remove(
    tenant: TenantContext,
    assignmentId: string,
    expectedVersion: number,
    correlationId: string,
  ): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      const current = requireRow(
        await client.query<ProjectAssignmentRow>(
          `SELECT ${PROJECT_ASSIGNMENT_COLUMNS} FROM project_assignments
           WHERE company_id = $1 AND id = $2`,
          [tenant.companyId, assignmentId],
        ),
      );

      // The employee lock is what case 2 and every other assignment writer rely on;
      // deleting a referencing row alone would not lock the parent.
      const employeeLock = await client.query(
        `SELECT 1 FROM employees WHERE company_id = $1 AND id = $2 FOR NO KEY UPDATE`,
        [tenant.companyId, current.employee_id],
      );
      const projectLock = await client.query(
        `SELECT 1 FROM projects WHERE company_id = $1 AND id = $2 FOR SHARE`,
        [tenant.companyId, current.project_id],
      );
      // The composite FKs guarantee both rows; a miss would mean the lock protocol did not hold.
      if (employeeLock.rowCount !== 1 || projectLock.rowCount !== 1) {
        throw new Error('remove: referenced employee or project row is missing');
      }

      // Gone in between (a concurrent removal) -> 404; changed in between -> 409.
      const locked = requireRow(
        await client.query<ProjectAssignmentRow>(
          `SELECT ${PROJECT_ASSIGNMENT_COLUMNS} FROM project_assignments
           WHERE company_id = $1 AND id = $2
           FOR UPDATE`,
          [tenant.companyId, assignmentId],
        ),
      );
      if (
        locked.employee_id !== current.employee_id ||
        locked.project_id !== current.project_id ||
        locked.month_start !== current.month_start
      ) {
        throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CONFLICT' });
      }
      // R1: the admin confirmed exactly this state; any later change (A->B->A included) moved the version.
      if (toAssignmentVersion(locked.version) !== expectedVersion) {
        throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CONFLICT' });
      }

      // Month starts as YYYY-MM-DD strings compare chronologically.
      if (locked.month_start <= (await this.currentMonth(client, tenant.companyId))) {
        throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' });
      }

      await assertPlanningDependencyCheckImplemented(client);

      const deleted = await client.query(
        'DELETE FROM project_assignments WHERE company_id = $1 AND id = $2',
        [tenant.companyId, assignmentId],
      );
      // The row is locked by this transaction: anything but one row is a defect.
      if (deleted.rowCount !== 1) throw new Error('remove: locked assignment row was not deleted exactly once');

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'PROJECT_ASSIGNMENT_REMOVED',
        resourceType: 'PROJECT_ASSIGNMENT',
        resourceId: assignmentId,
        // The complete removed tuple: the row itself no longer exists afterwards.
        oldValues: { employeeId: locked.employee_id, projectId: locked.project_id, monthStart: locked.month_start },
        newValues: null,
        correlationId,
      });
    });
  }

  /**
   * The company's current month (YYYY-MM-01) in its IANA time zone (D3), from
   * one wall-clock read. The actor check holds the company row FOR SHARE, so
   * the time zone stays stable for the rest of the transaction.
   */
  private async currentMonth(client: Pick<PoolClient, 'query'>, companyId: string): Promise<string> {
    return requireRow(
      await client.query<{ current_month: string }>(
        `SELECT to_char(date_trunc('month', $2::timestamptz AT TIME ZONE time_zone), 'YYYY-MM-DD') AS current_month
         FROM companies WHERE id = $1`,
        [companyId, this.clock().toISOString()],
      ),
    ).current_month;
  }
}

/**
 * Documented employment that overlaps the month. A missing
 * employment start counts as "no evidence" (not as valid).
 */
export function employmentCovers(
  employee: { employment_start: string | null; employment_end: string | null },
  monthStart: string,
): boolean {
  if (employee.employment_start === null) return false;
  const [year, month] = monthStart.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${monthStart.slice(0, 8)}${String(lastDay).padStart(2, '0')}`;
  // YYYY-MM-DD strings compare chronologically.
  return employee.employment_start <= monthEnd && (employee.employment_end === null || employee.employment_end >= monthStart);
}

/**
 * The 409 code for a correction whose resulting employee or project is not
 * ACTIVE where it has to be, or null (employee first, as for POST):
 * - target month after `currentMonth` (#64 future-target status guard, owner
 *   decision of 28.10.2026): both must be ACTIVE whichever field changed, for
 *   FUTURE corrections (D1, unchanged) and for HISTORICAL corrections into a
 *   future month alike; an unchanged ARCHIVED project is PROJECT_INACTIVE;
 * - target month within history (D2, unchanged): only a NEWLY referenced
 *   employee or project must be ACTIVE.
 * A newly referenced ARCHIVED project never gets here: correct() answers 404 (F-3).
 */
export function correctionStatusConflict(
  employeeChanged: boolean,
  projectChanged: boolean,
  employee: { status: string },
  project: { status: string },
  monthStart: string,
  currentMonth: string,
): 'EMPLOYEE_INACTIVE' | 'PROJECT_INACTIVE' | null {
  // Month starts as YYYY-MM-DD strings compare chronologically.
  const intoFuture = monthStart > currentMonth;
  if ((intoFuture || employeeChanged) && employee.status !== 'ACTIVE') return 'EMPLOYEE_INACTIVE';
  if ((intoFuture || projectChanged) && project.status !== 'ACTIVE') return 'PROJECT_INACTIVE';
  return null;
}

/**
 * The 409 code for a correction whose resulting employee lacks employment
 * evidence for the resulting month, or null when no evidence check applies:
 * - FUTURE (#64 case 1, owner decision 1a): always, with POST's code, even if
 *   only the project or only the month changes;
 * - HISTORICAL into a month after `currentMonth` (owner decision B): also for
 *   an unchanged employee, with POST's code;
 * - HISTORICAL otherwise (D2, unchanged): only for a newly referenced employee.
 * A newly referenced employee in HISTORICAL scope keeps the D2 code, whatever
 * the target month.
 */
export function correctionEmploymentConflict(
  scope: 'FUTURE' | 'HISTORICAL',
  employeeChanged: boolean,
  employee: { employment_start: string | null; employment_end: string | null },
  monthStart: string,
  currentMonth: string,
): 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH' | 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT' | null {
  // Month starts as YYYY-MM-DD strings compare chronologically.
  const intoFuture = monthStart > currentMonth;
  if (scope === 'HISTORICAL' && !employeeChanged && !intoFuture) return null;
  if (employmentCovers(employee, monthStart)) return null;
  return scope === 'HISTORICAL' && employeeChanged
    ? 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'
    : 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH';
}
