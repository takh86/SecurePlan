import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import {
  createWorkQueueApi,
  isCaseId,
  offersSearch,
  parseOffersPage,
  parseOffersQuery,
  parseQueuePage,
  parseQueueQuery,
  queueSearch,
  revalidateOnForbidden,
} from './work-queue-api';
import {
  NEED_ID,
  caseContext,
  offer,
  offersPage,
  queueItem,
  queuePage,
  recordingApi,
  threeOffers,
} from './work-queue.test-support';
import type { QueueQuery } from './work-queue-types';

const withKey = (value: object, key: string, extra: unknown) => ({ ...value, [key]: extra });
const without = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

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

describe('SP-19 queue response parsing', () => {
  it('accepts a documented page and keeps the server values', () => {
    const page = parseQueuePage(queuePage([queueItem()]), 1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      type: 'CANCELLATION_REQUEST',
      openOfferCount: 3,
      eligibleOpenOfferCount: 1,
      timeZone: 'Europe/Berlin',
      monthStart: '2026-12-01',
    });
    expect(page.pagination).toEqual({ page: 1, pageSize: 25, totalItems: 1, totalPages: 1 });
    expect(page.evaluatedAt).toBe('2026-12-15T10:00:00.000Z');
  });

  it('accepts an empty page beyond the last page', () => {
    const page = parseQueuePage(queuePage([], 1, 3), 3);
    expect(page.items).toEqual([]);
    expect(page.pagination.totalPages).toBe(1);
  });

  it.each([
    ['an unknown property', (r: object) => withKey(r, 'approvedBy', 'x')],
    ['a missing property', (r: object) => without(r, 'evaluatedAt')],
    ['a non-array items value', (r: object) => ({ ...r, items: {} })],
    ['a pagination echo that differs from the request', (r: object) => ({ ...r, pagination: { ...(r as { pagination: object }).pagination, page: 2 } })],
    ['a row count that contradicts the totals', (r: object) => ({ ...r, pagination: { page: 1, pageSize: 25, totalItems: 2, totalPages: 1 } })],
    ['an invalid evaluation time', (r: object) => ({ ...r, evaluatedAt: '2026-12-15 10:00:00' })],
  ])('rejects a response with %s', (_, mutate) => {
    expectInvalid(() => parseQueuePage(mutate(queuePage([queueItem()])), 1));
  });

  it.each([
    ['an unknown case type', { type: 'OTHER' }],
    ['a cancellation row with an approved request', { cancellationStatus: 'APPROVED' }],
    ['a replacement row whose need is still open', { type: 'REPLACEMENT_NEED', cancellationStatus: 'APPROVED', replacementNeedStatus: 'OPEN' }],
    ['an eligible count above the open count', { eligibleOpenOfferCount: 4 }],
    ['a month that does not match the duty date', { monthStart: '2026-11-01' }],
    ['a non-canonical UTC instant', { duty: { ...queueItem().duty, startsAt: '2026-12-16T17:00:00.000Z' } }],
    ['an end before the start', { duty: { ...queueItem().duty, endsAt: '2026-12-16T16:00:00Z' } }],
    ['an unknown time zone', { timeZone: 'Mars/Olympus' }],
    ['a malformed identifier', { replacementNeedId: 'not-a-uuid' }],
    ['a negative count', { openOfferCount: -1 }],
  ])('rejects a row with %s', (_, override) => {
    expectInvalid(() => parseQueuePage(queuePage([queueItem(override as never)]), 1));
  });

  it('rejects a duplicated replacement need', () => {
    expectInvalid(() => parseQueuePage(queuePage([queueItem(), queueItem()], 2), 1));
  });
});

describe('SP-19 case response parsing', () => {
  it('accepts the documented context and offers', () => {
    const page = parseOffersPage(offersPage(threeOffers()), NEED_ID, { status: null, page: 1 });
    expect(page.context.need.id).toBe(NEED_ID);
    expect(page.context.eligibleOpenOfferCount).toBe(1);
    expect(page.items.map((o) => o.reviewEligibility)).toEqual(['ELIGIBLE', 'INELIGIBLE', 'NOT_APPLICABLE']);
    expect(page.context.cancellation.duty.shiftKind).toBe('NIGHT');
  });

  it('rejects offers that belong to another need', () => {
    expectInvalid(() =>
      parseOffersPage(offersPage([offer({ needId: '73000000-0000-4000-8000-000000000001' })]), NEED_ID, { status: null, page: 1 }),
    );
  });

  it('rejects an eligibility other than NOT_APPLICABLE for a closed offer', () => {
    expectInvalid(() =>
      parseOffersPage(
        offersPage([offer({ status: 'WITHDRAWN', decidedAt: '2026-12-15T10:30:00.000Z', reviewEligibility: 'ELIGIBLE' })]),
        NEED_ID,
        { status: null, page: 1 },
      ),
    );
  });

  it('rejects an open offer that already has a decision time', () => {
    expectInvalid(() =>
      parseOffersPage(offersPage([offer({ decidedAt: '2026-12-15T10:30:00.000Z' })]), NEED_ID, { status: null, page: 1 }),
    );
  });

  it('rejects a page that does not match the requested status filter', () => {
    expectInvalid(() =>
      parseOffersPage(offersPage([offer({ status: 'WITHDRAWN', decidedAt: '2026-12-15T10:30:00.000Z', reviewEligibility: 'NOT_APPLICABLE' })]), NEED_ID, {
        status: 'OPEN',
        page: 1,
      }),
    );
  });

  it('rejects offers that are not in the documented order', () => {
    const [first, second] = threeOffers();
    expectInvalid(() => parseOffersPage(offersPage([second, first]), NEED_ID, { status: null, page: 1 }));
  });

  it('rejects a context that describes a different case', () => {
    const context = caseContext({ need: { ...caseContext().need, cancellationRequestId: '73000000-0000-4000-8000-000000000009' } });
    expectInvalid(() => parseOffersPage(offersPage([], context), NEED_ID, { status: null, page: 1 }));
  });

  it('rejects an eligible count above the need open count', () => {
    expectInvalid(() => parseOffersPage(offersPage([], caseContext({ eligibleOpenOfferCount: 9 })), NEED_ID, { status: null, page: 1 }));
  });

  it('rejects a resolved need without a resolution time', () => {
    const context = caseContext();
    const resolved = { ...context, need: { ...context.need, status: 'RESOLVED' as const, resolvedAt: null } };
    expectInvalid(() => parseOffersPage(offersPage([], resolved), NEED_ID, { status: null, page: 1 }));
  });
});

