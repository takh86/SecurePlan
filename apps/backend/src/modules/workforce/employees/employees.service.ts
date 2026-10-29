/**
 * SP-07 Workforce: administrative employee management (COMPANY_ADMIN only).
 *
 * Tenant rules (SP-06):
 * - companyId/accountId/role come ONLY from the trusted TenantContext;
 * - every statement on `employees` is scoped by `company_id = tenant.companyId`,
 *   including writes after a scoped lookup;
 * - unknown and foreign IDs are indistinguishable (404 via requireRow);
 * - every write re-asserts the acting account under row locks first
 *   (assertActorInTransaction). A session revoked AFTER the request-entry
 *   check is not re-detected inside the write (accepted baseline; open SP-06
 *   decision).
 *
 * Identity data (accounts, tokens, sessions) is changed only through
 * AccountLifecycleService; audit only through BusinessAuditService.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service.js';
import { assertActorInTransaction } from '../../../auth/authorization/actor-in-transaction.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { uniqueViolationConstraint } from '../../../common/database/unique-violation.js';
import { WALL_CLOCK, type WallClock } from '../../../common/time/wall-clock.js';
import { checkEmploymentPeriodImpact, type EmploymentPeriodImpact } from './employment-period-impact.js';
import {
  AccountLifecycleService,
  type PendingActivation,
} from '../../identity/account-lifecycle.service.js';
import { ACTIVATION_DELIVERY, type ActivationDelivery } from '../../identity/activation-delivery.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import type { CreateEmployeeDto, ListEmployeesQueryDto, UpdateEmployeeDto } from './dto/employee.dto.js';
import {
  EMPLOYEE_COLUMNS,
  SORT_COLUMNS,
  eligibilityFromDb,
  eligibilityToDb,
  statusToDb,
  toEmployeeResponse,
  type EmployeeRow,
} from './employee.mapper.js';
import type { EmployeePage, EmployeeResponse } from './employee.types.js';

const ADMIN_ONLY = ['COMPANY_ADMIN'] as const;
const DEFAULT_PAGE_SIZE = 25;
const EMPLOYEE_CODE_CONSTRAINT = 'uq_employees__company_employee_number';

function codeTaken(): never {
  throw new ConflictException({ code: 'EMPLOYEE_CODE_ALREADY_EXISTS' });
}

/** Escapes LIKE metacharacters so `q` is matched literally (ESCAPE '\'). */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

