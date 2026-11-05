import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EmployeeSummary } from '../workforce/employees/employee-context.js';
import { replacementHistoryDutyJoin } from '../planning/replacement-planning.js';
export type ReplacementOffer = {
  id: string;
  needId: string;
  employee: EmployeeSummary;
  status: 'OPEN' | 'SELECTED' | 'NOT_SELECTED' | 'INVALIDATED' | 'WITHDRAWN';
  createdAt: string;
  decidedAt: string | null;
};
type OfferRow = {
  id: string;
  need_id: string;
  status: ReplacementOffer['status'];
  created_at: Date;
  decided_at: Date | null;
};
export function offerDto(
  row: OfferRow,
  employee: EmployeeSummary,
): ReplacementOffer {
  return {
    id: row.id,
    needId: row.need_id,
    employee,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}
export async function ownOffer(
  c: PoolClient,
  company: string,
  employee: EmployeeSummary,
  id: string,
) {
  const row = (
    await c.query<OfferRow>(
      'SELECT id,need_id,status,created_at,decided_at FROM public.replacement_offers WHERE company_id=$1 AND employee_id=$2 AND id=$3',
      [company, employee.id, id],
    )
  ).rows[0];
  if (!row) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  return offerDto(row, employee);
}
export async function ownReplacementOffers(
  c: PoolClient,
  company: string,
  employee: EmployeeSummary,
  month: string,
) {
  const rows = (
    await c.query<OfferRow>(
      `SELECT o.id,o.need_id,o.status,o.created_at,o.decided_at FROM public.replacement_offers o
 JOIN public.replacement_needs n ON n.company_id=o.company_id AND n.id=o.need_id
 ${replacementHistoryDutyJoin} WHERE o.company_id=$1 AND o.employee_id=$2 AND d.planning_month=$3::date ORDER BY o.created_at,o.id`,
      [company, employee.id, month],
    )
  ).rows;
  return rows.map((row) => offerDto(row, employee));
}
