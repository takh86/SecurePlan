import { describe, expect, it } from 'vitest';
import type { Duty } from './monthly-plan-types';
import {
  HAFEN_ID,
  JONAS_ID,
  LEA_ID,
  MESSE_ID,
  MIRA_ID,
  OSKAR_ID,
  PAUL_ID,
  duty,
  member,
  monthAssignments,
  staff,
} from './monthly-planning.test-support';
import {
  UNKNOWN_PERSON,
  buildMatrixRows,
  cellName,
  cellText,
  dayHeader,
  dayName,
  dayText,
  dutiesOn,
  filterRows,
  matrixDays,
} from './planning-matrix';

const UNKNOWN = 'f9999999-9999-4999-8999-999999999999';
const day = (date: string, overrides: Partial<Duty> = {}) =>
  duty({ dutyDate: date, startsAt: `${date}T05:00:00Z`, endsAt: `${date}T17:00:00Z`, ...overrides });

describe('A10 matrix model — days', () => {
  it.each([
    ['2026-12', 31, '2026-12-31'],
    ['2028-02', 29, '2028-02-29'],
    ['2027-02', 28, '2027-02-28'],
    ['2027-01', 31, '2027-01-31'],
  ])('lists every day of %s', (month, count, last) => {
    const days = matrixDays(month);
    expect(days).toHaveLength(count);
    expect(days[0]).toBe(`${month}-01`);
    expect(days.at(-1)).toBe(last);
  });

  it('headers name weekday and day; weekends are marked by date, never by the device zone', () => {
    expect(dayHeader('2026-12-05')).toEqual({ weekday: 'Sa', day: '05', weekend: true });
    expect(dayHeader('2026-12-07')).toEqual({ weekday: 'Mo', day: '07', weekend: false });
    expect(dayHeader('2027-01-03')).toEqual({ weekday: 'So', day: '03', weekend: true });
  });
});

describe('A10 matrix model — rows and cells', () => {
  const assignments = [
    ...monthAssignments(HAFEN_ID, '2026-12-01', [MIRA_ID, JONAS_ID, OSKAR_ID]),
    // Other project and other month: never rows of this plan.
    ...monthAssignments(MESSE_ID, '2026-12-01', [PAUL_ID]),
    ...monthAssignments(HAFEN_ID, '2026-11-01', [LEA_ID]),
  ];

  it('rows: assigned persons plus every member, sorted by last name; unknown persons last', () => {
    const duties = [
      day('2026-12-03', { assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(LEA_ID)] }),
      day('2026-12-04', { assignments: [member(UNKNOWN)] }),
    ];
    const rows = buildMatrixRows(staff, assignments, duties, HAFEN_ID, '2026-12-01');
    expect(rows.map((row) => [row.name, row.assigned, row.inactive])).toEqual([
      ['Mira Beispiel', true, false],
      ['Jonas Muster', true, false],
      // A member whose month assignment is elsewhere still gets a row (history stays visible).
      ['Lea Probe', false, false],
      ['Oskar Test', true, true],
      [UNKNOWN_PERSON, false, false],
    ]);
  });

  it('cells by duty date: DAY before NIGHT, role and neutral hint in the accessible name', () => {
    const lead = member(MIRA_ID, 'SHIFT_LEAD');
    const duties = [
      day('2026-12-03', { shiftKind: 'NIGHT', assignments: [member(MIRA_ID)] }),
      day('2026-12-03', {
        assignments: [lead],
        availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
      }),
    ];
    const [mira] = buildMatrixRows(staff, assignments, duties, HAFEN_ID, '2026-12-01');
    const entries = mira.cells.get('2026-12-03');
    expect(cellText(entries)).toBe('Tag + Nacht');
    expect(cellName(mira.name, '2026-12-03', entries))
      .toBe('Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung, nicht verfügbar; Nachtdienst');
    expect(mira.hasConflict).toBe(true);
    expect(cellText(mira.cells.get('2026-12-04'))).toBe('–');
    expect(cellName(mira.name, '2026-12-04', undefined)).toBe('Mira Beispiel, Fr., 4. Dezember: frei');
  });

  it('a night duty at the year end stays on its start date (31 Dec), not on 1 Jan', () => {
    const night = duty({ dutyDate: '2026-12-31', shiftKind: 'NIGHT', startsAt: '2026-12-31T17:00:00Z', endsAt: '2027-01-01T05:00:00Z', assignments: [member(JONAS_ID)] });
    const rows = buildMatrixRows(staff, assignments, [night], HAFEN_ID, '2026-12-01');
    const jonas = rows.find((row) => row.employeeId === JONAS_ID)!;
    expect([...jonas.cells.keys()]).toEqual(['2026-12-31']);
  });

  it('the day row names both slots, including duties without members', () => {
    const duties = [day('2026-12-03', { assignments: [member(MIRA_ID), member(JONAS_ID)] }), day('2026-12-03', { shiftKind: 'NIGHT' })];
    const slots = dutiesOn(duties, '2026-12-03');
    expect(dayText(slots)).toBe('T2 N0');
    expect(dayName('2026-12-03', slots)).toBe('Do., 3. Dezember: Tagdienst, 2 Personen; Nachtdienst, ohne Besetzung');
    expect(dayText(dutiesOn(duties, '2026-12-04'))).toBe('–');
    expect(dayName('2026-12-04', {})).toBe('Fr., 4. Dezember: kein Tagdienst; kein Nachtdienst');
  });

  it('filters by name or code (case-insensitive) and by hints', () => {
    const lead = member(MIRA_ID);
    const duties = [day('2026-12-03', {
      assignments: [lead],
      availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
    })];
    const rows = buildMatrixRows(staff, assignments, duties, HAFEN_ID, '2026-12-01');
    expect(filterRows(rows, 'MUSTER', false).map((row) => row.name)).toEqual(['Jonas Muster']);
    expect(filterRows(rows, ' a-004 ', false).map((row) => row.name)).toEqual(['Oskar Test']);
    expect(filterRows(rows, '', true).map((row) => row.name)).toEqual(['Mira Beispiel']);
    expect(filterRows(rows, 'muster', true)).toEqual([]);
  });
});
