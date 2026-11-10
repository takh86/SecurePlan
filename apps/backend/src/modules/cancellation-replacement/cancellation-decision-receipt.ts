/**
 * SP-21 S1: idempotency contract of the cancellation decision command (DECIDE_CANCELLATION).
 *
 * - Fingerprint: APPROVE binds request, decision, null offer, need version and duty version.
 *   REJECT binds request, decision and null offer only; an optional Expected-Version header on
 *   REJECT is syntax-checked by the controller and never reaches this function.
 * - Receipt: the decision-time response body, stored once in idempotency_records.result_json
 *   (schema version 1, at most 8192 bytes of PostgreSQL JSON text) by the fenced completion
 *   statement. The first 200 and every same-key replay are decoded from that stored snapshot.
 *   Nothing is rebuilt from mutable business rows.
 * - Immutability is enforced by the attempt fence (IN_PROGRESS + attempt_id), not by triggers.
 *   Database CHECKs (migration 0020) enforce structure only.
 *
 * S1 provides the contract only. The decision service, route and audits are S2/S3.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import type { CommandClaim, CommandReservation } from '../../common/transactions/command-reservation.js';
import type { CancellationResponse } from './cancellation.types.js';

export const DECIDE_CANCELLATION = 'DECIDE_CANCELLATION';
export const DECISION_RECEIPT_SCHEMA_VERSION = 1;
export const DECISION_RECEIPT_MAX_BYTES = 8192;
export const DECISION_RETENTION_SECONDS = 86400;
export const DECISION_STALE_SECONDS = 300;

export type DecisionFingerprintInput =
  | { decision: 'APPROVE'; requestId: string; needVersion: number; dutyVersion: number }
  | { decision: 'REJECT'; requestId: string };

export type DecisionDuty = CancellationResponse['duty'];
export type DecisionReceiptV1 = {
  cancellation: CancellationResponse & { status: 'APPROVED' | 'REJECTED' };
  selectedOffer: null;
  updatedDuty: (DecisionDuty & { concurrencyVersion: number }) | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const INSTANT_MS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const INSTANT_S = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

const isVersion = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/** SHA-256 over the canonical JSON array. Throws on anything outside the contract. */
export function decisionFingerprint(input: DecisionFingerprintInput): Buffer {
  const requestId = typeof input.requestId === 'string' ? input.requestId.toLowerCase() : '';
  if (!UUID.test(requestId)) throw new Error('Invalid decision fingerprint request id');
  let canonical: unknown[];
  if (input.decision === 'APPROVE') {
    if (!isVersion(input.needVersion, 1) || !isVersion(input.dutyVersion, 1))
      throw new Error('Invalid decision fingerprint version');
    canonical = ['decide-cancellation-v1', requestId, 'APPROVE', null, input.needVersion, input.dutyVersion];
  } else if (input.decision === 'REJECT') {
    canonical = ['decide-cancellation-v1', requestId, 'REJECT', null];
  } else throw new Error('Invalid decision fingerprint decision');
  return createHash('sha256').update(JSON.stringify(canonical)).digest();
}

/**
 * Exact UTF-8 length of PostgreSQL's jsonb text output (`result_json::text`), which separates
 * members with ", " and keys from values with ": ". Key order does not change the length.
 */
