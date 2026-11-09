/**
 * SP-20 D-8 (amendment A4): a duty whose replacement need is RESOLVED keeps its date, shift and selected
 * REPLACEMENT membership. Callers hold the duty row lock (D FOR UPDATE) and call this before their write, so a
 * selection that committed first is visible to the statement below (READ COMMITTED).
 */
import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export async function assertNoResolvedReplacementChange(
  c: Pick<PoolClient, 'query'>,
  companyId: string,
  dutyId: string,
  change: { removesDuty?: boolean; timingChanged?: boolean; membershipIds?: readonly string[] },
): Promise<void> {
  const resolved = (
    await c.query<{ found: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM public.replacement_needs WHERE company_id=$1 AND duty_id=$2 AND status='RESOLVED') AS found",
      [companyId, dutyId],
    )
  ).rows[0].found;
  if (!resolved) return;
  if (change.removesDuty || change.timingChanged) throw new ConflictException({ code: 'CANCELLATION_PLAN_CHANGED' });
  if (change.membershipIds && change.membershipIds.length > 0) {
    const touchesReplacement = (
      await c.query<{ found: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM public.plan_assignments WHERE company_id=$1 AND id=ANY($2::uuid[]) AND source='REPLACEMENT' AND state='ACTIVE') AS found",
        [companyId, [...change.membershipIds]],
      )
    ).rows[0].found;
    if (touchesReplacement) throw new ConflictException({ code: 'CANCELLATION_PLAN_CHANGED' });
  }
}
