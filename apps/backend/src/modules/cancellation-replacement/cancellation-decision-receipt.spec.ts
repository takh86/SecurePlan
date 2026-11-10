/** SP-21 S1 unit tests: fingerprint and strict receipt decoder (no database, no HTTP). */
import { createHash } from 'node:crypto';
import {
  decisionFingerprint,
  decodeDecisionReceipt,
  pgJsonTextBytes,
  replayDecisionReceipt,
  type DecisionReceiptV1,
} from './cancellation-decision-receipt.js';
import type { CommandReservation } from '../../common/transactions/command-reservation.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const duty = {
  id: '55555555-5555-4555-8555-555555555555',
  dutyDate: '2027-01-20',
  shiftKind: 'DAY' as const,
  startsAt: '2027-01-20T05:00:00Z',
  endsAt: '2027-01-20T17:00:00Z',
};
const approveReceipt = (): DecisionReceiptV1 => ({
  cancellation: {
    id: REQUEST,
    assignmentId: '33333333-3333-4333-8333-333333333333',
    employee: { id: '44444444-4444-4444-8444-444444444444', employeeCode: 'S-001', firstName: 'Synth', lastName: 'Etic' },
    duty: { ...duty },
    status: 'APPROVED',
    createdAt: '2026-12-15T12:00:00.000Z',
    decidedAt: '2026-12-15T13:00:00.000Z',
    replacementNeed: { id: '66666666-6666-4666-8666-666666666666', status: 'OPEN_UNFILLED', resolvedAt: null },
  },
  selectedOffer: null,
  updatedDuty: { ...duty, concurrencyVersion: 2 },
});
const rejectReceipt = (): DecisionReceiptV1 => {
  const r = approveReceipt();
  r.cancellation.status = 'REJECTED';
  r.cancellation.replacementNeed.status = 'CLOSED';
  r.updatedDuty = null;
  return r;
};
const sha = (v: unknown[]) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('decisionFingerprint', () => {
  it('APPROVE binds request, decision, null offer, need version and duty version', () => {
    expect(decisionFingerprint({ decision: 'APPROVE', requestId: REQUEST, needVersion: 3, dutyVersion: 7 }).toString('hex')).toBe(
      sha(['decide-cancellation-v1', REQUEST, 'APPROVE', null, 3, 7]),
    );
  });
  it('APPROVE changes with either version', () => {
    const base = decisionFingerprint({ decision: 'APPROVE', requestId: REQUEST, needVersion: 3, dutyVersion: 7 });
    expect(base.equals(decisionFingerprint({ decision: 'APPROVE', requestId: REQUEST, needVersion: 3, dutyVersion: 8 }))).toBe(false);
    expect(base.equals(decisionFingerprint({ decision: 'APPROVE', requestId: REQUEST, needVersion: 4, dutyVersion: 7 }))).toBe(false);
    expect(base.equals(decisionFingerprint({ decision: 'REJECT', requestId: REQUEST }))).toBe(false);
  });
  it('REJECT binds request, decision and null offer only, so an ignored Expected-Version cannot alter it', () => {
    const reject = decisionFingerprint({ decision: 'REJECT', requestId: REQUEST });
    expect(reject.toString('hex')).toBe(sha(['decide-cancellation-v1', REQUEST, 'REJECT', null]));
    // A caller that (wrongly) passed a header value through cannot change the result.
    const withHeader = decisionFingerprint({ decision: 'REJECT', requestId: REQUEST, needVersion: 9 } as never);
    expect(withHeader.equals(reject)).toBe(true);
  });
  it('normalizes UUID case and refuses malformed input', () => {
    expect(decisionFingerprint({ decision: 'REJECT', requestId: REQUEST.toUpperCase() }).equals(decisionFingerprint({ decision: 'REJECT', requestId: REQUEST }))).toBe(true);
    for (const bad of [
      { decision: 'REJECT', requestId: 'not-a-uuid' },
      { decision: 'APPROVE', requestId: REQUEST, needVersion: 0, dutyVersion: 1 },
      { decision: 'APPROVE', requestId: REQUEST, needVersion: 1, dutyVersion: 1.5 },
      { decision: 'APPROVE', requestId: REQUEST, needVersion: 1, dutyVersion: Number.MAX_SAFE_INTEGER + 1 },
      { decision: 'APPROVE', requestId: REQUEST, needVersion: 1 },
      { decision: 'OTHER', requestId: REQUEST },
    ])
      expect(() => decisionFingerprint(bad as never)).toThrow();
  });
});

