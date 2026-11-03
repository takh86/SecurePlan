import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import {
  isCivilDate,
  isNamedTimeZone,
  isUtcSecond,
} from '../../common/time/civil-time.js';
import { PLANNING_WRITER_TIMEOUTS } from './planning-locks.js';
import { assertPlanningSchemaComplete } from './planning-schema.js';
import { MY_MONTHLY_PLANS_QUERY } from './me-monthly-plans.query.js';
import type {
  MyMonthlyPlan,
  MyMonthlyPlansResponse,
} from './me-monthly-plan.types.js';

export type OwnPlanRow = {
  internal_owner_id: string;
  plan_id: string | null;
  project_id: string | null;
  project_name: string | null;
  month_start: string | null;
  duty_id: string | null;
  duty_date: string | null;
  shift_kind: string | null;
  duty_function: string | null;
  time_zone: string | null;
  starts_at: string | null;
  ends_at: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: string | null): string {
  if (value === null || !UUID.test(value))
    throw new Error('Invalid own plan identity');
  return value;
}
export function assertMyPlanMonth(monthStart: string): void {
  if (!isCivilDate(monthStart))
    throw new BadRequestException({ code: 'INVALID_DATE' });
  if (!monthStart.endsWith('-01'))
    throw new BadRequestException({ code: 'INVALID_MONTH_START' });
}

/** Only allowlisted employee fields leave this mapper; sentinel rows are not DTOs. */
export function toMyMonthlyPlansResponse(
  rows: OwnPlanRow[],
  monthStart: string,
): MyMonthlyPlansResponse {
  if (rows.length === 0)
    throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
  const plans = new Map<string, MyMonthlyPlan>();
  const duties = new Set<string>();
  for (const row of rows) {
    id(row.internal_owner_id);
    if (row.plan_id === null) continue;
    const planId = id(row.plan_id);
    if (row.month_start !== monthStart || typeof row.project_name !== 'string')
      throw new Error('Invalid own plan');
    let plan = plans.get(planId);
    if (!plan) {
      plan = {
        planId,
        project: { id: id(row.project_id), name: row.project_name },
        monthStart,
        duties: [],
      };
      plans.set(planId, plan);
    }
    if (row.duty_id === null) continue;
    const dutyId = id(row.duty_id);
    if (
      duties.has(dutyId) ||
      !isCivilDate(row.duty_date) ||
      row.duty_date.slice(0, 7) !== monthStart.slice(0, 7) ||
      !isUtcSecond(row.starts_at) ||
      !isUtcSecond(row.ends_at) ||
      row.ends_at <= row.starts_at ||
      !isNamedTimeZone(row.time_zone) ||
      !['TAG', 'NACHT'].includes(row.shift_kind ?? '') ||
      !['MITARBEITER', 'SCHICHTLEITER'].includes(row.duty_function ?? '')
    ) {
      throw new Error('Invalid own duty snapshot');
    }
    duties.add(dutyId);
    plan.duties.push({
      dutyId,
      dutyDate: row.duty_date,
      shiftKind: row.shift_kind === 'TAG' ? 'DAY' : 'NIGHT',
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      dutyRole: row.duty_function === 'MITARBEITER' ? 'EMPLOYEE' : 'SHIFT_LEAD',
      timeZone: row.time_zone,
    });
  }
  return { items: [...plans.values()] };
}

@Injectable()
export class MeMonthlyPlansReadService {
  constructor(private readonly database: DatabaseService) {}

  read(
    tenant: TenantContext,
    monthStart: string,
  ): Promise<MyMonthlyPlansResponse> {
    assertMyPlanMonth(monthStart);
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query(PLANNING_WRITER_TIMEOUTS);
      await lockAccountsPrefix(client, tenant, ['EMPLOYEE']);
      await assertSessionInTransaction(client, tenant);
      await assertPlanningSchemaComplete(client);
      const result = await client.query<OwnPlanRow>(MY_MONTHLY_PLANS_QUERY, [
        tenant.companyId,
        tenant.accountId,
        monthStart,
      ]);
      const response = toMyMonthlyPlansResponse(result.rows, monthStart);
      await assertSessionInTransaction(client, tenant);
      return response;
    });
  }
}
