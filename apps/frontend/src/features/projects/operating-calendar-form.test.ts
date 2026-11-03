import { describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/api/api-error';
import { httpError } from '../employees/employees.test-support';
import type { CalendarRead, IsoWeekday } from './operating-calendar-api';
import {
  applicabilityText,
  calendarEditOptions,
  calendarErrorText,
  calendarNeedsReload,
  calendarOutcomeUnknown,
  calendarWriteTerminal,
  storedWeekdays,
  weekdayChange,
  weekdayList,
} from './operating-calendar-form';

// Synthetic example reads; every weekday set is an explicit example, not a default.
const ID = '9a000000-0000-4000-8000-202610000001';
function read(month: string, overrides: Partial<CalendarRead> = {}): CalendarRead {
  return { projectId: 'p', month, state: 'MISSING', effective: null, exactVersion: null, nextEffectiveFromMonth: null, ...overrides };
}
const configured = (month: string, from: string, days: IsoWeekday[], next: string | null = null) =>
  read(month, {
    state: 'CONFIGURED',
    effective: { id: ID, effectiveFromMonth: from, operatingWeekdays: days, version: 2 },
    exactVersion: from === month ? { id: ID, version: 2 } : null,
    nextEffectiveFromMonth: next,
  });

describe('F-A1-2 weekday texts and changes', () => {
  it('lists weekdays Monday first with full German names', () => {
    expect(weekdayList([7, 1, 3])).toBe('Montag, Mittwoch und Sonntag');
    expect(weekdayList([6])).toBe('Samstag');
    expect(weekdayList([])).toBe('');
  });

  it('MISSING has no stored set and no "change" against an unknown policy', () => {
    expect(storedWeekdays(read('2026-12'))).toEqual([]);
    expect(weekdayChange(read('2026-12'), [1, 2])).toBeNull();
  });

  it('reports newly closed and newly opened weekdays against the version in force', () => {
    expect(weekdayChange(configured('2026-12', '2026-10', [1, 2, 3, 4, 5]), [2, 3, 4, 5, 6])).toEqual({ closed: [1], opened: [6] });
    expect(weekdayChange(configured('2026-12', '2026-12', [6, 7]), [6, 7])).toEqual({ closed: [], opened: [] });
  });
});

describe('F-A1-2 offered write (company time zone unknown to the client)', () => {
  // 15.12.2026 12:00 UTC: November is past in every zone; December and later are not.
  const mid = new Date(Date.UTC(2026, 11, 15, 12));

  it('current and future months offer the normal write; never a bootstrap', () => {
    expect(calendarEditOptions(read('2026-12'), 'ACTIVE', mid)).toEqual({ mode: 'normal', reason: null });
    expect(calendarEditOptions(configured('2027-01', '2026-10', [1]), 'ACTIVE', mid).mode).toBe('normal');
  });

  it('a past month offers only the bootstrap, and only without any stored version', () => {
    expect(calendarEditOptions(read('2026-09'), 'ACTIVE', mid)).toEqual({ mode: 'bootstrap', reason: null });
    const later = calendarEditOptions(read('2026-09', { nextEffectiveFromMonth: '2026-12' }), 'ACTIVE', mid);
    expect(later.mode).toBeNull();
    expect(later.reason).toContain('Die einmalige Ersteinrichtung ist nicht mehr möglich, weil für dieses Projekt bereits Betriebstage ab Dezember 2026 gespeichert sind.');
    const own = calendarEditOptions(configured('2026-09', '2026-09', [1]), 'ACTIVE', mid);
    expect(own).toEqual({ mode: null, reason: 'September 2026 liegt in der Vergangenheit. Betriebstage vergangener Monate können nicht geändert werden.' });
  });

  it('an inactive project is read-only, also for the bootstrap', () => {
    expect(calendarEditOptions(read('2026-09'), 'INACTIVE', mid).mode).toBeNull();
    expect(calendarEditOptions(read('2026-12'), 'INACTIVE', mid).reason).toContain('Das Projekt ist inaktiv.');
  });

  it('month boundary: the previous month stays offered for a normal write while it may still be current somewhere (server decides)', () => {
    // 1.1.2027 05:00 UTC: UTC-12 is still in December 2026.
    const boundary = new Date(Date.UTC(2027, 0, 1, 5));
    expect(calendarEditOptions(read('2026-12'), 'ACTIVE', boundary).mode).toBe('normal');
    // 1.1.2027 13:00 UTC: December is past everywhere; with no version only the bootstrap remains.
    expect(calendarEditOptions(read('2026-12'), 'ACTIVE', new Date(Date.UTC(2027, 0, 1, 13))).mode).toBe('bootstrap');
  });
});

describe('F-A1-2 applicability interval', () => {
  it('without a later version the selection applies open-ended', () => {
    expect(applicabilityText(read('2026-12'))).toBe('Ihre Auswahl gilt ab Dezember 2026 für alle folgenden Monate, bis eine spätere Fassung gespeichert wird.');
  });

  it('a later version bounds the interval, across a year boundary', () => {
    expect(applicabilityText(read('2026-11', { nextEffectiveFromMonth: '2027-02' })))
      .toBe('Ihre Auswahl gilt von November 2026 bis einschließlich Januar 2027. Ab Februar 2027 gilt weiterhin die dort gespeicherte Fassung.');
    expect(applicabilityText(read('2026-12', { nextEffectiveFromMonth: '2027-01' })))
      .toBe('Ihre Auswahl gilt nur für Dezember 2026. Ab Januar 2027 gilt weiterhin die dort gespeicherte Fassung.');
  });
});

describe('F-A1-2 write failures', () => {
  it('no or an unreadable answer and technical 5xx are an unknown outcome; definitive refusals are not', () => {
    expect(calendarOutcomeUnknown(new ApiError('network', null, null, null))).toBe(true);
    expect(calendarOutcomeUnknown(new ApiError('invalid-response', null, null, null))).toBe(true);
    expect(calendarOutcomeUnknown(httpError(502, null))).toBe(true);
    expect(calendarOutcomeUnknown(new Error('x'))).toBe(true);
    expect(calendarOutcomeUnknown(httpError(409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT'))).toBe(false);
    expect(calendarOutcomeUnknown(httpError(429, 'RATE_LIMITED'))).toBe(false);
  });

  it('stale and unknown outcomes need a fresh read; inactive, 403 and 404 end the form', () => {
    expect(calendarNeedsReload(httpError(409, 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION'))).toBe(true);
    expect(calendarNeedsReload(httpError(409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT'))).toBe(false);
    expect(calendarNeedsReload(new ApiError('network', null, null, null))).toBe(true);
    expect(calendarWriteTerminal(httpError(409, 'PROJECT_INACTIVE'))).toBe(true);
    expect(calendarWriteTerminal(httpError(404, 'RESOURCE_NOT_FOUND'))).toBe(true);
    expect(calendarWriteTerminal(httpError(403, 'ACTION_FORBIDDEN'))).toBe(true);
    expect(calendarWriteTerminal(httpError(409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT'))).toBe(false);
  });

  it('explains the effective-month refusal differently for the normal write and the bootstrap', () => {
    const month = httpError(400, 'PROJECT_CALENDAR_INVALID', [{ pointer: '#/effectiveFromMonth', code: 'INVALID_FORMAT' }]);
    expect(calendarErrorText(month, 'normal', '2026-12')?.title).toBe('Monat nicht mehr änderbar');
    expect(calendarErrorText(month, 'bootstrap', '2026-09')).toEqual({
      title: 'Ersteinrichtung für September 2026 nicht möglich',
      description: expect.stringContaining('nur ab dem Monat des frühesten gespeicherten Dienstes dieses Projekts möglich') as string,
    });
    expect(calendarErrorText(httpError(400, 'PROJECT_CALENDAR_INVALID'), 'normal', '2026-12')?.title).toBe('Auswahl nicht angenommen');
  });

  it('every calendar refusal says that nothing was saved and names no duty, date or person', () => {
    const errors = [
      httpError(409, 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION'),
      httpError(409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT'),
      httpError(400, 'PROJECT_CALENDAR_INVALID', [{ pointer: '#/effectiveFromMonth', code: 'INVALID_FORMAT' }]),
      httpError(409, 'PROJECT_INACTIVE'),
      httpError(404, 'RESOURCE_NOT_FOUND'),
    ];
    for (const mode of ['normal', 'bootstrap'] as const) {
      for (const error of errors) {
        const text = calendarErrorText(error, mode, '2026-12')!;
        expect(text.description, `${mode} ${error.code}`).toContain('Es wurde nichts gespeichert.');
        expect(`${text.title} ${text.description}`).not.toMatch(/\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|Mira|krank|urlaub/i);
      }
    }
    // An unknown outcome claims neither success nor failure.
    const unknown = calendarErrorText(new ApiError('network', null, null, null), 'normal', '2026-12')!;
    expect(unknown.title).toBe('Ergebnis unbekannt');
    expect(unknown.description).not.toContain('nichts gespeichert');
    expect(calendarErrorText(httpError(429, 'RATE_LIMITED'), 'normal', '2026-12')).toBeUndefined();
  });
});