export function pgJsonTextBytes(value: unknown): number {
  const render = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(render).join(', ')}]`;
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${render(x)}`).join(', ')}}`;
  };
  return Buffer.byteLength(render(value), 'utf8');
}

class ReceiptError extends Error {
  constructor(where: string) {
    super(`Invalid cancellation decision receipt: ${where}`);
  }
}
type Obj = Record<string, unknown>;
/** Closed object: every key present (null is a value, missing is not) and no other key. */
function closed(value: unknown, keys: readonly string[], where: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReceiptError(where);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((k) => Object.hasOwn(value, k))) throw new ReceiptError(where);
  return value as Obj;
}
function text(value: unknown, where: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) throw new ReceiptError(where);
  return value;
}

function decodeDuty(value: unknown, where: string, withVersion: boolean): Obj {
  const keys = ['id', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt', ...(withVersion ? ['concurrencyVersion'] : [])];
  const duty = closed(value, keys, where);
  text(duty.id, `${where}.id`, UUID);
  text(duty.dutyDate, `${where}.dutyDate`, DATE);
  if (duty.shiftKind !== 'DAY' && duty.shiftKind !== 'NIGHT') throw new ReceiptError(`${where}.shiftKind`);
  text(duty.startsAt, `${where}.startsAt`, INSTANT_S);
  text(duty.endsAt, `${where}.endsAt`, INSTANT_S);
  // A decision increments the duty from at least version 1, so the stored result is at least 2.
  if (withVersion && !isVersion(duty.concurrencyVersion, 2)) throw new ReceiptError(`${where}.concurrencyVersion`);
  return duty;
}

/**
 * Strict decoder shared by the first response and every replay. It mirrors the 0020 CHECK and
 * additionally binds the receipt to the expected cancellation (resource identity).
 */
export function decodeDecisionReceipt(value: unknown, expectedCancellationId: string): DecisionReceiptV1 {
  const root = closed(value, ['cancellation', 'selectedOffer', 'updatedDuty'], 'root');
  if (root.selectedOffer !== null) throw new ReceiptError('selectedOffer');
  const c = closed(
    root.cancellation,
    ['id', 'assignmentId', 'employee', 'duty', 'status', 'createdAt', 'decidedAt', 'replacementNeed'],
    'cancellation',
  );
  if (text(c.id, 'cancellation.id', UUID) !== expectedCancellationId.toLowerCase())
    throw new ReceiptError('cancellation.id');
  text(c.assignmentId, 'cancellation.assignmentId', UUID);
  text(c.createdAt, 'cancellation.createdAt', INSTANT_MS);
  text(c.decidedAt, 'cancellation.decidedAt', INSTANT_MS);
  const employee = closed(c.employee, ['id', 'employeeCode', 'firstName', 'lastName'], 'cancellation.employee');
  text(employee.id, 'cancellation.employee.id', UUID);
  text(employee.employeeCode, 'cancellation.employee.employeeCode');
  text(employee.firstName, 'cancellation.employee.firstName');
  text(employee.lastName, 'cancellation.employee.lastName');
  const duty = decodeDuty(c.duty, 'cancellation.duty', false);
  const need = closed(c.replacementNeed, ['id', 'status', 'resolvedAt'], 'cancellation.replacementNeed');
  text(need.id, 'cancellation.replacementNeed.id', UUID);
  if (need.resolvedAt !== null) throw new ReceiptError('cancellation.replacementNeed.resolvedAt');
  if (c.status === 'APPROVED') {
    if (need.status !== 'OPEN_UNFILLED') throw new ReceiptError('status pairing');
    const updated = decodeDuty(root.updatedDuty, 'updatedDuty', true);
    for (const k of ['id', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt'])
      if (updated[k] !== duty[k]) throw new ReceiptError(`updatedDuty.${k}`);
  } else if (c.status === 'REJECTED') {
    if (need.status !== 'CLOSED' || root.updatedDuty !== null) throw new ReceiptError('status pairing');
  } else throw new ReceiptError('cancellation.status');
  if (pgJsonTextBytes(value) > DECISION_RECEIPT_MAX_BYTES) throw new ReceiptError('size');
  return value as DecisionReceiptV1;
}

/**
 * Stores the snapshot and completes the attempt in ONE fenced statement, inside the caller's
 * final business transaction. `expectedCancellationRequestId` is the request id of the reserved
 * command (the one that was fingerprinted), supplied independently by the caller; it is never
 * inferred from the receipt. A receipt for any other cancellation is refused before any write.
 * The returned receipt (decoded from RETURNING) is the first 200 body.
 * Zero rows means the attempt lost its fence (stale reclaim, already completed, other actor or
 * tenant); the caller's transaction must then roll back.
 */
export async function completeDecisionReceipt(
  c: PoolClient,
  t: TenantContext,
  claim: CommandClaim,
  expectedCancellationRequestId: string,
  receipt: DecisionReceiptV1,
): Promise<DecisionReceiptV1> {
  const cancellationId = typeof expectedCancellationRequestId === 'string' ? expectedCancellationRequestId.toLowerCase() : '';
  if (!UUID.test(cancellationId)) throw new ReceiptError('expected cancellation id');
  // Resource binding: validated against the command's request id BEFORE the completion UPDATE.
  decodeDecisionReceipt(receipt, cancellationId);
  const done = await c.query<{ result_json: unknown }>(
    `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
     UPDATE public.idempotency_records SET state='COMPLETED',result_cancellation_request_id=$5,
       result_json=$6::jsonb,result_schema_version=1,completed_at=moment.at,
       expires_at=moment.at+$7::int*interval '1 second'
     FROM moment
     WHERE company_id=$1 AND actor_account_id=$2 AND operation='DECIDE_CANCELLATION'
       AND id=$3 AND attempt_id=$4 AND state='IN_PROGRESS'
     RETURNING result_json`,
    [t.companyId, t.accountId, claim.id, claim.attempt_id, cancellationId, JSON.stringify(receipt), DECISION_RETENTION_SECONDS],
  );
  if (done.rowCount !== 1) throw new Error('Cancellation decision completion lost its attempt fence');
  return decodeDecisionReceipt(done.rows[0].result_json, cancellationId);
}

/** Replay of an unexpired COMPLETED reservation: the stored snapshot only, never a rebuild. */
export function replayDecisionReceipt(prior: CommandReservation, requestId: string): DecisionReceiptV1 {
  if (prior.state !== 'COMPLETED' || prior.result_schema_version !== DECISION_RECEIPT_SCHEMA_VERSION)
    throw new ReceiptError('schema version');
  if (prior.result_cancellation_request_id !== requestId.toLowerCase()) throw new ReceiptError('resource identity');
  return decodeDecisionReceipt(prior.result_json, requestId);
}
