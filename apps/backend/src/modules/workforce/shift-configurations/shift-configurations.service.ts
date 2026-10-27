/**
 * SP-08b Workforce & Projects: month-versioned shift configuration per project
 * (COMPANY_ADMIN only). Owner decisions O-1..O-10 of 27.10.2026, ADR-0003.
 *
 * Tenant rules (SP-06), as in ProjectsService:
 * - companyId/accountId/role come ONLY from the trusted TenantContext;
 * - every statement is scoped by `company_id = tenant.companyId`;
 * - unknown, foreign and ARCHIVED projects are indistinguishable (404);
 * - the PATCH re-asserts the acting account under row locks first.
 *
 * Versions: a version is the complete shift set of one (project, effective
 * month). GET returns the whole set of the latest month <= the requested month,
 * never a per-kind merge, so a kind missing from that version is not inherited.
 * PATCH replaces the set of exactly one month and never touches other months.
 *
 * Concurrency: the project row lock (FOR NO KEY UPDATE) serializes every writer
 * of a project's configuration and a concurrent project status change. Two
 * admin PATCHes for the same month are LAST-WRITER-WINS: both are applied
 * completely, in lock order, and the later one replaces the earlier result
 * (each effective change is audited). The v1 contract has no Expected-Version
 * precondition, so a PATCH based on a stale view is NOT detected; the lock only
 * guarantees that no mixed or partial set can ever be stored.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service.js';
import { assertActorInTransaction } from '../../../auth/authorization/actor-in-transaction.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { WALL_CLOCK, type WallClock } from '../../../common/time/wall-clock.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import { isMonthStart } from '../project-assignments/project-assignment.mapper.js';
import type { ShiftConfigurationQueryDto, UpdateShiftConfigurationDto } from './dto/shift-configuration.dto.js';
import { assertShiftConfigurationPlanningCheckImplemented } from './shift-configuration-planning-guard.js';
import {
  shiftKindToDb,
  shiftRuleColumns,
  shiftRuleOrder,
  toShiftConfigurationResponse,
  toShiftRuleResponse,
  type ShiftRuleRow,
} from './shift-configuration.mapper.js';
import { hasValidTimeRelation, isSameShiftSet, type ShiftRule } from './shift-configuration.rules.js';
import type { ProjectShiftConfigurationResponse } from './shift-configuration.types.js';

const ADMIN_ONLY = ['COMPANY_ADMIN'] as const;

type Queryable = Parameters<Parameters<DatabaseService['withTransaction']>[0]>[0];

function assertMonthStart(month: string): void {
  if (!isMonthStart(month)) throw new BadRequestException({ code: 'INVALID_MONTH_START' });
}

/** Audit values: business fields only, no row ids. */
function auditRules(rules: readonly ShiftRule[]): ShiftRule[] {
  return rules.map(({ shiftKind, startLocal, endLocal }) => ({ shiftKind, startLocal, endLocal }));
}

