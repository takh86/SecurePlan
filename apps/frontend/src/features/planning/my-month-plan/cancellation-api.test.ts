import { expect, it } from 'vitest';
import { parseWorkItems } from './cancellation-api';
import { parseCancellation } from './cancellation-api';
import { cancellation } from './cancellation.test-support';
const parse = (value: unknown) =>
  parseCancellation(value, cancellation().assignmentId, cancellation().duty.id);
it('accepts exact created result and coherent current-state OBSOLETE replay', () => {
  const result = cancellation();
  expect(parse(result)).toEqual(result);
  result.status = 'OBSOLETE';
  result.replacementNeed.status = 'CLOSED';
  expect(parse(result)).toEqual(result);
});
it.each([
  ['id', 'bad'],
  ['assignmentId', '10000000-0000-4000-8000-000000000000'],
  ['status', 'IN_REVIEW'],
  ['status', 'APPROVED'],
  ['createdAt', '2026-02-30T12:00:00Z'],
  ['createdAt', '2026-11-04T12:00:00+01:00'],
  ['createdAt', null],
  ['decidedAt', '2026-11-04T12:00:00Z'],
  ['employee', []],
  ['duty', null],
  ['replacementNeed', null],
] as const)('rejects invalid cancellation field %s=%j', (key, value) => {
  const result = { ...cancellation(), [key]: value };
  expect(() => parse(result)).toThrow();
});
it.each(['root', 'employee', 'duty', 'replacementNeed'] as const)(
  'rejects every missing/unknown %s field',
  (part) => {
    const result = cancellation();
    const record = (part === 'root'
      ? result
      : result[part]) as unknown as Record<string, unknown>;
    record.privateField = 'hidden';
    expect(() => parse(result)).toThrow();
    delete record.privateField;
    for (const key of Object.keys(record)) {
      const saved = record[key];
      delete record[key];
      expect(() => parse(result)).toThrow();
      record[key] = saved;
    }
  },
);
it.each(['id', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt'])(
  'rejects corrupt or mismatched duty %s',
  (key) => {
    const result = cancellation();
    (result.duty as unknown as Record<string, unknown>)[key] =
      key === 'id' ? '10000000-0000-4000-8000-000000000000' : 'broken';
    expect(() => parse(result)).toThrow();
  },
);
it.each(['OPEN_UNFILLED', 'RESOLVED', 'CLOSED', 'INVALID'])(
  'rejects incoherent OPEN need %s',
  (status) => {
    const result = cancellation();
    (result.replacementNeed as unknown as Record<string, unknown>).status =
      status;
    expect(() => parse(result)).toThrow();
  },
);

it('parses the exact bounded personal work-items envelope', () => {
  expect(
    parseWorkItems(
      { cancellationRequests: [cancellation()], replacementOffers: [] },
      '2026-12-01',
    ).cancellationRequests,
  ).toHaveLength(1);
  expect(
    parseWorkItems(
      { cancellationRequests: [], replacementOffers: [] },
      '2026-12-01',
    ),
  ).toEqual({ cancellationRequests: [], replacementOffers: [] });
});
it.each([
  {},
  { cancellationRequests: [] },
  { cancellationRequests: [], replacementOffers: [], private: true },
  {
    cancellationRequests: [cancellation(), cancellation()],
    replacementOffers: [],
  },
  {
    cancellationRequests: [
      {
        ...cancellation(),
        duty: { ...cancellation().duty, dutyDate: '2027-01-01' },
      },
    ],
    replacementOffers: [],
  },
  {
    cancellationRequests: [
      {
        ...cancellation(),
        employee: { ...cancellation().employee, private: true },
      },
    ],
    replacementOffers: [],
  },
  {
    cancellationRequests: [cancellation()],
    replacementOffers: [{ id: 'future' }],
  },
  { cancellationRequests: [null], replacementOffers: [] },
])(
  'rejects malformed, out-of-month, duplicate or future-slice work-items %j',
  (value) => {
    expect(() => parseWorkItems(value, '2026-12-01')).toThrow();
  },
);
