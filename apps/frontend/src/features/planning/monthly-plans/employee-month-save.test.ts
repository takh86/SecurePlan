import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import { DAY_ISSUE_TEXT, emptyDraft, monthBase, monthBaseFromRead, paint, setDay, setRole } from './employee-month-draft';
import {
  buildSaveBody,
  classifyLookupError,
  classifySaveError,
  newSaveAttempt,
  readDrift,
  refusalText,
  savedText,
} from './employee-month-save';
import { CALENDAR_ID, FINGERPRINT, OTHER_FINGERPRINT, PUBLISHED_AT_A2, readFixture, stageError } from './employee-month.test-support';
import { JONAS_ID, LEA_ID, MIRA_ID, PLAN_ID } from './monthly-planning.test-support';
import type { SaveResult } from './employee-month-api';

function dec(day: number): string {
  return `2026-12-${String(day).padStart(2, '0')}`;
}

const SHARED = 'd0000000-0000-4000-8000-0000000000a3';
const OWN_NIGHT = 'd0000000-0000-4000-8000-0000000000b4';
const LEAD_DAY = 'd0000000-0000-4000-8000-0000000000c8';

/**
 * Example month: the 3rd has an existing day duty staffed only by others
 * (version 4), the 4th the employee's own night (version 2), the 8th the
 * employee as Schichtleitung (version 6).
 */
function exampleRead(overrides: Parameters<typeof readFixture>[0] = {}) {
  return readFixture({
    day: { 3: { dutyId: SHARED, version: 4, role: null }, 8: { dutyId: LEAD_DAY, version: 6, role: 'SHIFT_LEAD' } },
    night: { 4: { dutyId: OWN_NIGHT, version: 2, role: 'EMPLOYEE' } },
    ...overrides,
  });
}