describe('decodeDecisionReceipt', () => {
  it('accepts valid APPROVE and REJECT receipts', () => {
    expect(decodeDecisionReceipt(approveReceipt(), REQUEST)).toEqual(approveReceipt());
    expect(decodeDecisionReceipt(rejectReceipt(), REQUEST.toUpperCase())).toEqual(rejectReceipt());
  });
  const mutations: [string, (r: any) => void][] = [
    ['extra top-level key', (r) => (r.debug = 1)],
    ['missing updatedDuty (missing is not null)', (r) => delete r.updatedDuty],
    ['selectedOffer object', (r) => (r.selectedOffer = { id: REQUEST })],
    ['email in employee', (r) => (r.cancellation.employee.email = 'x@example.invalid')],
    ['absence reason in cancellation', (r) => (r.cancellation.reason = 'sick')],
    ['missing decidedAt', (r) => delete r.cancellation.decidedAt],
    ['null decidedAt', (r) => (r.cancellation.decidedAt = null)],
    ['non-UUID assignment', (r) => (r.cancellation.assignmentId = 'abc')],
    ['upper-case UUID stored', (r) => (r.cancellation.employee.id = 'ABCDEF44-4444-4444-8444-444444444444')],
    ['bad timestamp', (r) => (r.cancellation.createdAt = '2026-12-15T12:00:00Z')],
    ['APPROVED with CLOSED need', (r) => (r.cancellation.replacementNeed.status = 'CLOSED')],
    ['APPROVED without updatedDuty', (r) => (r.updatedDuty = null)],
    ['resolvedAt set', (r) => (r.cancellation.replacementNeed.resolvedAt = '2026-12-15T13:00:00.000Z')],
    ['updatedDuty of another duty', (r) => (r.updatedDuty.id = '77777777-7777-4777-8777-777777777777')],
    ['updatedDuty with changed times', (r) => (r.updatedDuty.startsAt = '2027-01-20T06:00:00Z')],
    ['duty version 1 after an increment', (r) => (r.updatedDuty.concurrencyVersion = 1)],
    ['fractional duty version', (r) => (r.updatedDuty.concurrencyVersion = 2.5)],
    ['string duty version', (r) => (r.updatedDuty.concurrencyVersion = '2')],
    ['unsafe duty version', (r) => (r.updatedDuty.concurrencyVersion = Number.MAX_SAFE_INTEGER + 1)],
    ['WITHDRAWN status', (r) => (r.cancellation.status = 'WITHDRAWN')],
    ['TAG shift kind', (r) => (r.cancellation.duty.shiftKind = 'TAG')],
    ['employee null', (r) => (r.cancellation.employee = null)],
  ];
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const r = approveReceipt();
    mutate(r);
    expect(() => decodeDecisionReceipt(r, REQUEST)).toThrow('Invalid cancellation decision receipt');
  });
  it('rejects REJECTED with an updatedDuty', () => {
    const r = rejectReceipt() as any;
    r.updatedDuty = { ...duty, concurrencyVersion: 2 };
    expect(() => decodeDecisionReceipt(r, REQUEST)).toThrow('status pairing');
  });
  it('binds the receipt to the expected cancellation', () => {
    expect(() => decodeDecisionReceipt(approveReceipt(), '22222222-2222-4222-8222-222222222222')).toThrow('cancellation.id');
  });
  it('bounds PostgreSQL JSON text at 8192 bytes, counting multi-byte UTF-8', () => {
    const fill = (n: number) => {
      const r = approveReceipt();
      r.cancellation.employee.lastName = '';
      const base = pgJsonTextBytes(r);
      // '€' is 3 bytes; pad the remainder with 1-byte characters.
      const target = n - base;
      r.cancellation.employee.lastName = '€'.repeat(Math.floor(target / 3)) + 'a'.repeat(target % 3);
      return r;
    };
    expect(pgJsonTextBytes(fill(8192))).toBe(8192);
    expect(decodeDecisionReceipt(fill(8192), REQUEST)).toBeTruthy();
    expect(pgJsonTextBytes(fill(8193))).toBe(8193);
    expect(() => decodeDecisionReceipt(fill(8193), REQUEST)).toThrow('size');
  });
});

describe('replayDecisionReceipt', () => {
  const prior = (over: Partial<CommandReservation> = {}): CommandReservation => ({
    id: 'r', attempt_id: 'a', state: 'COMPLETED', request_hash: Buffer.alloc(32), result_plan_id: null,
    result_cancellation_request_id: REQUEST, result_json: approveReceipt(), result_schema_version: 1,
    unexpired: true, stale: false, ...over,
  });
  it('returns the stored snapshot', () => expect(replayDecisionReceipt(prior(), REQUEST)).toEqual(approveReceipt()));
  it.each([
    ['schema version 2', { result_schema_version: 2 }],
    ['missing schema version', { result_schema_version: null }],
    ['other typed result', { result_cancellation_request_id: '22222222-2222-4222-8222-222222222222' }],
    ['not completed', { state: 'FAILED' }],
    ['no snapshot', { result_json: null }],
  ])('fails closed on %s', (_n, over) => {
    expect(() => replayDecisionReceipt(prior(over as Partial<CommandReservation>), REQUEST)).toThrow('Invalid cancellation decision receipt');
  });
});
