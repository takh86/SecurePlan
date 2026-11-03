import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Caller holds P SHARE or stronger, before L/D; never takes a late parent lock. */
export async function assertOperatingDay(
  client: Pick<PoolClient, 'query'>, companyId: string, projectId: string, day: string,
): Promise<void> {
  const result = await client.query<{ open: boolean }>(
    `SELECT (weekday_mask::int & (1 << (extract(isodow FROM $3::date)::int - 1))) <> 0 AS open
     FROM public.project_operating_calendars
     WHERE company_id = $1 AND project_id = $2 AND effective_from_month <= date_trunc('month', $3::date)::date
     ORDER BY effective_from_month DESC LIMIT 1`, [companyId, projectId, day],
  );
  if (result.rowCount !== 1) throw new ConflictException({ code: 'PROJECT_CALENDAR_MISSING' });
  if (!result.rows[0].open) throw new ConflictException({ code: 'PROJECT_CLOSED_WEEKDAY' });
}
