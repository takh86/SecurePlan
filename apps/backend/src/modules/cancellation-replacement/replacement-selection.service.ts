/**
 * SP-20 atomic replacement selection (administrator). One business transaction under the global lock order
 * A → C → I → E → P → M → L → D → A2 → Q → W1 → W2 → W3 → Z (ADR-0006, amendments R3).
 * Discovery is read-only and only names the rows to lock; every decision is re-taken under the locks.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { reserveCommand } from '../../common/transactions/command-reservation.js';
import { lockAttempt, reservationLock } from '../../common/transactions/idempotency-lock.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { lockReplacementProject, replacementCandidateFacts, replacementCandidateJoin } from '../workforce/employees/replacement-candidate.js';
import { lockReplacementDuty, replacementPlanningFacts, replacementPlanningJoin } from '../planning/replacement-planning.js';
import { assertPlanningSchemaComplete } from '../planning/planning-schema.js';
import { dutyColumns, type DutyRow, type MembershipRow } from '../planning/monthly-plan.mapper.js';
import { dutyValues, memberValues, removalColumn } from '../planning/duty-audit-values.js';
import { assertEmployeeMonthReceiptSchema } from '../planning/employee-month-receipt-schema.js';
import { PLANNING_WRITER_TIMEOUTS } from '../planning/planning-locks.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';
import { lockReplacementOffers } from './replacement-offer-invalidation.js';
import { replacementIneligibility, type EligibilityFacts } from './replacement-eligibility.js';
import type { SelectionResponse } from './replacement-selection.dto.js';

const OP = 'DECIDE_REPLACEMENT_SELECTION',
  RETENTION = 86400,
  STALE = 300;
const digest = (s: string) => createHash('sha256').update(s).digest();
export const selectionFingerprint = (needId: string, offerId: string, expectedVersion: number) =>
  digest(JSON.stringify(['decide-replacement-selection-v1', needId.toLowerCase(), offerId.toLowerCase(), expectedVersion]));

/** Discovery row. Identifiers only decide WHICH rows to lock; every status is re-read under the locks. */
type Discovered = {
  need_id: string;
  need_status: string;
  need_version: string;
  selected_offer_id: string | null;
  cancellation_id: string;
  cancellation_status: string;
  assignment_id: string;
  original_id: string;
  duty_id: string;
  plan_id: string;
  project_id: string;
  planning_month: string;
  plan_status: string;
  project_status: string;
  duty_removed: boolean;
  duty_function: string;
  assignment_state: string;
  offer_id: string | null;
  offer_status: string | null;
  candidate_id: string | null;
  candidate_account_id: string | null;
};

const discoverySql = `SELECT n.id AS need_id,n.status AS need_status,n.concurrency_version::text AS need_version,n.selected_offer_id,
 r.id AS cancellation_id,r.status AS cancellation_status,r.assignment_id,r.employee_id AS original_id,r.duty_id,
 d.monthly_plan_id AS plan_id,d.project_id,d.planning_month::text AS planning_month,p.status AS plan_status,pr.status AS project_status,
 d.removed_at IS NOT NULL AS duty_removed,a.duty_function,a.state AS assignment_state,
 o.id AS offer_id,o.status AS offer_status,o.employee_id AS candidate_id,e.account_id AS candidate_account_id
 FROM public.replacement_needs n
 JOIN public.cancellation_requests r ON r.company_id=n.company_id AND r.id=n.cancellation_request_id AND r.duty_id=n.duty_id
 ${replacementPlanningJoin}
 LEFT JOIN public.replacement_offers o ON o.company_id=n.company_id AND o.need_id=n.id AND o.id=$3
 LEFT JOIN public.employees e ON e.company_id=o.company_id AND e.id=o.employee_id
 WHERE n.company_id=$1 AND n.id=$2`;

