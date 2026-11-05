import { expect, it } from 'vitest';
import {
  parseOffer,
  parseOffers,
  parseNeed,
  parseNeedPage,
  savedDutyTime,
} from './offer-api';
import { parseWorkItems } from '../../planning/my-month-plan/cancellation-api';
import { need, offer, page, employee } from './offer.test-support';
it('validates exact DTOs and coordinated history with empty cancellations', () => {
  expect(parseNeed(need())).toEqual(need());
  expect(parseOffer(offer(), employee, need().id)).toEqual(offer());
  expect(parseNeedPage(page(), '2027-01-01', 1)).toEqual(page());
  expect(
    parseWorkItems(
      { cancellationRequests: [], replacementOffers: [offer()] },
      '2027-01-01',
      employee,
    ).replacementOffers,
  ).toEqual([offer()]);
});
it.each([
  'OPEN',
  'SELECTED',
  'NOT_SELECTED',
  'INVALIDATED',
  'WITHDRAWN',
] as const)('enforces %s finalization nullability', (status) => {
  const o = {
    ...offer(),
    status,
    decidedAt: status === 'OPEN' ? null : '2026-11-05T06:01:00.000Z',
  };
  expect(parseOffer(o).status).toBe(status);
  expect(() =>
    parseOffer({
      ...o,
      decidedAt: status === 'OPEN' ? '2026-11-05T06:01:00.000Z' : null,
    }),
  ).toThrow();
});
it.each(['root', 'employee', 'duty', 'project'] as const)(
  'rejects every missing/unknown %s field',
  (part) => {
    const raw = part === 'employee' ? offer() : need();
    const target = (part === 'root'
      ? raw
      : (raw as unknown as Record<string, unknown>)[part]) as unknown as Record<
      string,
      unknown
    >;
    target.private = 'hidden';
    expect(() =>
      part === 'employee' ? parseOffer(raw) : parseNeed(raw),
    ).toThrow();
    delete target.private;
    for (const key of Object.keys(target)) {
      const old = target[key];
      delete target[key];
      expect(() =>
        part === 'employee' ? parseOffer(raw) : parseNeed(raw),
      ).toThrow();
      target[key] = old;
    }
  },
);
it.each([
  ['id', 'bad'],
  ['status', 'DECIDED'],
  ['createdAt', '2026-02-30T00:00:00.000Z'],
  ['createdAt', '2026-11-05T06:00:00Z'],
  ['decidedAt', '2026-11-04T00:00:00.000Z'],
])('rejects corrupt offer %s', (key, value) => {
  expect(() => parseOffer({ ...offer(), [key]: value })).toThrow();
});
it.each([
  ['openOfferCount', -1],
  ['openOfferCount', 1.5],
  ['timeZone', 'Invalid/Zone'],
  ['resolvedAt', '2026-11-05T00:00:00.000Z'],
  ['status', 'PENDING'],
])('rejects corrupt need %s', (key, value) => {
  expect(() => parseNeed({ ...need(), [key]: value })).toThrow();
});
it('rejects peer/mismatched offers and duplicate active history while accepting repeated terminal history', () => {
  expect(() => parseOffer(offer(), need().id)).toThrow();
  expect(() => parseOffer(offer(), employee, employee)).toThrow();
  expect(() => parseOffers([offer(), offer()])).toThrow();
  const other = { ...offer(), id: employee };
  expect(() => parseOffers([offer(), other])).toThrow();
  expect(
    parseOffers([
      {
        ...offer(),
        status: 'INVALIDATED',
        decidedAt: '2026-11-05T06:01:00.000Z',
      },
      other,
    ]),
  ).toHaveLength(2);
});
it.each(['page', 'pageSize', 'totalItems', 'totalPages'])(
  'rejects inconsistent pagination %s',
  (key) => {
    const p = page();
    (p.pagination as Record<string, number>)[key] = 99;
    expect(() => parseNeedPage(p, '2027-01-01', 1)).toThrow();
  },
);
it('rejects wrong month, duplicated rows and owner mismatch on list', () => {
  expect(() => parseNeedPage(page(), '2027-02-01', 1)).toThrow();
  const p = page();
  p.items.push(p.items[0]);
  expect(() => parseNeedPage(p, '2027-01-01', 1)).toThrow();
});
it('renders both overnight/DST endpoints and offsets in saved zone', () => {
  const n = need();
  n.duty.startsAt = '2027-10-30T20:00:00Z';
  n.duty.endsAt = '2027-10-31T05:00:00Z';
  const s = savedDutyTime(n);
  expect(s).toContain('30.10.2027');
  expect(s).toContain('31.10.2027');
  expect(s).toContain('GMT+02:00');
  expect(s).toContain('GMT+01:00');
});
