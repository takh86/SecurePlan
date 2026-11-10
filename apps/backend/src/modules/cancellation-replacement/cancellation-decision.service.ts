/**
 * SP-21 S2: administrative cancellation decision (REJECT, or APPROVE without a replacement).
 *
 * One reservation transaction (A/C, concealment, I claim) and one business transaction under the
 * global lock order of ADR-0006 (only the ranks this command needs, strictly ascending):
 *   A/C accounts+company -> I reservation -> E original employee -> P project -> L plan
 *   -> D duty -> A2 original membership -> Q edit leases (APPROVE only) -> W1 cancellation
 *   -> W2 need -> W3 offers -> Z audit + receipt completion.
 * Discovery is read-only and only names the rows to lock; every decision is re-taken under the locks.
 *
 * Idempotency: S1 contract (DECIDE_CANCELLATION). The request id always comes from the validated
 * command, never from the receipt. The first 200 and every same-key replay are the stored
 * decision-time snapshot. No automatic business retry: a failure marks the attempt FAILED.
 *
 * No route, DTO or OpenAPI here (S3).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import { assertSessionInTransaction } from '../../auth/session.service.js';
import { reserveCommand } from '../../common/transactions/command-reservation.js';
import { lockAttempt, reservationLock } from '../../common/transactions/idempotency-lock.js';
import { DatabaseService } from '../../database/database.service.js';
import { BusinessAuditService } from '../audit/business-audit.service.js';
import { lockAccountsPrefix } from '../identity/account-prefix-lock.js';
import { cancellationContext, lockCancellationContext, type CancellationContext } from '../planning/cancellation-context.js';
import { dutyValues, memberValues, removalColumn } from '../planning/duty-audit-values.js';
import { assertEmployeeMonthReceiptSchema } from '../planning/employee-month-receipt-schema.js';
import { dutyColumns, type DutyRow, type MembershipRow } from '../planning/monthly-plan.mapper.js';
import { PLANNING_WRITER_TIMEOUTS } from '../planning/planning-locks.js';
import { assertPlanningSchemaComplete } from '../planning/planning-schema.js';
import { employeeSummary } from '../workforce/employees/employee-context.js';
import {
  completeDecisionReceipt,
  decisionFingerprint,
  DECIDE_CANCELLATION,
  DECISION_RETENTION_SECONDS,
  DECISION_STALE_SECONDS,
  replayDecisionReceipt,
  type DecisionReceiptV1,
} from './cancellation-decision-receipt.js';
import { assertUnresolvedOffers, lockReplacementOffers } from './replacement-offer-invalidation.js';

export type CancellationDecisionCommand =
  | { decision: 'APPROVE'; requestId: string; expectedNeedVersion: number; expectedDutyVersion: number; replacementOfferId?: null }
  | { decision: 'REJECT'; requestId: string; replacementOfferId?: null };

const ALLOWED_KEYS = {
  APPROVE: ['decision', 'requestId', 'expectedNeedVersion', 'expectedDutyVersion', 'replacementOfferId'],
  REJECT: ['decision', 'requestId', 'replacementOfferId'],
} as const;
const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/**
 * Runtime validation at the service boundary (TypeScript unions are not runtime checks). Fail closed: only the exact
 * APPROVE and REJECT shapes pass; anything else is 400 VALIDATION_FAILED before any database access, so it can create
 * no idempotency claim, business write or audit. A non-null replacementOfferId is refused (offer selection is SP-20);
 * REJECT carries no version (an optional Expected-Version header is syntax-checked by the S3 route and never reaches
 * here). requestId format is left to the 404 concealment path.
 */