type EmployeeChanges = {
  employee_number: string;
  first_name: string;
  last_name: string;
  employment_start: string | null;
  employment_end: string | null;
  shift_eligibility: string;
};

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly accounts: AccountLifecycleService,
    private readonly audit: BusinessAuditService,
    @Inject(ACTIVATION_DELIVERY) private readonly delivery: ActivationDelivery,
    @Inject(WALL_CLOCK) private readonly clock: WallClock,
  ) {}

  async list(tenant: TenantContext, query: ListEmployeesQueryDto): Promise<EmployeePage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const params: unknown[] = [tenant.companyId];
    const where = ['company_id = $1'];
    if (query.status !== undefined) {
      params.push(statusToDb(query.status));
      where.push(`status = $${params.length}`);
    }
    if (query.shiftEligibility !== undefined) {
      params.push(eligibilityToDb(query.shiftEligibility));
      where.push(`shift_eligibility = $${params.length}`);
    }
    if (query.q !== undefined) {
      params.push(likeContains(query.q));
      const p = `$${params.length}`;
      where.push(
        `(employee_number ILIKE ${p} ESCAPE '\\' OR first_name ILIKE ${p} ESCAPE '\\' OR last_name ILIKE ${p} ESCAPE '\\')`,
      );
    }
    const direction = query.sortOrder === 'desc' ? 'DESC' : 'ASC';
    const orderBy = [
      ...(query.sortBy !== undefined ? [`${SORT_COLUMNS[query.sortBy]} ${direction}`] : []),
      'last_name ASC',
      'first_name ASC',
      'id ASC',
    ].join(', ');
    const filter = where.join(' AND ');

    return this.database.withTransaction(async (client) => {
      // Count and page from ONE snapshot, so totals match the returned page.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const counted = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM employees WHERE ${filter}`,
        params,
      );
      const rows = await client.query<EmployeeRow>(
        `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE ${filter}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const summaries = await this.accounts.accountSummaries(
        client,
        tenant.companyId,
        rows.rows.map((row) => row.account_id),
      );
      const totalItems = counted.rows[0].total;
      return {
        items: rows.rows.map((row) => toEmployeeResponse(row, summaries.get(row.account_id))),
        pagination: {
          page,
          pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / pageSize),
        },
      };
    });
  }

  async get(tenant: TenantContext, employeeId: string): Promise<EmployeeResponse> {
    return this.database.withTransaction(async (client) => {
      const row = requireRow(
        await client.query<EmployeeRow>(
          `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE company_id = $1 AND id = $2`,
          [tenant.companyId, employeeId],
        ),
      );
      return this.respond(client, tenant, row);
    });
  }

  /**
   * Employee + linked PENDING_ACTIVATION account + token + audit commit
   * atomically. The activation link is delivered only after the commit; a
   * delivery failure never rolls back the employee (see deliverActivation).
   */
  async create(
    tenant: TenantContext,
    dto: CreateEmployeeDto,
    correlationId: string,
  ): Promise<EmployeeResponse> {
    const created = await this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      // Deterministic 409 for the common case; the UNIQUE constraint remains
      // the authority for concurrent creates (mapped below).
      const taken = await client.query(
        'SELECT 1 FROM employees WHERE company_id = $1 AND employee_number = $2',
        [tenant.companyId, dto.employeeCode],
      );
      if (taken.rowCount !== 0) codeTaken();

      const account = await this.accounts.provisionEmployeeAccount(client, tenant.companyId, dto.email);
      let row: EmployeeRow;
      try {
        const inserted = await client.query<EmployeeRow>(
          `INSERT INTO employees (
             company_id, account_id, employee_number, first_name, last_name,
             employment_start, shift_eligibility
           )
           VALUES ($1, $2, $3, $4, $5, $6::date, $7)
           RETURNING ${EMPLOYEE_COLUMNS}`,
          [
            tenant.companyId,
            account.accountId,
            dto.employeeCode,
            dto.firstName,
            dto.lastName,
            dto.employmentStart ?? null,
            eligibilityToDb(dto.shiftEligibility),
          ],
        );
        row = inserted.rows[0];
      } catch (error) {
        if (uniqueViolationConstraint(error) === EMPLOYEE_CODE_CONSTRAINT) codeTaken();
        throw error;
      }

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'EMPLOYEE_CREATED',
        resourceType: 'EMPLOYEE',
        resourceId: row.id,
        newValues: {
          employeeCode: row.employee_number,
          employmentStart: row.employment_start,
          shiftEligibility: eligibilityFromDb(row.shift_eligibility),
          status: 'ACTIVE',
        },
        correlationId,
      });
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'ACCOUNT_PROVISIONED',
        resourceType: 'ACCOUNT',
        resourceId: account.accountId,
        newValues: { role: 'EMPLOYEE', status: 'PENDING_ACTIVATION' },
        correlationId,
      });
      return { row, account };
    });

    await this.deliverActivation(tenant, created.account.accountId, created.account.email, created.account.activation, correlationId);
    return toEmployeeResponse(created.row, { email: created.account.email, status: 'PENDING_ACTIVATION' });
  }

  /** Master-data correction. Status is not patchable; e-mail is not part of the DTO. */
  async update(
    tenant: TenantContext,
    employeeId: string,
    dto: UpdateEmployeeDto,
    correlationId: string,
  ): Promise<EmployeeResponse> {
    const sentFields = Object.entries(dto).filter(([, value]) => value !== undefined);
    if (sentFields.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_PATCH' });
    }

    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      const current = requireRow(
        await client.query<EmployeeRow>(
          `SELECT ${EMPLOYEE_COLUMNS} FROM employees
           WHERE company_id = $1 AND id = $2
           FOR UPDATE`,
          [tenant.companyId, employeeId],
        ),
      );

      const next: EmployeeChanges = {
        employee_number: dto.employeeCode ?? current.employee_number,
        first_name: dto.firstName ?? current.first_name,
        last_name: dto.lastName ?? current.last_name,
        employment_start: dto.employmentStart !== undefined ? dto.employmentStart : current.employment_start,
        employment_end: dto.employmentEnd !== undefined ? dto.employmentEnd : current.employment_end,
        shift_eligibility:
          dto.shiftEligibility !== undefined ? eligibilityToDb(dto.shiftEligibility) : current.shift_eligibility,
      };
      // YYYY-MM-DD strings compare chronologically.
      if (next.employment_start !== null && next.employment_end !== null && next.employment_end < next.employment_start) {
        throw new BadRequestException({ code: 'EMPLOYMENT_DATE_CONFLICT' });
      }

      const changed = (Object.keys(next) as (keyof EmployeeChanges)[]).filter(
        (field) => next[field] !== current[field],
      );
      if (changed.length === 0) return this.respond(client, tenant, current);

      if (changed.includes('employee_number')) {
        const taken = await client.query(
          'SELECT 1 FROM employees WHERE company_id = $1 AND employee_number = $2 AND id <> $3',
          [tenant.companyId, next.employee_number, employeeId],
        );
        if (taken.rowCount !== 0) codeTaken();
      }

      const datesChanged = changed.includes('employment_start') || changed.includes('employment_end');
      const impact = datesChanged
        ? await checkEmploymentPeriodImpact(client, tenant.companyId, employeeId, current, next, this.clock().toISOString())
        : undefined;

      let updated: EmployeeRow;
      try {
        const result = await client.query<EmployeeRow>(
          `UPDATE employees
           SET employee_number = $3, first_name = $4, last_name = $5,
               employment_start = $6::date, employment_end = $7::date,
               shift_eligibility = $8, updated_at = clock_timestamp()
           WHERE company_id = $1 AND id = $2
           RETURNING ${EMPLOYEE_COLUMNS}`,
          [
            tenant.companyId,
            employeeId,
            next.employee_number,
            next.first_name,
            next.last_name,
            next.employment_start,
            next.employment_end,
            next.shift_eligibility,
          ],
        );
        updated = requireRow(result);
      } catch (error) {
        if (uniqueViolationConstraint(error) === EMPLOYEE_CODE_CONSTRAINT) codeTaken();
        throw error;
      }

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'EMPLOYEE_UPDATED',
        resourceType: 'EMPLOYEE',
        resourceId: employeeId,
        ...auditDiff(current, updated, changed, impact),
        correlationId,
      });
      return this.respond(client, tenant, updated);
    });
  }

  /**
   * Deactivates the employee and its account; all sessions and unused tokens
   * are revoked in the same transaction. The employee row is kept (history).
   *
   * EMPLOYEE_HAS_FUTURE_ASSIGNMENTS is not checked: per Phase 8.4 D-8.4-11 it
   * concerns future DUTY assignments, which do not exist before SP-11. Monthly
   * project assignments (SP-09) do not block deactivation; they stay as history.
   */
  async deactivate(
    tenant: TenantContext,
    employeeId: string,
    correlationId: string,
  ): Promise<EmployeeResponse> {
    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      const current = requireRow(
        await client.query<EmployeeRow>(
          `SELECT ${EMPLOYEE_COLUMNS} FROM employees
           WHERE company_id = $1 AND id = $2
           FOR UPDATE`,
          [tenant.companyId, employeeId],
        ),
      );
      if (current.status === 'DEACTIVATED') {
        throw new ConflictException({ code: 'EMPLOYEE_INACTIVE' });
      }

      const updated = requireRow(
        await client.query<EmployeeRow>(
          `UPDATE employees
           SET status = 'DEACTIVATED', deactivated_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE company_id = $1 AND id = $2 AND status = 'ACTIVE'
           RETURNING ${EMPLOYEE_COLUMNS}`,
          [tenant.companyId, employeeId],
        ),
      );
      const account = await this.accounts.deactivateAccount(client, tenant.companyId, current.account_id);

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'EMPLOYEE_DEACTIVATED',
        resourceType: 'EMPLOYEE',
        resourceId: employeeId,
        oldValues: { status: 'ACTIVE' },
        newValues: { status: 'INACTIVE' },
        correlationId,
      });
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'ACCOUNT_DEACTIVATED',
        resourceType: 'ACCOUNT',
        resourceId: current.account_id,
        oldValues: { status: account.previousStatus },
        newValues: {
          status: 'DEACTIVATED',
          revokedSessions: account.revokedSessions,
          revokedTokens: account.revokedTokens,
        },
        correlationId,
      });
      return toEmployeeResponse(updated, { email: account.email, status: 'DEACTIVATED' });
    });
  }

  /**
   * Delivery happens after commit. On failure the employee stays created
   * (committed business state is never rolled back by delivery), but the
   * account must not look successfully onboarded: the undeliverable token is
   * revoked and the failure is audited and logged (correlation ID only; never
   * the address or token). Recovery: internal reissue task, no HTTP endpoint.
   */
  private async deliverActivation(
    tenant: TenantContext,
    accountId: string,
    email: string,
    activation: PendingActivation,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.delivery.deliver(email, activation.rawToken);
      return;
    } catch {
      this.logger.warn(JSON.stringify({ event: 'employee.activation.delivery_failed', correlationId, accountId }));
    }
    try {
      await this.database.withTransaction(async (client) => {
        const revoked = await this.accounts.revokeUndeliveredActivation(
          client,
          tenant.companyId,
          accountId,
          activation.tokenId,
        );
        await this.audit.recordBusinessAction(client, {
          companyId: tenant.companyId,
          actorAccountId: tenant.accountId,
          action: 'ACCOUNT_ACTIVATION_DELIVERY_FAILED',
          resourceType: 'ACCOUNT',
          resourceId: accountId,
          newValues: { tokenRevoked: revoked },
          correlationId,
        });
      });
    } catch {
      // The digest-only token is unusable without the lost raw value; the
      // operator still needs to know that the bookkeeping failed.
      this.logger.error(JSON.stringify({ event: 'employee.activation.failure_bookkeeping_failed', correlationId, accountId }));
    }
  }

  private async respond(client: PoolClient, tenant: TenantContext, row: EmployeeRow): Promise<EmployeeResponse> {
    const summaries = await this.accounts.accountSummaries(client, tenant.companyId, [row.account_id]);
    return toEmployeeResponse(row, summaries.get(row.account_id));
  }
}

/** Old/new values for audit. Personal names are recorded as "changed" only (no PII copies). */
function auditDiff(before: EmployeeRow, after: EmployeeRow, changed: (keyof EmployeeChanges)[], impact?: EmploymentPeriodImpact) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const changedFields: string[] = [];
  for (const field of changed) {
    switch (field) {
      case 'employee_number':
        changedFields.push('employeeCode');
        oldValues.employeeCode = before.employee_number;
        newValues.employeeCode = after.employee_number;
        break;
      case 'employment_start':
        changedFields.push('employmentStart');
        oldValues.employmentStart = before.employment_start;
        newValues.employmentStart = after.employment_start;
        break;
      case 'employment_end':
        changedFields.push('employmentEnd');
        oldValues.employmentEnd = before.employment_end;
        newValues.employmentEnd = after.employment_end;
        break;
      case 'shift_eligibility':
        changedFields.push('shiftEligibility');
        oldValues.shiftEligibility = eligibilityFromDb(before.shift_eligibility);
        newValues.shiftEligibility = eligibilityFromDb(after.shift_eligibility);
        break;
      case 'first_name':
        changedFields.push('firstName');
        break;
      case 'last_name':
        changedFields.push('lastName');
        break;
    }
  }
  if (impact !== undefined) {
    oldValues.employmentStart = before.employment_start;
    oldValues.employmentEnd = before.employment_end;
    newValues.employmentStart = after.employment_start;
    newValues.employmentEnd = after.employment_end;
    newValues.employmentPeriodImpact = impact;
  }
  return { oldValues, newValues: { ...newValues, changedFields } };
}