describe('A2 request body — the complete desired month with the read\'s exact preconditions', () => {
  it('covers every date (OFF included) and carries both slot tokens, lifecycle, checksum and calendar token', () => {
    const read = exampleRead();
    let draft = emptyDraft(monthBaseFromRead(read));
    draft = paint(draft, dec(3), 'DAY');
    draft = paint(draft, dec(4), 'FREE');
    draft = paint(draft, dec(10), 'NIGHT');
    const body = buildSaveBody(draft);
    expect(body.expectedPlan).toEqual({ status: 'UNPUBLISHED', publishedAt: null });
    expect(body.expectedCreationContext).toBe(FINGERPRINT);
    expect(body.expectedCalendar).toEqual({ id: CALENDAR_ID, version: 1 });
    expect(body.days.map((day) => day.date)).toEqual(read.days.map((day) => day.date));
    expect(body.days).toHaveLength(31);
    expect(body.days[2]).toEqual({ date: dec(3), expected: { day: { id: SHARED, version: 4 }, night: null }, desired: { state: 'DAY', role: 'EMPLOYEE' } });
    expect(body.days[3]).toEqual({ date: dec(4), expected: { day: null, night: { id: OWN_NIGHT, version: 2 } }, desired: { state: 'OFF' } });
    expect(body.days[9]).toEqual({ date: dec(10), expected: { day: null, night: null }, desired: { state: 'NIGHT', role: 'EMPLOYEE' } });
    // Untouched dates send their stored state, with role, as desired — never "unchanged".
    expect(body.days[7]).toEqual({ date: dec(8), expected: { day: { id: LEAD_DAY, version: 6 }, night: null }, desired: { state: 'DAY', role: 'SHIFT_LEAD' } });
    expect(body.days[0]).toEqual({ date: dec(1), expected: { day: null, night: null }, desired: { state: 'OFF' } });
  });

  it('starts a new kind as Mitarbeitende, sends a role change explicitly and restores the stored Schichtleitung', () => {
    let draft = emptyDraft(monthBaseFromRead(exampleRead()));
    draft = paint(draft, dec(8), 'NIGHT');
    expect(buildSaveBody(draft).days[7].desired).toEqual({ state: 'NIGHT', role: 'EMPLOYEE' });
    draft = setRole(draft, dec(8), 'SHIFT_LEAD');
    expect(buildSaveBody(draft).days[7].desired).toEqual({ state: 'NIGHT', role: 'SHIFT_LEAD' });
    draft = paint(draft, dec(8), 'DAY');
    // Back to the stored Tag: its stored role Schichtleitung is restored (no downgrade).
    expect(buildSaveBody(draft).days[7].desired).toEqual({ state: 'DAY', role: 'SHIFT_LEAD' });
  });

  it('never sends other people, assignment ids, sources, times or tenant data', () => {
    let draft = emptyDraft(monthBaseFromRead(exampleRead()));
    draft = paint(draft, dec(3), 'DAY');
    const json = JSON.stringify(buildSaveBody(draft));
    for (const forbidden of [JONAS_ID, LEA_ID, 'assignment', 'source', 'startsAt', 'endsAt', 'companyId', 'employeeId', 'NORMAL']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('expects a published plan with its publication instant, and null for a MISSING calendar', () => {
    const read = exampleRead({ status: 'PUBLISHED', calendar: null });
    const body = buildSaveBody(paint(emptyDraft(monthBaseFromRead(read)), dec(4), 'FREE'));
    expect(body.expectedPlan).toEqual({ status: 'PUBLISHED', publishedAt: PUBLISHED_AT_A2 });
    expect(body.expectedCalendar).toBeNull();
  });

  it('refuses a preview draft and a date that still has both shifts (caller defects)', () => {
    expect(() => buildSaveBody(emptyDraft(monthBase([], MIRA_ID, '2026-12')))).toThrow('A preview draft has no save basis');
    const dual = emptyDraft(monthBaseFromRead(readFixture({ day: { 7: { role: 'EMPLOYEE' } }, night: { 7: { role: 'EMPLOYEE' } } })));
    expect(() => buildSaveBody(dual)).toThrow('A date still has both shifts');
    // An explicit decision resolves it.
    expect(buildSaveBody(setDay(dual, dec(7), null)).days[6].desired).toEqual({ state: 'OFF' });
  });

  it('freezes one attempt: route, a fresh key per decision and an immutable body', () => {
    const draft = paint(emptyDraft(monthBaseFromRead(exampleRead())), dec(3), 'DAY');
    const first = newSaveAttempt(draft);
    const second = newSaveAttempt(draft);
    expect(first).toMatchObject({ planId: PLAN_ID, employeeId: MIRA_ID });
    expect(first.key).toMatch(/^[\x21-\x7e]{8,128}$/);
    expect(second.key).not.toBe(first.key);
    expect(second.body).toEqual(first.body);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.body.days)).toBe(true);
    expect(Object.isFrozen(first.body.days[2].desired)).toBe(true);
  });
});

describe('A2 save outcomes', () => {
  it('treats every answer that proves nothing as UNKNOWN (never as a rollback)', () => {
    for (const error of [
      new Error('adapter failure'),
      new ApiError('network', null, null, null),
      new ApiError('invalid-response', 200, null, null),
      new ApiError('http', 500, 'INTERNAL_ERROR', 'req'),
      new ApiError('http', 503, 'SERVICE_UNAVAILABLE', 'req'),
      new ApiError('http', 429, 'RATE_LIMITED', 'req'),
      new ApiError('http', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', 'req'),
    ]) {
      expect(classifySaveError(error)).toEqual({ kind: 'unknown' });
    }
  });

  it('maps the atomic stages: PRECONDITION needs a reload, LEASE and VALIDATION keep the draft for a new attempt', () => {
    const precondition = classifySaveError(stageError('PRECONDITION', [{ date: dec(3), shiftKind: 'DAY', reason: 'PLAN_CONCURRENT_MODIFICATION' }]));
    expect(precondition).toEqual({
      kind: 'refused',
      refusal: { stage: 'PRECONDITION', issues: [{ date: dec(3), kind: 'DAY', reason: 'PLAN_CONCURRENT_MODIFICATION' }], needsReload: true, correlationId: 'req-a2-1' },
    });
    const lease = classifySaveError(stageError('LEASE', [{ date: dec(4), shiftKind: 'NIGHT', reason: 'ACTIVE_DUTY_EDIT' }]));
    expect(lease).toMatchObject({ kind: 'refused', refusal: { stage: 'LEASE', needsReload: false } });
    const validation = classifySaveError(stageError('VALIDATION', [
      { date: dec(5), shiftKind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' },
      { date: dec(6), shiftKind: 'NIGHT', reason: 'PRESERVED_ROSTER_CONFLICT' },
    ]));
    expect(validation).toMatchObject({ kind: 'refused', refusal: { stage: 'VALIDATION', needsReload: false, issues: [{ date: dec(5) }, { date: dec(6) }] } });
    // Drift without a safely identifiable slot: an empty list, still a refusal that needs a reload.
    expect(classifySaveError(stageError('PRECONDITION'))).toMatchObject({ kind: 'refused', refusal: { stage: 'PRECONDITION', issues: [], needsReload: true } });
    expect(classifySaveError(new ApiError('http', 409, 'PLAN_CONCURRENT_MODIFICATION', 'req'))).toMatchObject({ refusal: { stage: 'PRECONDITION', needsReload: true } });
  });

  it('treats request-level refusals as definite (nothing saved) and asks for a reload', () => {
    for (const [status, code] of [[400, 'VALIDATION_FAILED'], [400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH'], [413, null], [415, null], [409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST']] as const) {
      expect(classifySaveError(new ApiError('http', status, code, 'req'))).toMatchObject({ kind: 'refused', refusal: { needsReload: true, issues: [] } });
    }
  });

  it('ends the form for 404 and 403 and leaves 401 to the session boundary', () => {
    expect(classifySaveError(new ApiError('http', 404, 'RESOURCE_NOT_FOUND', 'req'))).toEqual({ kind: 'gone' });
    expect(classifySaveError(new ApiError('http', 403, 'CSRF_VALIDATION_FAILED', 'req'))).toEqual({ kind: 'forbidden' });
    expect(classifySaveError(new ApiError('http', 401, 'SESSION_EXPIRED', 'req'))).toEqual({ kind: 'signed-out' });
  });

  it('learns nothing from a failed lookup, except a contended key that is still running', () => {
    expect(classifyLookupError(new ApiError('network', null, null, null))).toBe('unknown');
    expect(classifyLookupError(new ApiError('http', 500, 'INTERNAL_ERROR', 'req'))).toBe('unknown');
    expect(classifyLookupError(new ApiError('invalid-response', 200, null, null))).toBe('unknown');
    expect(classifyLookupError(new ApiError('http', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', 'req'))).toBe('in-progress');
    expect(classifyLookupError(new ApiError('http', 404, 'RESOURCE_NOT_FOUND', 'req'))).toBe('gone');
    expect(classifyLookupError(new ApiError('http', 403, 'ACTION_FORBIDDEN', 'req'))).toBe('forbidden');
    expect(classifyLookupError(new ApiError('http', 401, 'SESSION_EXPIRED', 'req'))).toBe('signed-out');
  });
});

describe('A2 texts — neutral and German', () => {
  it('names counts of a receipt and says that a NO_OP changed nothing', () => {
    const counts = { createdDuties: 2, changedDuties: 1, addedMemberships: 2, removedMemberships: 1, updatedMemberships: 0 };
    expect(savedText({ outcome: 'APPLIED', counts } as SaveResult)).toBe('Der Monat wurde gespeichert: 2 Dienste angelegt, 1 Dienst geändert.');
    expect(savedText({ outcome: 'NO_OP', counts } as SaveResult)).toBe('Der Monat war bereits so gespeichert. Es wurde nichts geändert.');
  });

  it('says for every refusal that nothing was saved and the selection is kept', () => {
    for (const stage of ['PRECONDITION', 'LEASE', 'VALIDATION', 'REQUEST', 'OTHER'] as const) {
      expect(refusalText({ stage, issues: [], needsReload: false, correlationId: null })).toContain('Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.');
    }
    expect(refusalText({ stage: 'VALIDATION', issues: [{ date: dec(3), kind: 'DAY', reason: 'EMPLOYEE_UNAVAILABLE' }, { date: dec(3), kind: 'NIGHT', reason: 'EMPLOYEE_UNAVAILABLE' }], needsReload: false, correlationId: null }))
      .toContain('Bitte prüfen Sie 1 Tag:');
  });

  it('never reveals an absence reason, a lease holder or another person', () => {
    const all = Object.values(DAY_ISSUE_TEXT).join(' ');
    expect(all).not.toMatch(/krank|Krankheit|Urlaub|Abwesenheit|Herr|Frau|gesperrt von|bearbeitet von/i);
    expect(Object.keys(DAY_ISSUE_TEXT)).toHaveLength(15);
  });

  it('reports month-wide drift between two reads: publication, calendar, creation basis, availability', () => {
    const before = exampleRead();
    expect(readDrift(before, exampleRead())).toEqual([]);
    expect(readDrift(before, exampleRead({ status: 'PUBLISHED' }))).toEqual(['Der Plan wurde inzwischen veröffentlicht: Gespeicherte Änderungen gelten danach sofort.']);
    expect(readDrift(before, exampleRead({ calendarVersion: 2 }))).toEqual(['Die Betriebstage des Projekts wurden inzwischen geändert.']);
    expect(readDrift(before, exampleRead({ fingerprint: OTHER_FINGERPRINT }))).toEqual(['Die Grundlagen für neue Dienste (zum Beispiel die Schichtzeiten) wurden inzwischen geändert.']);
    expect(readDrift(before, exampleRead({ unavailable: [12] }))).toEqual(['Die Verfügbarkeit dieser Person wurde inzwischen geändert.']);
  });
});