describe('SP-19 URL state', () => {
  it('uses only validated values and falls back to the defaults', () => {
    const query = parseQueueQuery(new URLSearchParams('type=DROP&offerPresence=ALL&projectId=bad&month=2026-13&page=-4&sortBy=name&sortOrder=up'));
    expect(query).toEqual({
      type: null,
      offerPresence: null,
      projectId: null,
      month: null,
      page: 1,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });
  });

  it('lowercases a project identifier and keeps a valid month', () => {
    const query = parseQueueQuery(new URLSearchParams('projectId=ABCDEF01-0000-4000-8000-000000000001&month=2026-12&page=2'));
    expect(query.projectId).toBe('abcdef01-0000-4000-8000-000000000001');
    expect(query.month).toBe('2026-12');
    expect(query.page).toBe(2);
  });

  it('round-trips a query and omits defaults from the URL', () => {
    const query: QueueQuery = {
      type: 'REPLACEMENT_NEED',
      offerPresence: 'WITHOUT_ELIGIBLE',
      projectId: 'abcdef01-0000-4000-8000-000000000001',
      month: '2026-12',
      page: 3,
      sortBy: 'dutyDate',
      sortOrder: 'desc',
    };
    const search = queueSearch(query);
    expect(parseQueueQuery(new URLSearchParams(search))).toEqual(query);
    expect(queueSearch(parseQueueQuery(new URLSearchParams('')))).toBe('');
  });

  it('keeps the case status filter and page, and nothing else', () => {
    expect(parseOffersQuery(new URLSearchParams('status=OPEN&page=2&x=1'))).toEqual({ status: 'OPEN', page: 2 });
    expect(offersSearch({ status: null, page: 1 })).toBe('');
    expect(offersSearch({ status: 'SELECTED', page: 2 })).toBe('status=SELECTED&page=2');
  });

  it('recognises only canonical identifiers as case identifiers', () => {
    expect(isCaseId(NEED_ID)).toBe(true);
    expect(isCaseId('../admin')).toBe(false);
    expect(isCaseId(undefined)).toBe(false);
  });
});

describe('SP-19 client requests', () => {
  it('sends the documented queue parameters and only GET requests', async () => {
    const { api, requests } = recordingApi(() => queuePage([], 0, 2));
    const queue = createWorkQueueApi(api);
    await queue.queue(
      {
        type: 'CANCELLATION_REQUEST',
        offerPresence: 'WITH_ELIGIBLE',
        projectId: 'abcdef01-0000-4000-8000-000000000001',
        month: '2026-12',
        page: 2,
        sortBy: 'dutyDate',
        sortOrder: 'desc',
      },
    );
    expect(requests).toEqual([
      {
        path:
          '/api/v1/admin/work-queue?type=CANCELLATION_REQUEST&offerPresence=WITH_ELIGIBLE&projectId=abcdef01-0000-4000-8000-000000000001&monthStart=2026-12-01&page=2&pageSize=25&sortBy=dutyDate&sortOrder=desc',
        method: 'GET',
      },
    ]);
  });

  it('sends the case offers request with status and page', async () => {
    const { api, requests } = recordingApi(() => offersPage([]));
    await createWorkQueueApi(api).offers(NEED_ID, { status: 'OPEN', page: 1 });
    expect(requests).toEqual([{ path: `/api/v1/replacement-needs/${NEED_ID}/offers?status=OPEN&page=1&pageSize=25`, method: 'GET' }]);
  });

  it('never sends a request for a malformed case identifier', async () => {
    const { api, requests } = recordingApi(() => offersPage([]));
    await expect(createWorkQueueApi(api).offers('../admin', { status: null, page: 1 })).rejects.toBeInstanceOf(ApiError);
    expect(requests).toEqual([]);
  });

  it('rejects a queue response that the transport delivered as an invalid body', async () => {
    const { api } = recordingApi(() => ({ unexpected: true }));
    await expect(createWorkQueueApi(api).queue({ type: null, offerPresence: null, projectId: null, month: null, page: 1, sortBy: 'createdAt', sortOrder: 'asc' })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('asks the session boundary to revalidate only on forbidden access', () => {
    const revalidate = vi.fn();
    revalidateOnForbidden(new ApiError('http', 403, 'ACTION_FORBIDDEN', null), revalidate);
    revalidateOnForbidden(new ApiError('http', 404, 'RESOURCE_NOT_FOUND', null), revalidate);
    revalidateOnForbidden(new Error('boom'), revalidate);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