@Injectable()
export class ShiftConfigurationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
    @Inject(WALL_CLOCK) private readonly clock: WallClock,
  ) {}

  /** INACTIVE projects stay readable (history); A-SP08b-01 for "nothing configured". */
  async getEffective(
    tenant: TenantContext,
    projectId: string,
    query: ShiftConfigurationQueryDto,
  ): Promise<ProjectShiftConfigurationResponse> {
    assertMonthStart(query.effectiveForMonth);

    return this.database.withTransaction(async (client) => {
      // ONE statement, one snapshot: project visibility and the version rows agree.
      const result = await client.query<{ project_id: string } & { [K in keyof ShiftRuleRow]: string | null }>(
        `SELECT p.id AS project_id, ${shiftRuleColumns('sc')}
         FROM projects AS p
         LEFT JOIN LATERAL (
           SELECT max(effective_from_month) AS month
           FROM shift_configurations
           WHERE company_id = p.company_id AND project_id = p.id AND effective_from_month <= $3::date
         ) AS version ON true
         LEFT JOIN shift_configurations AS sc
           ON sc.company_id = p.company_id AND sc.project_id = p.id AND sc.effective_from_month = version.month
         WHERE p.company_id = $1 AND p.id = $2 AND p.status IN ('ACTIVE', 'INACTIVE')
         ORDER BY ${shiftRuleOrder('sc')}`,
        [tenant.companyId, projectId, query.effectiveForMonth],
      );
      if (result.rowCount === 0) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      const rules = result.rows.filter((row): row is { project_id: string } & ShiftRuleRow => row.id !== null);
      return toShiftConfigurationResponse(result.rows[0].project_id, rules);
    });
  }

  /**
   * Full replacement of the shift set of one effective month (O-5).
   * Error precedence (after the global guard and DTO validation):
   * 400 INVALID_MONTH_START -> 400 SHIFT_CONFIGURATION_INVALID (time relation)
   * -> [transaction] actor re-check (401/403) -> 404 project (unknown, foreign,
   * ARCHIVED) -> 409 PROJECT_INACTIVE -> 400 SHIFT_CONFIGURATION_INVALID (month
   * before the company's current month, O-3) -> no-op 200 without write or
   * audit -> 409 SHIFT_CONFIGURATION_CONFLICT (temporary planning guard, O-8)
   * -> write + audit in the same transaction.
   */
  async replace(
    tenant: TenantContext,
    projectId: string,
    dto: UpdateShiftConfigurationDto,
    correlationId: string,
  ): Promise<ProjectShiftConfigurationResponse> {
    assertMonthStart(dto.effectiveFromMonth);
    const month = dto.effectiveFromMonth;
    const desired: ShiftRule[] = dto.shifts.map(({ shiftKind, startLocal, endLocal }) => ({
      shiftKind,
      startLocal,
      endLocal,
    }));
    if (!desired.every(hasValidTimeRelation)) {
      throw new BadRequestException({ code: 'SHIFT_CONFIGURATION_INVALID' });
    }

    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      // NO KEY UPDATE: serializes all writers of this project's configuration and
      // a concurrent status change (the project PATCH takes the same lock);
      // assignment writes (FOR SHARE) wait briefly; FK KEY SHARE locks do not.
      const project = requireRow(
        await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM projects
           WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE')
           FOR NO KEY UPDATE`,
          [tenant.companyId, projectId],
        ),
      );
      // INACTIVE blocks configuration writes, even an unchanged one; GET stays possible.
      if (project.status !== 'ACTIVE') throw new ConflictException({ code: 'PROJECT_INACTIVE' });

      const currentMonth = requireRow(
        await client.query<{ current_month: string }>(
          `SELECT to_char(date_trunc('month', $2::timestamptz AT TIME ZONE time_zone), 'YYYY-MM-DD') AS current_month
           FROM companies WHERE id = $1`,
          [tenant.companyId, this.clock().toISOString()],
        ),
      ).current_month;
      // O-3: past effective months are history and immutable (YYYY-MM-DD compares chronologically).
      if (month < currentMonth) throw new BadRequestException({ code: 'SHIFT_CONFIGURATION_INVALID' });

      const before = await this.readVersion(client, tenant.companyId, project.id, month);
      const current = before.map(toShiftRuleResponse);
      // Compared with the set stored for exactly this month, not with the effective
      // (older) version: creating a version is a change even if its times are equal.
      if (isSameShiftSet(current, desired)) return toShiftConfigurationResponse(project.id, before);

      await assertShiftConfigurationPlanningCheckImplemented(client);

      // Diff-apply keeps the ids of kinds that stay: drop kinds missing from the
      // new set, insert new kinds, update changed times in place.
      const kinds = desired.map((rule) => shiftKindToDb(rule.shiftKind));
      await client.query(
        `DELETE FROM shift_configurations
         WHERE company_id = $1 AND project_id = $2 AND effective_from_month = $3::date
           AND shift_kind <> ALL($4::text[])`,
        [tenant.companyId, project.id, month, kinds],
      );
      await client.query(
        `INSERT INTO shift_configurations
           (company_id, project_id, effective_from_month, shift_kind, start_local, end_local)
         SELECT $1::uuid, $2::uuid, $3::date, t.shift_kind, t.start_local::time, t.end_local::time
         FROM unnest($4::text[], $5::text[], $6::text[]) AS t(shift_kind, start_local, end_local)
         ON CONFLICT ON CONSTRAINT uq_shift_configurations__project_month_kind
         DO UPDATE SET start_local = EXCLUDED.start_local, end_local = EXCLUDED.end_local,
                       updated_at = clock_timestamp()
         WHERE (shift_configurations.start_local, shift_configurations.end_local)
               IS DISTINCT FROM (EXCLUDED.start_local, EXCLUDED.end_local)`,
        [
          tenant.companyId,
          project.id,
          month,
          kinds,
          desired.map((rule) => rule.startLocal),
          desired.map((rule) => rule.endLocal),
        ],
      );
      const response = toShiftConfigurationResponse(
        project.id,
        await this.readVersion(client, tenant.companyId, project.id, month),
      );

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'SHIFT_CONFIGURATION_UPDATED',
        resourceType: 'PROJECT_SHIFT_CONFIGURATION',
        resourceId: project.id,
        oldValues: current.length > 0 ? { effectiveFromMonth: month, shifts: auditRules(current) } : null,
        newValues: { effectiveFromMonth: month, shifts: auditRules(response.shifts) },
        correlationId,
      });
      return response;
    });
  }

  private async readVersion(
    client: Queryable,
    companyId: string,
    projectId: string,
    month: string,
  ): Promise<ShiftRuleRow[]> {
    const result = await client.query<ShiftRuleRow>(
      `SELECT ${shiftRuleColumns()} FROM shift_configurations
       WHERE company_id = $1 AND project_id = $2 AND effective_from_month = $3::date
       ORDER BY ${shiftRuleOrder()}`,
      [companyId, projectId, month],
    );
    return result.rows;
  }
}
