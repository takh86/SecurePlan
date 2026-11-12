import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import type { SessionRequest } from '../../auth/session-api';
import { createWorkQueueApi, parseDecisionReceipt, parseOffersPage, type DecisionInput } from './work-queue-api';
import { CANCELLATION_ID, NEED_ID, caseContext, decisionReceipt, offersPage, recordingApi } from './work-queue.test-support';

function expectInvalid(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('invalid-response');
    return;
  }
  throw new Error('expected invalid-response');
}

const KEY = 'key-00000001';
const REJECT: DecisionInput = { decision: 'REJECT', idempotencyKey: KEY };
const APPROVE: DecisionInput = { decision: 'APPROVE', expectedNeedVersion: 1, expectedDutyVersion: 4, idempotencyKey: KEY };
const TARGET = { requestId: CANCELLATION_ID, needId: NEED_ID };

describe('SP-21 S5-READ-01: duty version in the case context', () => {
  const query = { status: null, page: 1 };
  const pageWith = (need: Record<string, unknown>) => ({ ...offersPage([]), context: { ...caseContext(), need } });

  it('keeps the duty version separate from the need version', () => {
    expect(parseOffersPage(offersPage([]), NEED_ID, query).context.need).toMatchObject({ concurrencyVersion: 1, dutyConcurrencyVersion: 4 });
  });

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '4'],
    ['unsafe', 2 ** 53],
  ])('rejects a %s duty version instead of guessing one', (_name, value) => {
    const need: Record<string, unknown> = { ...caseContext().need };
    if (value === undefined) delete need.dutyConcurrencyVersion;
    else need.dutyConcurrencyVersion = value;
    expectInvalid(() => parseOffersPage(pageWith(need), NEED_ID, query));
  });
});

describe('SP-21 decision receipt parsing', () => {
  const parse = (value: unknown, input: DecisionInput) => parseDecisionReceipt(value, { ...TARGET, input });
  type Raw = Record<string, any>;
  const r = (): Raw => decisionReceipt('REJECT');
  const a = (): Raw => decisionReceipt('APPROVE');

  it('accepts the stored REJECT and APPROVE receipts', () => {
    expect(parse(r(), REJECT)).toMatchObject({ decision: 'REJECT', selectedOffer: null, updatedDuty: null, cancellation: { status: 'REJECTED' } });
    expect(parse(a(), APPROVE)).toMatchObject({
      decision: 'APPROVE',
      selectedOffer: null,
      updatedDuty: { concurrencyVersion: 5 },
      cancellation: { status: 'APPROVED', replacementNeed: { status: 'OPEN_UNFILLED', resolvedAt: null } },
    });
  });

  it.each<[string, () => unknown, DecisionInput]>([
    ['an extra top-level key', () => ({ ...r(), extra: 1 }), REJECT],
    ['a selected offer', () => ({ ...r(), selectedOffer: { id: NEED_ID } }), REJECT],
    ['a missing selected offer', () => ({ cancellation: r().cancellation, updatedDuty: null }), REJECT],
    ['another cancellation id', () => ({ ...r(), cancellation: { ...r().cancellation, id: NEED_ID } }), REJECT],
    ['another need id', () => ({ ...r(), cancellation: { ...r().cancellation, replacementNeed: { ...r().cancellation.replacementNeed, id: CANCELLATION_ID } } }), REJECT],
    ['no decision time', () => ({ ...r(), cancellation: { ...r().cancellation, decidedAt: null } }), REJECT],
    ['an APPROVED answer to REJECT', () => a(), REJECT],
    ['a REJECTED answer to APPROVE', () => r(), APPROVE],
    ['REJECTED with an updated duty', () => ({ ...r(), updatedDuty: a().updatedDuty }), REJECT],
    ['APPROVED without an updated duty', () => ({ ...a(), updatedDuty: null }), APPROVE],
    [
      'APPROVED with a resolved need',
      () => ({ ...a(), cancellation: { ...a().cancellation, replacementNeed: { id: NEED_ID, status: 'RESOLVED', resolvedAt: '2026-12-15T11:00:00.000Z' } } }),
      APPROVE,
    ],
    ['a duty version not advanced exactly once', () => ({ ...a(), updatedDuty: { ...a().updatedDuty, concurrencyVersion: 6 } }), APPROVE],
    ['an updated duty that differs from the cancelled duty', () => ({ ...a(), updatedDuty: { ...a().updatedDuty, dutyDate: '2026-12-17' } }), APPROVE],
    ['an updated duty with an extra field', () => ({ ...a(), updatedDuty: { ...a().updatedDuty, removedAt: null } }), APPROVE],
    ['a non-object answer', () => null, REJECT],
  ])('rejects %s', (_name, build, input) => {
    expectInvalid(() => parse(build(), input));
  });
});

describe('SP-21 decision requests', () => {
  function capture(answer: unknown) {
    const seen: { path: string; options: SessionRequest }[] = [];
    const { api, requests } = recordingApi((path, options) => {
      seen.push({ path, options });
      return answer;
    });
    return { queue: createWorkQueueApi(api), seen, requests };
  }

  it('REJECT posts only the decision with an Idempotency-Key and no version', async () => {
    const { queue, seen } = capture(decisionReceipt('REJECT'));
    await queue.decide(TARGET, REJECT);
    expect(seen).toEqual([
      {
        path: `/api/v1/cancellation-requests/${CANCELLATION_ID}/decision`,
        options: { method: 'POST', body: { decision: 'REJECT' }, idempotencyKey: KEY, signal: undefined },
      },
    ]);
    expect(seen[0].options).not.toHaveProperty('expectedVersion');
  });

  it('APPROVE sends the need version as Expected-Version and the duty version in the body', async () => {
    const { queue, seen } = capture(decisionReceipt('APPROVE'));
    await queue.decide(TARGET, APPROVE);
    expect(seen).toEqual([
      {
        path: `/api/v1/cancellation-requests/${CANCELLATION_ID}/decision`,
        options: { method: 'POST', body: { decision: 'APPROVE', expectedDutyVersion: 4 }, expectedVersion: 1, idempotencyKey: KEY, signal: undefined },
      },
    ]);
  });

  it.each<[string, { requestId: string; needId: string }, DecisionInput]>([
    ['a malformed case id', { requestId: 'x', needId: NEED_ID }, REJECT],
    ['a malformed need id', { requestId: CANCELLATION_ID, needId: 'x' }, REJECT],
    ['a short key', TARGET, { decision: 'REJECT', idempotencyKey: 'short' }],
    ['a key with a space', TARGET, { decision: 'REJECT', idempotencyKey: 'key 00000001' }],
    ['a zero duty version', TARGET, { ...APPROVE, expectedDutyVersion: 0 }],
    ['an unsafe need version', TARGET, { ...APPROVE, expectedNeedVersion: 2 ** 53 }],
  ])('sends nothing for %s', async (_name, target, input) => {
    const { queue, requests } = capture(decisionReceipt('REJECT'));
    await expect(queue.decide(target, input)).rejects.toBeInstanceOf(ApiError);
    expect(requests).toEqual([]);
  });

  it('does not report success for a malformed 200 answer', async () => {
    const { queue } = capture({ ...decisionReceipt('REJECT'), selectedOffer: {} });
    await expect(queue.decide(TARGET, REJECT)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
