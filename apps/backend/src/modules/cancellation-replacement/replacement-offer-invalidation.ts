/** Workflow-owned W3 operations. Caller owns the transaction and all W1/W2 locks. */
import type { PoolClient } from 'pg';
import type { BusinessAuditService } from '../audit/business-audit.service.js';
type Transaction = Pick<PoolClient, 'query'>;
export type LockedOffer = {
  id: string;
  need_id: string;
  status: 'OPEN' | 'SELECTED' | 'NOT_SELECTED' | 'INVALIDATED' | 'WITHDRAWN';
};
export type InvalidationContext = {
  companyId: string;
  actorAccountId: string;
  correlationId: string;
  cause: 'CANCELLATION_WITHDRAWN' | 'ASSIGNMENT_REMOVED';
};

/** All needs in the batch, all statuses, globally sorted. Never lock candidate E rows here. */
export async function lockReplacementOffers(
  client: Transaction,
  companyId: string,
  needIds: readonly string[],
): Promise<LockedOffer[]> {
  return (
    await client.query<LockedOffer>(
      `SELECT id,need_id,status FROM public.replacement_offers
     WHERE company_id=$1 AND need_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
      [companyId, [...needIds]],
    )
  ).rows;
}

export function assertUnresolvedOffers(offers: readonly LockedOffer[]): void {
  if (offers.some((offer) => offer.status === 'SELECTED'))
    throw new Error('Selected offer under unresolved cancellation');
}

/** Status updates precede every Z audit. History is retained without reinterpretation. */
export async function invalidateOpenOffers(
  client: Transaction,
  companyId: string,
  offers: readonly LockedOffer[],
  at: string,
): Promise<LockedOffer[]> {
  assertUnresolvedOffers(offers);
  const open = offers.filter((offer) => offer.status === 'OPEN');
  if (open.length === 0) return [];
  const changed = await client.query(
    `UPDATE public.replacement_offers
     SET status='INVALIDATED',updated_at=$3::timestamptz,decided_at=$3::timestamptz
     WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='OPEN'`,
    [companyId, open.map((offer) => offer.id), at],
  );
  if (changed.rowCount !== open.length)
    throw new Error('Offer changed under invalidation locks');
  return open;
}

export async function auditInvalidatedOffers(
  client: Transaction,
  audit: BusinessAuditService,
  context: InvalidationContext,
  offers: readonly LockedOffer[],
): Promise<void> {
  for (const offer of offers) {
    await audit.recordBusinessAction(client, {
      companyId: context.companyId,
      actorAccountId: context.actorAccountId,
      correlationId: context.correlationId,
      action: 'REPLACEMENT_OFFER_INVALIDATED',
      resourceType: 'REPLACEMENT_OFFER',
      resourceId: offer.id,
      oldValues: { status: 'OPEN' },
      newValues: {
        status: 'INVALIDATED',
        needId: offer.need_id,
        cause: context.cause,
      },
    });
  }
}
