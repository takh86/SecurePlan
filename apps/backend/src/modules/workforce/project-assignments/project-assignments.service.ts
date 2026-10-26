/**
 * SP-09 Workforce & Projects: month-scoped employee -> project assignment
 * (COMPANY_ADMIN only). Create/read slice; the correction PATCH
 * (Phase 8.4 D-8.4-13/14) is not implemented yet.
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
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service.js';
import { assertActorInTransaction } from '../../../auth/authorization/actor-in-transaction.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { uniqueViolationConstraint } from '../../../common/database/unique-violation.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import type { CreateProjectAssignmentDto, ListProjectAssignmentsQueryDto } from './dto/project-assignment.dto.js';
import {
  PROJECT_ASSIGNMENT_COLUMNS,
  isMonthStart,
  toProjectAssignmentResponse,
  type ProjectAssignmentRow,
} from './project-assignment.mapper.js';
import type { ProjectAssignmentPage, ProjectAssignmentResponse } from './project-assignment.types.js';

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
  ) {}

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
                to_char(pa.planning_month, 'YYYY-MM-DD') AS month_start
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
   * 409 PROJECT_INACTIVE -> 409 existing assignment for that month.
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
        await client.query<{ status: string }>(
          `SELECT status FROM employees
           WHERE company_id = $1 AND id = $2
           FOR NO KEY UPDATE`,
          [tenant.companyId, dto.employeeId],
        ),
      );
      const project = requireRow(
        await client.query<{ status: string }>(
          `SELECT status FROM projects
           WHERE company_id = $1 AND id = $2
           FOR SHARE`,
          [tenant.companyId, dto.projectId],
        ),
      );
      if (employee.status !== 'ACTIVE') throw new ConflictException({ code: 'EMPLOYEE_INACTIVE' });
      // INACTIVE and the API-unreachable ARCHIVED both block new assignments.
      if (project.status !== 'ACTIVE') throw new ConflictException({ code: 'PROJECT_INACTIVE' });

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
}
