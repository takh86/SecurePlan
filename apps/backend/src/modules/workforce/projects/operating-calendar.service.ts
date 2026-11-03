import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../../auth/session.service.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import { lockAccountsPrefix } from '../../identity/account-prefix-lock.js';
import { PLANNING_WRITER_TIMEOUTS } from '../../planning/planning-locks.js';
import { assertPlanningSchemaComplete } from '../../planning/planning-schema.js';
import { validCivilDate } from '../availability/availability.rules.js';
import type { UpdateCalendarDto } from './operating-calendar.dto.js';

type Row = { id: string; month: string; version: string; weekday_mask: number };
const weekdays = (mask: number) => [1, 2, 3, 4, 5, 6, 7].filter((day) => (mask & (1 << (day - 1))) !== 0);
function invalid(field: string): never {
  throw new BadRequestException({ code: 'PROJECT_CALENDAR_INVALID', errors: [{ pointer: `#/${field}`, code: 'INVALID_FORMAT' }] });
}
function month(value: string, field: string): void {
  if (!validCivilDate(value) || !value.endsWith('-01')) invalid(field);
}
const token = (row: Row | undefined) => row ? { id: row.id, version: Number(row.version) } : null;
const values = (row: Row) => ({ effectiveFromMonth: row.month, operatingWeekdays: weekdays(row.weekday_mask), version: Number(row.version) });
const stale = () => { throw new ConflictException({ code: 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION' }); };

@Injectable()
export class OperatingCalendarService {
  constructor(private readonly database: DatabaseService, private readonly audit: BusinessAuditService) {}

  private async read(client: Pick<PoolClient, 'query'>, companyId: string, projectId: string, target: string) {
    const rows = (await client.query<Row>(
      `SELECT id, to_char(effective_from_month, 'YYYY-MM-DD') AS month, version::text, weekday_mask
       FROM public.project_operating_calendars WHERE company_id = $1 AND project_id = $2
       AND (effective_from_month = (SELECT max(effective_from_month) FROM public.project_operating_calendars
         WHERE company_id = $1 AND project_id = $2 AND effective_from_month <= $3::date)
         OR effective_from_month = (SELECT min(effective_from_month) FROM public.project_operating_calendars
         WHERE company_id = $1 AND project_id = $2 AND effective_from_month > $3::date))
       ORDER BY effective_from_month`, [companyId, projectId, target],
    )).rows;
    const effective = rows.find((row) => row.month <= target);
    const exact = effective?.month === target ? effective : undefined;
    const next = rows.find((row) => row.month > target)?.month ?? null;
    return { effective, exact, next, response: {
      projectId, effectiveForMonth: target, state: effective ? 'CONFIGURED' : 'MISSING',
      effective: effective ? { id: effective.id, ...values(effective) } : null,
      exactVersion: token(exact), nextEffectiveFromMonth: next,
    } };
  }

  async get(tenant: TenantContext, projectId: string, target: string) {
    month(target, 'effectiveForMonth');
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      requireRow(await client.query(`SELECT 1 FROM projects WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE')`, [tenant.companyId, projectId]));
      return (await this.read(client, tenant.companyId, projectId, target)).response;
    });
  }

  async replace(tenant: TenantContext, projectId: string, dto: UpdateCalendarDto, correlationId: string) {
    month(dto.effectiveFromMonth, 'effectiveFromMonth');
    if (dto.expectedNextEffectiveFromMonth !== null) month(dto.expectedNextEffectiveFromMonth, 'expectedNextEffectiveFromMonth');
    return this.database.withTransaction(async (client) => {
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ['COMPANY_ADMIN']);
      await assertPlanningSchemaComplete(client);
      const project = requireRow(await client.query<{ status: string }>(
        `SELECT status FROM projects WHERE company_id = $1 AND id = $2 AND status IN ('ACTIVE', 'INACTIVE') FOR NO KEY UPDATE`, [tenant.companyId, projectId],
      ));
      await assertSessionInTransaction(client, tenant);
      const current = await this.read(client, tenant.companyId, projectId, dto.effectiveFromMonth);
      const matches = (actual: ReturnType<typeof token>, expected: UpdateCalendarDto['expectedEffective']) =>
        actual === null ? expected === null : expected !== null && actual.id === expected.id.toLowerCase() && actual.version === expected.version;
      if (!matches(token(current.exact), dto.expectedExactVersion) || !matches(token(current.effective), dto.expectedEffective)
        || current.next !== dto.expectedNextEffectiveFromMonth) stale();
      const timing = requireRow(await client.query<{ today: string; first: string | null; configured: boolean }>(
        `SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE c.time_zone), 'YYYY-MM-DD') AS today,
         (SELECT to_char(min(planning_month), 'YYYY-MM-DD') FROM public.duties WHERE company_id = $1 AND project_id = $2 AND removed_at IS NULL) AS first,
         EXISTS(SELECT 1 FROM public.project_operating_calendars WHERE company_id = $1 AND project_id = $2) AS configured
         FROM companies c WHERE c.id = $1`, [tenant.companyId, projectId],
      ));
      if (dto.bootstrap ? timing.configured || dto.effectiveFromMonth !== (timing.first ?? timing.today)
        : dto.effectiveFromMonth < timing.today) invalid('effectiveFromMonth');
      const mask = dto.operatingWeekdays.reduce((sum, day) => sum | (1 << (day - 1)), 0);
      if (current.exact?.weekday_mask === mask) return { ...current.response, outcome: 'NO_OP' };
      if (project.status !== 'ACTIVE') throw new ConflictException({ code: 'PROJECT_INACTIVE' });
      // P freezes ALL writers, including empty duties and direct PUBLISHED edits.
      // Existing closed dates remain visible; only newly closed dates block replacement.
      const dependency = await client.query(
        `SELECT 1 FROM public.duties d WHERE d.company_id = $1 AND d.project_id = $2 AND d.removed_at IS NULL
         AND d.duty_date >= $3::date AND ($4::date IS NULL OR d.duty_date < $4::date)
         AND ($5::int & (1 << (extract(isodow FROM d.duty_date)::int - 1))) = 0
         AND ($6::int IS NULL OR ($6::int & (1 << (extract(isodow FROM d.duty_date)::int - 1))) <> 0) LIMIT 1`,
        [tenant.companyId, projectId, dto.effectiveFromMonth, current.next, mask, current.effective?.weekday_mask ?? null],
      );
      if (dependency.rowCount !== 0) throw new ConflictException({ code: 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT' });
      if (current.exact && Number(current.exact.version) >= Number.MAX_SAFE_INTEGER) stale();
      const row = requireRow(await client.query<Row>(
        `INSERT INTO public.project_operating_calendars (company_id, project_id, effective_from_month, weekday_mask)
         VALUES ($1, $2, $3::date, $4) ON CONFLICT (company_id, project_id, effective_from_month)
         DO UPDATE SET weekday_mask = EXCLUDED.weekday_mask, version = project_operating_calendars.version + 1, updated_at = clock_timestamp()
         RETURNING id, to_char(effective_from_month, 'YYYY-MM-DD') AS month, version::text, weekday_mask`,
        [tenant.companyId, projectId, dto.effectiveFromMonth, mask],
      ));
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId, actorAccountId: tenant.accountId, action: 'PROJECT_OPERATING_CALENDAR_UPDATED',
        resourceType: 'PROJECT_OPERATING_CALENDAR', resourceId: projectId,
        oldValues: current.exact ? values(current.exact) : null,
        newValues: { ...values(row), ...(dto.bootstrap ? { bootstrap: true } : {}) }, correlationId,
      });
      return { ...(await this.read(client, tenant.companyId, projectId, dto.effectiveFromMonth)).response, outcome: 'APPLIED' };
    });
  }
}
