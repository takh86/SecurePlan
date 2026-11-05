import { Injectable } from '@nestjs/common';
import type {
  MutationTransaction,
  PlanningAssignmentMutation,
} from '../../common/transactions/planning-mutation.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';

import { lockReplacementOffers, assertUnresolvedOffers, invalidateOpenOffers, auditInvalidatedOffers } from './replacement-offer-invalidation.js';

type Cancellation = { id: string; assignment_id: string; duty_id: string };
type Need = {
  id: string;
  cancellation_request_id: string;
  duty_id: string;
  status: string;
};

/** Workflow owner. Only the caller's effective removals under D/A2/Q fences are accepted. */
@Injectable()
export class AssignmentRemovalReconciler {
  constructor(private readonly audit: BusinessAuditService) {}

  async reconcile(
    client: MutationTransaction,
    mutation: PlanningAssignmentMutation,
  ): Promise<void> {
    const dutyByAssignment = new Map<string, string>();
    for (const change of mutation.changes) {
      for (const id of change.removedAssignmentIds) {
        if (
          dutyByAssignment.has(id) &&
          dutyByAssignment.get(id) !== change.dutyId
        ) {
          throw new Error('Inconsistent assignment removal notification');
        }
        dutyByAssignment.set(id, change.dutyId);
      }
    }
    if (dutyByAssignment.size === 0) return;
    // The owning Planning writer already holds every D/A2/Q lock. D fences new cases.
    // Acquire ALL W1, then ALL W2, then ALL W3 rows before any transition or Z audit.
    const cancellations = (
      await client.query<Cancellation>(
        `SELECT id, assignment_id, duty_id FROM public.cancellation_requests
       WHERE company_id=$1 AND assignment_id=ANY($2::uuid[]) AND status='OPEN'
       ORDER BY id FOR UPDATE`,
        [mutation.companyId, [...dutyByAssignment.keys()].sort()],
      )
    ).rows;
    const needs = (
      await client.query<Need>(
        `SELECT id, cancellation_request_id, duty_id, status FROM public.replacement_needs
       WHERE company_id=$1 AND cancellation_request_id=ANY($2::uuid[])
       ORDER BY id FOR UPDATE`,
        [mutation.companyId, cancellations.map((row) => row.id)],
      )
    ).rows;
    const needByCancellation = new Map<string, Need>();
    for (const need of needs) {
      if (needByCancellation.has(need.cancellation_request_id))
        throw new Error('Duplicate replacement need');
      needByCancellation.set(need.cancellation_request_id, need);
    }
    for (const cancellation of cancellations) {
      const need = needByCancellation.get(cancellation.id);
      if (
        dutyByAssignment.get(cancellation.assignment_id) !==
          cancellation.duty_id ||
        !need ||
        need.status !== 'OPEN' ||
        need.duty_id !== cancellation.duty_id
      ) {
        throw new Error('Inconsistent cancellation and replacement need');
      }
    }
    if (needs.length !== cancellations.length)
      throw new Error('Inconsistent workflow cardinality');
    if (cancellations.length === 0) return;
    const offers = await lockReplacementOffers(client, mutation.companyId, needs.map((row) => row.id));
    assertUnresolvedOffers(offers);
    // One database timestamp, without millisecond truncation in JavaScript.
    const {
      rows: [clock],
    } = await client.query<{ at: string }>(
      'SELECT clock_timestamp()::text AS at',
    );
    const obsolete = await client.query(
      `UPDATE public.cancellation_requests SET status='OBSOLETE',updated_at=$3::timestamptz
       WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='OPEN'`,
      [mutation.companyId, cancellations.map((row) => row.id), clock.at],
    );
    const closed = await client.query(
      `UPDATE public.replacement_needs SET status='CLOSED',updated_at=$3::timestamptz
       WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='OPEN'`,
      [mutation.companyId, needs.map((row) => row.id), clock.at],
    );
    if (
      obsolete.rowCount !== cancellations.length ||
      closed.rowCount !== needs.length
    ) {
      throw new Error('Workflow changed under reconciliation locks');
    }
    const invalidated = await invalidateOpenOffers(client, mutation.companyId, offers, clock.at);
    for (const cancellation of cancellations) {
      const need = needByCancellation.get(cancellation.id)!;
      const base = {
        companyId: mutation.companyId,
        actorAccountId: mutation.actorAccountId,
        correlationId: mutation.correlationId,
      };
      await this.audit.recordBusinessAction(client, {
        ...base,
        action: 'CANCELLATION_OBSOLETED',
        resourceType: 'CANCELLATION_REQUEST',
        resourceId: cancellation.id,
        oldValues: { status: 'OPEN' },
        newValues: { status: 'OBSOLETE' },
      });
      await this.audit.recordBusinessAction(client, {
        ...base,
        action: 'REPLACEMENT_NEED_CLOSED',
        resourceType: 'REPLACEMENT_NEED',
        resourceId: need.id,
        oldValues: { status: 'OPEN' },
        newValues: { status: 'CLOSED' },
      });
    }
    await auditInvalidatedOffers(client, this.audit, {
      companyId: mutation.companyId, actorAccountId: mutation.actorAccountId,
      correlationId: mutation.correlationId, cause: 'ASSIGNMENT_REMOVED',
    }, invalidated);
  }
}