export function validateDecisionCommand(input: unknown): CancellationDecisionCommand {
  const invalid = () => new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid();
  const c = input as Record<string, unknown>;
  const decision = c.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw invalid();
  const allowed: readonly string[] = ALLOWED_KEYS[decision];
  if (Object.keys(c).some((k) => !allowed.includes(k))) throw invalid();
  if (c.replacementOfferId !== undefined && c.replacementOfferId !== null) throw invalid();
  if (typeof c.requestId !== 'string') throw invalid();
  if (decision === 'REJECT') return { decision, requestId: c.requestId };
  if (!isVersion(c.expectedNeedVersion) || !isVersion(c.expectedDutyVersion)) throw invalid();
  return { decision, requestId: c.requestId, expectedNeedVersion: c.expectedNeedVersion, expectedDutyVersion: c.expectedDutyVersion };
}
export type CancellationDecisionResult = { result: DecisionReceiptV1; replayed: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (s: string) => createHash('sha256').update(s).digest();

type Discovered = { id: string; assignment_id: string; employee_id: string; duty_id: string; context: CancellationContext };
type CaseRow = { id: string; assignment_id: string; duty_id: string; employee_id: string; status: string; created_at: Date };
type NeedRow = { id: string; duty_id: string; status: string; version: string };

@Injectable()
export class CancellationDecisionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
  ) {}

  private async enter(c: PoolClient, t: TenantContext) {
    await c.query(PLANNING_WRITER_TIMEOUTS);
    await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']); // A/C; 403 for any other live role
    await assertSessionInTransaction(c, t);
    await assertPlanningSchemaComplete(c);
    await assertEmployeeMonthReceiptSchema(c);
  }

  /** Read-only discovery. Unknown and other-tenant cases are indistinguishable (404). */
  private async discover(c: PoolClient, companyId: string, requestId: string): Promise<Discovered> {
    const row = (
      await c.query<Omit<Discovered, 'context'>>(
        'SELECT id,assignment_id,employee_id,duty_id FROM public.cancellation_requests WHERE company_id=$1 AND id=$2',
        [companyId, requestId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    const context = await cancellationContext(c, companyId, row.assignment_id);
    if (context.duty_id !== row.duty_id || context.employee_id !== row.employee_id)
      throw new Error('Inconsistent cancellation planning context');
    return { ...row, context };
  }

  async decide(t: TenantContext, input: CancellationDecisionCommand, key: string, correlationId: string): Promise<CancellationDecisionResult> {
    // First statement: every later branch uses the validated variant, never the raw input.
    const command = validateDecisionCommand(input);
    if (typeof key !== 'string' || key.length === 0) throw new Error('Idempotency key required');
    // The expected resource is the validated command input; it is never taken from a receipt.
    const requestId = typeof command.requestId === 'string' ? command.requestId.toLowerCase() : '';
    if (!UUID.test(requestId)) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    const requestHash = decisionFingerprint(
      command.decision === 'APPROVE'
        ? { decision: 'APPROVE', requestId, needVersion: command.expectedNeedVersion, dutyVersion: command.expectedDutyVersion }
        : { decision: 'REJECT', requestId },
    );
    const keyHash = digest(key);
    const lockId = digest(JSON.stringify(['decide-cancellation-v1', t.companyId, t.accountId, DECIDE_CANCELLATION, keyHash.toString('hex')]))
      .readBigInt64BE()
      .toString();

    // Reservation: concealment before the key is inspected, then the durable claim. Refusals write nothing.
    const reserved = await this.database.withTransaction(async (c) => {
      await this.enter(c, t);
      await this.discover(c, t.companyId, requestId);
      return reserveCommand(c, {
        tenant: t,
        operation: DECIDE_CANCELLATION,
        keyHash,
        requestHash,
        lockId,
        retention: DECISION_RETENTION_SECONDS,
        stale: DECISION_STALE_SECONDS,
        beforeWrite: async () => {
          await assertSessionInTransaction(c, t);
          await this.discover(c, t.companyId, requestId);
        },
        replay: async (prior) => {
          const snapshot = replayDecisionReceipt(prior, requestId);
          await assertSessionInTransaction(c, t);
          return snapshot;
        },
      });
    });
    if ('result' in reserved) return { result: reserved.result, replayed: true };
    const claim = reserved.claim;

    try {
      return await this.database.withTransaction(async (c) => {
        await this.enter(c, t);
        const before = await this.discover(c, t.companyId, requestId);
        await reservationLock(c, lockId);
        await lockAttempt(c, t.companyId, t.accountId, DECIDE_CANCELLATION, keyHash, claim.id, claim.attempt_id);
        // E: the original employee only (no candidate for a no-offer decision), as ADR-0006 employee writers do.
        await c.query('SELECT id FROM public.employees WHERE company_id=$1 AND id=$2 FOR NO KEY UPDATE', [t.companyId, before.employee_id]);
        // P SHARE -> L SHARE -> D UPDATE -> A2 UPDATE (SP-17 envelope, TL-4).
        const context = await lockCancellationContext(c, t, before.context);
        // Q: only APPROVE writes the duty, so only APPROVE takes the lease tier.
        if (command.decision === 'APPROVE')
          await c.query('SELECT id FROM public.edit_leases WHERE company_id=$1 AND duty_id=$2 ORDER BY id FOR UPDATE', [t.companyId, context.duty_id]);
        // W1 -> W2 -> W3. Never filter by an unlocked status: lock, then inspect.
        const cases = (
          await c.query<CaseRow>(
            'SELECT id,assignment_id,duty_id,employee_id,status,created_at FROM public.cancellation_requests WHERE company_id=$1 AND id=$2 ORDER BY id FOR UPDATE',
            [t.companyId, requestId],
          )
        ).rows;
        const needs = (
          await c.query<NeedRow>(
            'SELECT id,duty_id,status,concurrency_version::text AS version FROM public.replacement_needs WHERE company_id=$1 AND cancellation_request_id=$2 ORDER BY id FOR UPDATE',
            [t.companyId, requestId],
          )
        ).rows;
        const offers = await lockReplacementOffers(c, t.companyId, needs.map((n) => n.id));
        // Fresh database clock after every business-lock wait.
        await assertSessionInTransaction(c, t);

        const row = cases[0],
          need = needs[0];
        if (
          cases.length !== 1 || needs.length !== 1 ||
          row.assignment_id !== before.assignment_id || row.employee_id !== before.employee_id ||
          row.duty_id !== context.duty_id || need.duty_id !== row.duty_id || context.employee_id !== row.employee_id
        )
          throw new Error('Inconsistent cancellation decision context');
        const validPair =
          row.status === 'OPEN'
            ? need.status === 'OPEN'
            : row.status === 'APPROVED'
              ? ['RESOLVED', 'OPEN_UNFILLED'].includes(need.status)
              : ['WITHDRAWN', 'REJECTED', 'OBSOLETE'].includes(row.status) && need.status === 'CLOSED';
        if (!validPair) throw new Error('Inconsistent cancellation and replacement need');

        // Precedence: case state, then versions, then planning guards, then lease.
        if (row.status !== 'OPEN')
          throw new ConflictException({ code: need.status === 'CLOSED' ? 'REPLACEMENT_NEED_NOT_OPEN' : 'CANCELLATION_ALREADY_RESOLVED' });
        assertUnresolvedOffers(offers); // a SELECTED offer under an OPEN case is corrupt state: fail closed
        if (command.decision === 'APPROVE') {
          if (Number(need.version) !== command.expectedNeedVersion || Number(context.version) !== command.expectedDutyVersion)
            throw new ConflictException({ code: 'PLAN_CONCURRENT_MODIFICATION' });
        }
        if (context.duty_removed_at !== null || context.plan_status !== 'PUBLISHED' || !['ACTIVE', 'INACTIVE'].includes(context.project_status))
          throw new ConflictException({ code: 'CANCELLATION_PLAN_CHANGED' });
        if (context.state !== 'ACTIVE' || context.removed_at !== null)
          throw new ConflictException({ code: 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE' });
        if (command.decision === 'APPROVE') {
          const live = (
            await c.query<{ live: boolean }>(
              'SELECT EXISTS(SELECT 1 FROM public.edit_leases WHERE company_id=$1 AND duty_id=$2 AND released_at IS NULL AND expires_at>clock_timestamp()) AS live',
              [t.companyId, context.duty_id],
            )
          ).rows[0].live;
          if (live) throw new ConflictException({ code: 'RESOURCE_EDIT_LOCKED' });
        }

        // Writes: one database instant for every change of this command; every rowCount is asserted.
        const at = (await c.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0].at;
        const approve = command.decision === 'APPROVE';
        let dutyBefore: DutyRow | undefined, dutyAfter: DutyRow | undefined;
        let originalBefore: MembershipRow | undefined, removedAt: string | undefined;
        if (approve) {
          dutyBefore = (
            await c.query<DutyRow>(`SELECT ${dutyColumns('d')} FROM public.duties AS d WHERE d.company_id=$1 AND d.id=$2 AND d.removed_at IS NULL`, [
              t.companyId,
              context.duty_id,
            ])
          ).rows[0];
          originalBefore = (
            await c.query<MembershipRow>(
              "SELECT pa.id,pa.duty_id,pa.employee_id,pa.duty_function,pa.source FROM public.plan_assignments AS pa WHERE pa.company_id=$1 AND pa.id=$2 AND pa.state='ACTIVE' AND pa.removed_at IS NULL",
              [t.companyId, context.assignment_id],
            )
          ).rows[0];
          if (!dutyBefore || !originalBefore) throw new Error('Duty or membership changed under decision locks');
          const duty = await c.query<DutyRow>(
            `UPDATE public.duties AS d SET concurrency_version=d.concurrency_version+1,updated_at=$3::timestamptz
             WHERE d.company_id=$1 AND d.id=$2 AND d.removed_at IS NULL AND d.concurrency_version=$4 RETURNING ${dutyColumns('d')}`,
            [t.companyId, context.duty_id, at, command.expectedDutyVersion],
          );
          if (duty.rowCount !== 1) throw new Error('Duty changed under decision locks');
          dutyAfter = duty.rows[0];
          const closed = await c.query<{ removed_at: string }>(
            `UPDATE public.plan_assignments AS pa SET state='REMOVED',removed_at=$3::timestamptz,updated_at=$3::timestamptz
             WHERE pa.company_id=$1 AND pa.id=$2 AND pa.state='ACTIVE' AND pa.removed_at IS NULL RETURNING ${removalColumn}`,
            [t.companyId, context.assignment_id, at],
          );
          if (closed.rowCount !== 1) throw new Error('Original membership changed under decision locks');
          removedAt = closed.rows[0].removed_at;
        }
        const open = offers.filter((o) => o.status === 'OPEN');
        if (open.length > 0) {
          const finalized = await c.query(
            "UPDATE public.replacement_offers SET status='NOT_SELECTED',decided_at=$3::timestamptz,updated_at=$3::timestamptz WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='OPEN'",
            [t.companyId, open.map((o) => o.id), at],
          );
          if (finalized.rowCount !== open.length) throw new Error('Offers changed under decision locks');
        }
        const status = approve ? 'APPROVED' : 'REJECTED';
        const decided = await c.query<{ decided_at: Date }>(
          "UPDATE public.cancellation_requests SET status=$5,decided_at=$3::timestamptz,decided_by_account_id=$4,updated_at=$3::timestamptz WHERE company_id=$1 AND id=$2 AND status='OPEN' RETURNING decided_at",
          [t.companyId, requestId, at, t.accountId, status],
        );
        if (decided.rowCount !== 1) throw new Error('Cancellation changed under decision locks');
        const needStatus = approve ? 'OPEN_UNFILLED' : 'CLOSED';
        const needChanged = await c.query(
          `UPDATE public.replacement_needs SET status=$5,updated_at=$3::timestamptz,concurrency_version=concurrency_version+1
           WHERE company_id=$1 AND id=$2 AND cancellation_request_id=$4 AND status='OPEN' AND selected_offer_id IS NULL AND resolved_at IS NULL
             AND concurrency_version=$6`,
          [t.companyId, need.id, at, requestId, needStatus, need.version],
        );
        if (needChanged.rowCount !== 1) throw new Error('Need changed under decision locks');

        // Z: approved ADR-0004 SP-21 events, need before its offers; REJECT 2+k, APPROVE 4+k.
        const base = { companyId: t.companyId, actorAccountId: t.accountId, correlationId };
        await this.audit.recordBusinessAction(c, {
          ...base, action: approve ? 'CANCELLATION_APPROVED' : 'CANCELLATION_REJECTED', resourceType: 'CANCELLATION_REQUEST',
          resourceId: requestId, oldValues: { status: 'OPEN' }, newValues: { status },
        });
        await this.audit.recordBusinessAction(c, {
          ...base, action: approve ? 'REPLACEMENT_NEED_OPEN_UNFILLED' : 'REPLACEMENT_NEED_CLOSED', resourceType: 'REPLACEMENT_NEED',
          resourceId: need.id, oldValues: { status: 'OPEN' }, newValues: { status: needStatus },
        });
        for (const offer of open)
          await this.audit.recordBusinessAction(c, {
            ...base, action: 'REPLACEMENT_OFFER_NOT_SELECTED', resourceType: 'REPLACEMENT_OFFER',
            resourceId: offer.id, oldValues: { status: 'OPEN' }, newValues: { status: 'NOT_SELECTED' },
          });
        if (approve && dutyBefore && dutyAfter && originalBefore) {
          // SP-12 duty audit contract (ADR-0004), reused unchanged.
          await this.audit.recordBusinessAction(c, {
            ...base, action: 'DUTY_UPDATED', resourceType: 'DUTY', resourceId: context.duty_id,
            oldValues: dutyValues(context.plan_id, dutyBefore), newValues: dutyValues(context.plan_id, dutyAfter),
          });
          await this.audit.recordBusinessAction(c, {
            ...base, action: 'DUTY_MEMBERSHIP_REMOVED', resourceType: 'DUTY_ASSIGNMENT', resourceId: originalBefore.id,
            oldValues: memberValues(originalBefore), newValues: { dutyId: context.duty_id, state: 'REMOVED', removedAt },
          });
        }

        // Decision-time snapshot, built once from values read or written under this transaction's locks.
        const duty = { id: context.duty_id, dutyDate: context.dutyDate, shiftKind: context.shiftKind, startsAt: context.startsAt, endsAt: context.endsAt };
        const receipt: DecisionReceiptV1 = {
          cancellation: {
            id: requestId,
            assignmentId: row.assignment_id,
            employee: await employeeSummary(c, t.companyId, row.employee_id),
            duty,
            status,
            createdAt: row.created_at.toISOString(),
            decidedAt: decided.rows[0].decided_at.toISOString(),
            replacementNeed: { id: need.id, status: needStatus, resolvedAt: null },
          },
          selectedOffer: null,
          updatedDuty: approve && dutyAfter ? { ...duty, concurrencyVersion: Number(dutyAfter.version) } : null,
        };
        await assertSessionInTransaction(c, t); // last recheck before completion
        const result = await completeDecisionReceipt(c, t, claim, requestId, receipt);
        return { result, replayed: false };
      });
    } catch (error) {
      // No automatic replay of a human decision. Mark this attempt FAILED only if it is still IN_PROGRESS.
      await this.database
        .withTransaction(async (c) => {
          await c.query(PLANNING_WRITER_TIMEOUTS);
          await lockAccountsPrefix(c, t, ['COMPANY_ADMIN']);
          await assertSessionInTransaction(c, t);
          await reservationLock(c, lockId);
          await c.query(
            "UPDATE public.idempotency_records SET state='FAILED' WHERE company_id=$1 AND actor_account_id=$2 AND operation=$3 AND key_hash=$4 AND id=$5 AND attempt_id=$6 AND state='IN_PROGRESS'",
            [t.companyId, t.accountId, DECIDE_CANCELLATION, keyHash, claim.id, claim.attempt_id],
          );
        })
        .catch(() => {});
      throw error;
    }
  }
}