@Injectable()
export class ReplacementSelectionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
  ) {}

  private async enter(c: PoolClient, t: TenantContext) {
    await c.query(PLANNING_WRITER_TIMEOUTS);
    await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']);
    await assertSessionInTransaction(c, t);
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
  }

  private async discover(c: PoolClient, companyId: string, needId: string, offerId: string): Promise<Discovered> {
    const row = (await c.query<Discovered>(discoverySql, [companyId, needId, offerId])).rows[0];
    // Concealment: an unknown need, a need of another company, or an offer that is not this need's offer is 404.
    if (!row || row.offer_id === null) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return row;
  }

  /** Rows that were named before the locks must still be the same rows after them; otherwise the plan changed. */
  private assertSameDiscovery(before: Discovered, after: Discovered) {
    const keys = ['cancellation_id', 'assignment_id', 'original_id', 'duty_id', 'plan_id', 'project_id', 'planning_month', 'candidate_id'] as const;
    if (keys.some((k) => before[k] !== after[k])) throw new ConflictException({ code: 'PLAN_CONCURRENT_MODIFICATION' });
  }

  /** Candidate eligibility facts, bound to the candidate employee (not to the requesting administrator). */
  private async candidateFacts(c: PoolClient, companyId: string, candidateId: string, accountId: string, needId: string): Promise<EligibilityFacts> {
    const row = (
      await c.query<EligibilityFacts>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
         SELECT (n.status='OPEN' AND r.status='OPEN') AS open, (r.employee_id<>$2) AS not_self,
           ${replacementPlanningFacts},${replacementCandidateFacts}
         FROM public.replacement_needs n
         JOIN public.cancellation_requests r ON r.company_id=n.company_id AND r.id=n.cancellation_request_id AND r.duty_id=n.duty_id
         ${replacementPlanningJoin} ${replacementCandidateJoin} CROSS JOIN moment
         WHERE n.company_id=$1 AND n.id=$4`,
        [companyId, candidateId, accountId, needId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return row;
  }

  private async result(c: PoolClient, companyId: string, needId: string, cancellationId: string, offerId: string): Promise<SelectionResponse> {
    const need = (await c.query<{ resolved_at: Date; version: string; duty_id: string }>(
      'SELECT resolved_at,concurrency_version::text AS version,duty_id FROM public.replacement_needs WHERE company_id=$1 AND id=$2',
      [companyId, needId],
    )).rows[0];
    const cancellation = (await c.query<{ assignment_id: string; decided_at: Date }>(
      'SELECT assignment_id,decided_at FROM public.cancellation_requests WHERE company_id=$1 AND id=$2',
      [companyId, cancellationId],
    )).rows[0];
    const selected = (await c.query<{ id: string; employee_id: string; employee_number: string; first_name: string; last_name: string }>(
      `SELECT o.id,o.employee_id,e.employee_number,e.first_name,e.last_name FROM public.replacement_offers o
       JOIN public.employees e ON e.company_id=o.company_id AND e.id=o.employee_id WHERE o.company_id=$1 AND o.id=$2`,
      [companyId, offerId],
    )).rows[0];
    const others = (await c.query<{ id: string }>(
      "SELECT id FROM public.replacement_offers WHERE company_id=$1 AND need_id=$2 AND status='NOT_SELECTED' ORDER BY id", [companyId, needId],
    )).rows;
    const original = (await c.query<{ id: string; state: string; removed_at: Date }>(
      'SELECT id,state,removed_at FROM public.plan_assignments WHERE company_id=$1 AND id=$2', [companyId, cancellation.assignment_id],
    )).rows[0];
    const replacement = (await c.query<{ id: string; employee_id: string }>(
      "SELECT id,employee_id FROM public.plan_assignments WHERE company_id=$1 AND source='REPLACEMENT' AND replacement_offer_id=$2 AND state='ACTIVE'",
      [companyId, offerId],
    )).rows[0];
    const duty = (await c.query<{ concurrency_version: string }>(
      'SELECT concurrency_version::text AS concurrency_version FROM public.duties WHERE company_id=$1 AND id=$2', [companyId, need.duty_id],
    )).rows[0];
    return {
      needId,
      cancellationRequestId: cancellationId,
      status: { cancellation: 'APPROVED', need: 'RESOLVED' },
      decidedAt: cancellation.decided_at.toISOString(),
      needVersion: Number(need.version),
      selectedOffer: {
        id: selected.id,
        status: 'SELECTED',
        employee: { id: selected.employee_id, employeeNumber: selected.employee_number, firstName: selected.first_name, lastName: selected.last_name },
      },
      otherOffers: others.map((o) => ({ id: o.id, status: 'NOT_SELECTED' as const })),
      originalAssignment: { id: original.id, state: 'REMOVED', removedAt: original.removed_at.toISOString() },
      replacementAssignment: { id: replacement.id, employeeId: replacement.employee_id, source: 'REPLACEMENT', state: 'ACTIVE' },
      duty: { id: need.duty_id, concurrencyVersion: Number(duty.concurrency_version) },
    };
  }

  async select(t: TenantContext, needId: string, offerId: string, expectedVersion: number, key: string, correlationId: string) {
    const keyHash = digest(key);
    const requestHash = selectionFingerprint(needId, offerId, expectedVersion);
    const lockId = digest(JSON.stringify(['decide-replacement-selection-v1', t.companyId, t.accountId, OP, keyHash.toString('hex')]))
      .readBigInt64BE()
      .toString();

    // Reservation: concealment and durable claim. Any refusal here writes nothing.
    const reserved = await this.database.withTransaction(async (c) => {
      await this.enter(c, t);
      await this.discover(c, t.companyId, needId, offerId);
      return reserveCommand(c, {
        tenant: t,
        operation: OP,
        keyHash,
        requestHash,
        lockId,
        retention: RETENTION,
        stale: STALE,
        beforeWrite: async () => {
          await assertSessionInTransaction(c, t);
          await this.discover(c, t.companyId, needId, offerId);
        },
        replay: async (prior) => {
          if (!prior.result_cancellation_request_id || !prior.result_replacement_offer_id) throw new Error('Invalid typed selection receipt');
          const response = await this.result(c, t.companyId, needId, prior.result_cancellation_request_id, prior.result_replacement_offer_id);
          await assertSessionInTransaction(c, t);
          return response;
        },
      });
    });
    if ('result' in reserved) return { result: reserved.result, replayed: true };
    const claim = reserved.claim;

    try {
      return await this.database.withTransaction(async (c) => {
        await this.enter(c, t);
        // Discovery of the rows to lock (read-only). Every decision below uses locked, re-read facts.
        const before = await this.discover(c, t.companyId, needId, offerId);
        await reservationLock(c, lockId);
        await lockAttempt(c, t.companyId, t.accountId, OP, keyHash, claim.id, claim.attempt_id);
        // E: original and candidate employees, in UUID order, FOR NO KEY UPDATE (ADR-0006 employee writers).
        const employees = [before.original_id, before.candidate_id as string].sort();
        await c.query(
          'SELECT id FROM public.employees WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE',
          [t.companyId, employees],
        );
        // P then M (candidate project assignment), L and D, then A2 (original and candidate memberships).
        await lockReplacementProject(c, t.companyId, before.candidate_id as string, before.project_id, before.planning_month);
        await lockReplacementDuty(c, t.companyId, before.candidate_id as string, {
          plan_id: before.plan_id,
          duty_id: before.duty_id,
          assignment_id: before.assignment_id,
        });
        // Q: duty edit leases. Any live lease refuses selection immediately; selection never waits on or takes over a lease.
        await c.query('SELECT id FROM public.edit_leases WHERE company_id=$1 AND duty_id=$2 ORDER BY id FOR UPDATE', [t.companyId, before.duty_id]);
        // W1, W2, W3.
        await c.query('SELECT id FROM public.cancellation_requests WHERE company_id=$1 AND id=$2 ORDER BY id FOR UPDATE', [t.companyId, before.cancellation_id]);
        await c.query('SELECT id FROM public.replacement_needs WHERE company_id=$1 AND id=$2 ORDER BY id FOR UPDATE', [t.companyId, needId]);
        const offers = await lockReplacementOffers(c, t.companyId, [needId]);
        await assertSessionInTransaction(c, t);

        const after = await this.discover(c, t.companyId, needId, offerId);
        this.assertSameDiscovery(before, after);

        // Precedence (design R2a §5.3): case state, then version, then offer, then duty and membership, then eligibility, then lease.
        if (after.need_status !== 'OPEN') {
          throw new ConflictException({ code: after.need_status === 'CLOSED' ? 'REPLACEMENT_NEED_NOT_OPEN' : 'CANCELLATION_ALREADY_RESOLVED' });
        }
        if (after.cancellation_status !== 'OPEN') throw new Error('Inconsistent cancellation and replacement need');
        if (Number(after.need_version) !== expectedVersion) throw new ConflictException({ code: 'PLAN_CONCURRENT_MODIFICATION' });
        if (after.offer_status !== 'OPEN') throw new ConflictException({ code: 'REPLACEMENT_OFFER_NOT_SELECTABLE' });
        if (after.duty_removed || after.plan_status !== 'PUBLISHED' || !['ACTIVE', 'INACTIVE'].includes(after.project_status)) {
          throw new ConflictException({ code: 'CANCELLATION_PLAN_CHANGED' });
        }
        if (after.assignment_state !== 'ACTIVE') throw new ConflictException({ code: 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE' });
        const facts = await this.candidateFacts(c, t.companyId, after.candidate_id as string, after.candidate_account_id as string, needId);
        const reason = replacementIneligibility(facts);
        if (reason) throw new ConflictException({ code: reason });
        const live = (await c.query<{ live: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM public.edit_leases WHERE company_id=$1 AND duty_id=$2 AND released_at IS NULL AND expires_at>clock_timestamp()) AS live',
          [t.companyId, after.duty_id],
        )).rows[0].live;
        if (live) throw new ConflictException({ code: 'RESOURCE_EDIT_LOCKED' });
        // A1: the cancelled function is copied only when it is MITARBEITER. SCHICHTLEITER needs a qualification rule
        // that does not exist yet (PO decision P-1), so selection fails closed before any write.
        if (after.duty_function !== 'MITARBEITER') throw new ConflictException({ code: 'REPLACEMENT_CANDIDATE_INELIGIBLE' });
        const losing = offers.filter((o) => o.id !== offerId && o.status === 'OPEN');

        // Writes. One database timestamp for every change in this command.
        const at = (await c.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0].at;
        // Previous D and M are read under the duty and membership locks, before the first write (ADR-0004 SP-12 supplement).
        const dutyBefore = (await c.query<DutyRow>(
          `SELECT ${dutyColumns('d')} FROM public.duties AS d WHERE d.company_id=$1 AND d.id=$2 AND d.removed_at IS NULL`,
          [t.companyId, after.duty_id],
        )).rows[0];
        if (!dutyBefore) throw new Error('Duty changed under selection locks');
        const originalBefore = (await c.query<MembershipRow>(
          "SELECT pa.id,pa.duty_id,pa.employee_id,pa.duty_function,pa.source FROM public.plan_assignments AS pa WHERE pa.company_id=$1 AND pa.id=$2 AND pa.state='ACTIVE' AND pa.removed_at IS NULL",
          [t.companyId, after.assignment_id],
        )).rows[0];
        if (!originalBefore) throw new Error('Original membership changed under selection locks');
        const duty = await c.query<DutyRow>(
          `UPDATE public.duties AS d SET concurrency_version=d.concurrency_version+1,updated_at=$3::timestamptz
           WHERE d.company_id=$1 AND d.id=$2 AND d.removed_at IS NULL RETURNING ${dutyColumns('d')}`,
          [t.companyId, after.duty_id, at],
        );
        if (duty.rowCount !== 1) throw new Error('Duty changed under selection locks');
        const closed = await c.query<MembershipRow & { removed_at: string }>(
          `UPDATE public.plan_assignments AS pa SET state='REMOVED',removed_at=$3::timestamptz,updated_at=$3::timestamptz
           WHERE pa.company_id=$1 AND pa.id=$2 AND pa.state='ACTIVE' AND pa.removed_at IS NULL
           RETURNING pa.id,pa.duty_id,pa.employee_id,pa.duty_function,pa.source,${removalColumn}`,
          [t.companyId, after.assignment_id, at],
        );
        if (closed.rowCount !== 1) throw new Error('Original membership changed under selection locks');
        const added = (await c.query<MembershipRow>(
          `INSERT INTO public.plan_assignments(company_id,duty_id,employee_id,duty_function,source,state,replacement_offer_id,created_at,updated_at)
           VALUES($1,$2,$3,$4,'REPLACEMENT','ACTIVE',$5,$6::timestamptz,$6::timestamptz)
           RETURNING id,duty_id,employee_id,duty_function,source`,
          [t.companyId, after.duty_id, after.candidate_id, after.duty_function, offerId, at],
        )).rows[0];
        const selectedRow = await c.query(
          "UPDATE public.replacement_offers SET status='SELECTED',decided_at=$3::timestamptz,updated_at=$3::timestamptz WHERE company_id=$1 AND id=$2 AND status='OPEN' RETURNING id",
          [t.companyId, offerId, at],
        );
        if (selectedRow.rowCount !== 1) throw new Error('Selected offer changed under selection locks');
        const rejected = await c.query<{ id: string }>(
          "UPDATE public.replacement_offers SET status='NOT_SELECTED',decided_at=$3::timestamptz,updated_at=$3::timestamptz WHERE company_id=$1 AND need_id=$2 AND status='OPEN' RETURNING id",
          [t.companyId, needId, at],
        );
        if (rejected.rowCount !== losing.length) throw new Error('Losing offers changed under selection locks');
        const cancelled = await c.query(
          "UPDATE public.cancellation_requests SET status='APPROVED',decided_at=$3::timestamptz,decided_by_account_id=$4,updated_at=$3::timestamptz WHERE company_id=$1 AND id=$2 AND status='OPEN' RETURNING id",
          [t.companyId, after.cancellation_id, at, t.accountId],
        );
        if (cancelled.rowCount !== 1) throw new Error('Cancellation changed under selection locks');
        const need = await c.query<{ v: string }>(
          "UPDATE public.replacement_needs SET status='RESOLVED',resolved_at=$3::timestamptz,updated_at=$3::timestamptz,selected_offer_id=$4,concurrency_version=concurrency_version+1 WHERE company_id=$1 AND id=$2 AND status='OPEN' RETURNING concurrency_version::text AS v",
          [t.companyId, needId, at, offerId],
        );
        if (need.rowCount !== 1) throw new Error('Need changed under selection locks');

        // Z: mandatory audit rows in the same transaction. Action names: the four SP-20 actions approved in ADR-0004 (SP-20 supplement) and the approved SP-12 duty names.
        const base = { companyId: t.companyId, actorAccountId: t.accountId, correlationId };
        await this.audit.recordBusinessAction(c, { ...base, action: 'CANCELLATION_APPROVED', resourceType: 'CANCELLATION_REQUEST', resourceId: after.cancellation_id, oldValues: { status: 'OPEN' }, newValues: { status: 'APPROVED' } });
        await this.audit.recordBusinessAction(c, { ...base, action: 'REPLACEMENT_NEED_RESOLVED', resourceType: 'REPLACEMENT_NEED', resourceId: needId, oldValues: { status: 'OPEN' }, newValues: { status: 'RESOLVED', selectedOfferId: offerId } });
        await this.audit.recordBusinessAction(c, { ...base, action: 'REPLACEMENT_OFFER_SELECTED', resourceType: 'REPLACEMENT_OFFER', resourceId: offerId, oldValues: { status: 'OPEN' }, newValues: { status: 'SELECTED' } });
        for (const o of rejected.rows) await this.audit.recordBusinessAction(c, { ...base, action: 'REPLACEMENT_OFFER_NOT_SELECTED', resourceType: 'REPLACEMENT_OFFER', resourceId: o.id, oldValues: { status: 'OPEN' }, newValues: { status: 'NOT_SELECTED' } });
        // SP-12 duty audit contract (ADR-0004): one DUTY_UPDATED with previous and resulting D, one removal and one addition with M.
        await this.audit.recordBusinessAction(c, {
          ...base, action: 'DUTY_UPDATED', resourceType: 'DUTY', resourceId: after.duty_id,
          oldValues: dutyValues(after.plan_id, dutyBefore), newValues: dutyValues(after.plan_id, duty.rows[0]),
        });
        await this.audit.recordBusinessAction(c, {
          ...base, action: 'DUTY_MEMBERSHIP_REMOVED', resourceType: 'DUTY_ASSIGNMENT', resourceId: originalBefore.id,
          oldValues: memberValues(originalBefore), newValues: { dutyId: after.duty_id, state: 'REMOVED', removedAt: closed.rows[0].removed_at },
        });
        await this.audit.recordBusinessAction(c, {
          ...base, action: 'DUTY_MEMBERSHIP_ADDED', resourceType: 'DUTY_ASSIGNMENT', resourceId: added.id, newValues: memberValues(added),
        });

        const done = await c.query(
          `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
           UPDATE public.idempotency_records SET state='COMPLETED',result_cancellation_request_id=$4,result_replacement_offer_id=$5,completed_at=moment.at,expires_at=moment.at+$6::int*interval '1 second' FROM moment
           WHERE company_id=$1 AND id=$2 AND attempt_id=$3 AND state='IN_PROGRESS'`,
          [t.companyId, claim.id, claim.attempt_id, after.cancellation_id, offerId, RETENTION],
        );
        if (done.rowCount !== 1) throw new Error('Selection completion lost its attempt fence');
        const response = await this.result(c, t.companyId, needId, after.cancellation_id, offerId);
        await assertSessionInTransaction(c, t);
        return { result: response, replayed: false };
      });
    } catch (error) {
      await this.database
        .withTransaction(async (c) => {
          await c.query(PLANNING_WRITER_TIMEOUTS);
          await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']);
          await assertSessionInTransaction(c, t);
          await reservationLock(c, lockId);
          await c.query(
            `UPDATE public.idempotency_records SET state='FAILED' WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 AND id=$5 AND attempt_id=$6 AND state='IN_PROGRESS'`,
            [t.companyId, t.accountId, OP, keyHash, claim.id, claim.attempt_id],
          );
        })
        .catch(() => {});
      throw error;
    }
  }
}
