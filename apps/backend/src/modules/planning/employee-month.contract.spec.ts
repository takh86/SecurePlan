import { readFileSync } from 'node:fs';
import {
  creationFingerprint,
  decodeSaveResult,
  parseSave,
  requestFingerprint,
  safeSaveConflict,
  type Calendar,
  type SaveEmployeeMonth,
} from './employee-month.contract.js';
import { datesInMonth, operatingState } from './employee-month.store.js';

const p = '10000000-0000-4000-8000-000000000001',
  e = '20000000-0000-4000-8000-000000000001';
const rules = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    kind: 'DAY' as const,
    month: '2027-01-01',
    start: '06:00',
    end: '18:00',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    kind: 'NIGHT' as const,
    month: '2027-01-01',
    start: '18:00',
    end: '06:00',
  },
];
const calendar: Calendar = {
  id: '40000000-0000-4000-8000-000000000001',
  version: 9007199254740991,
  effectiveFromMonth: '0001-01-01',
  operatingWeekdays: [1, 2, 3, 4, 5, 6, 7],
};
const creation =
  'a8bf618a8036cfb70a64a50cff578c753026906194c5904e60d52b6ff51067ec';
const command = (): SaveEmployeeMonth => ({
  expectedPlan: { status: 'UNPUBLISHED', publishedAt: null },
  expectedCreationContext: creation,
  expectedCalendar: null,
  days: datesInMonth('2028-02-01').map((date, i) => ({
    date,
    expected: { day: null, night: null },
    desired:
      i === 28 ? { state: 'NIGHT', role: 'SHIFT_LEAD' } : { state: 'OFF' },
  })),
});
it('freezes creation and request UTF-8 tuple golden vectors at maximum safe calendar version and leap-month boundary', () => {
  expect(
    creationFingerprint(p, '2028-02-01', 'Europe/Berlin', rules, calendar),
  ).toBe(creation);
  expect(requestFingerprint(p, e, command())).toBe(
    '7f96abe172338b561c26ece19fafcb467eba7b716c43479523e7c6ed33c4d73a',
  );
  const dto = command();
  dto.days.reverse();
  expect(requestFingerprint(p.toUpperCase(), e.toUpperCase(), dto)).toBe(
    requestFingerprint(p, e, command()),
  );
  expect(
    creationFingerprint(
      p.toUpperCase(),
      '2028-02-01',
      'Europe/Berlin',
      [...rules].reverse(),
      { ...calendar!, operatingWeekdays: [7, 6, 5, 4, 3, 2, 1] },
    ),
  ).toBe(creation);
});
it.each([
  ['2027-02-01', 28],
  ['2028-02-01', 29],
  ['2027-04-01', 30],
  ['2027-01-01', 31],
  ['0001-02-01', 28],
  ['2000-02-01', 29],
  ['2100-02-01', 28],
  ['9999-12-01', 31],
])('complete proleptic Gregorian month %s has %i days', (month, n) => {
  expect(datesInMonth(String(month))).toHaveLength(Number(n));
});
it.each(['2027-03-28', '2027-10-31', '0001-01-07'])(
  'ISO weekday is stable across DST and low years: %s',
  (day) => {
    expect(operatingState(day, { ...calendar!, operatingWeekdays: [7] })).toBe(
      'OPEN',
    );
  },
);
it.each([
  null,
  [],
  {},
  { ...command(), unexpected: true },
  { ...command(), expectedCalendar: {} },
  { ...command(), expectedPlan: { status: 'PUBLISHED', publishedAt: null } },
  {
    ...command(),
    expectedPlan: {
      status: 'UNPUBLISHED',
      publishedAt: '2027-01-01T00:00:00Z',
    },
  },
  {
    ...command(),
    days: command().days.map((d, i) =>
      i === 0
        ? { ...d, desired: { state: { toString: 'DAY' }, role: 'EMPLOYEE' } }
        : d,
    ),
  },
  {
    ...command(),
    days: command().days.map((d, i) =>
      i === 0
        ? {
            ...d,
            expected: {
              day: { id: p, version: 9007199254740992 },
              night: null,
            },
          }
        : d,
    ),
  },
  {
    ...command(),
    days: command().days.map((d, i) =>
      i === 0 ? { ...d, date: '2028-02-30' } : d,
    ),
  },
])('rejects malformed full desired state %#', (v) => {
  expect(() => parseSave(v)).toThrow(expect.objectContaining({ status: 400 }));
});
it('allows no role on OFF and preserves exact canonical second precision on publication preconditions', () => {
  const dto = command();
  dto.expectedPlan = {
    status: 'PUBLISHED',
    publishedAt: '2027-01-01T00:00:00Z',
  };
  expect(parseSave(dto)).toEqual(dto);
  expect(() =>
    parseSave({
      ...dto,
      expectedPlan: {
        status: 'PUBLISHED',
        publishedAt: '2027-01-01T00:00:00.000000Z',
      },
    }),
  ).toThrow();
});
it('allowlists the atomic conflict and rejects unbounded, duplicate, invalid and leaking slot payloads', () => {
  const v = {
    atomic: true,
    stage: 'VALIDATION',
    conflicts: [
      { date: '2027-01-01', shiftKind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' },
    ],
  };
  expect(safeSaveConflict({ ...v, employeeId: e })).toEqual(v);
  for (const conflicts of [
    [...v.conflicts, ...v.conflicts],
    [{ ...v.conflicts[0], employeeId: e }],
    [{ ...v.conflicts[0], reason: 'SICK' }],
    Array(63).fill(v.conflicts[0]),
  ])
    expect(safeSaveConflict({ ...v, conflicts })).toBeUndefined();
  expect(
    safeSaveConflict({ ...v, stage: { toString: 'VALIDATION' } }),
  ).toBeUndefined();
});
it('strict receipt codec rejects malformed stored data, route mismatches and inconsistent counts', () => {
  const v = {
    commandId: p,
    outcome: 'NO_OP',
    completedAt: '2027-01-01T00:00:00.123456Z',
    plan: {
      id: p,
      projectId: e,
      monthStart: '2027-01-01',
      status: 'UNPUBLISHED',
      publishedAt: null,
    },
    employeeId: e,
    counts: {
      createdDuties: 0,
      changedDuties: 0,
      addedMemberships: 0,
      removedMemberships: 0,
      updatedMemberships: 0,
    },
    changes: [],
  };
  expect(decodeSaveResult(v, p, e)).toEqual(v);
  for (const bad of [
    { ...v, counts: { ...v.counts, addedMemberships: 1 } },
    { ...v, otherStaff: [] },
    { ...v, outcome: 'APPLIED' },
    { ...v, employeeId: p },
    { ...v, changes: Array(63).fill({}) },
  ])
    expect(() => decodeSaveResult(bad, p, e)).toThrow();
});
it('OpenAPI freezes the exact request, result, read and safe reason enums', () => {
  const api = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../docs/api/employee-month-save.openapi.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(api.openapi).toBe('3.1.0');
  const s = api.components.schemas;
  expect(s.SaveEmployeeMonth.required).toEqual([
    'expectedPlan',
    'expectedCreationContext',
    'expectedCalendar',
    'days',
  ]);
  expect(s.SaveResult.properties.changes.maxItems).toBe(62);
  expect(s.EmployeeMonthRead.additionalProperties).toBe(false);
  expect(
    s.AtomicConflict.properties.conflicts.items.properties.reason.enum,
  ).not.toContain('SICK');
});
