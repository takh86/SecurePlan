/**
 * F-A1-2 operating calendar form model. The client explains the approved A1
 * rules before a request; the server stays authoritative (company month,
 * bootstrap month, dependency guard, project status, authorization).
 * There is NO default weekday set: nothing is ever preselected that the
 * server has not stored for this project.
 */
import { ApiError } from '../../shared/api/api-error';
import { isCertainlyPastMonth } from '../../shared/time/company-month';
import { addMonths, formatMonthLabel, type MonthKey } from '../../shared/time/month';
import { hasNoCalendarVersions, ISO_WEEKDAYS, type CalendarRead, type IsoWeekday } from './operating-calendar-api';
import type { ProjectStatus } from './project-types';

export const WEEKDAY_LABELS: Record<IsoWeekday, { short: string; long: string }> = {
  1: { short: 'Mo', long: 'Montag' },
  2: { short: 'Di', long: 'Dienstag' },
  3: { short: 'Mi', long: 'Mittwoch' },
  4: { short: 'Do', long: 'Donnerstag' },
  5: { short: 'Fr', long: 'Freitag' },
  6: { short: 'Sa', long: 'Samstag' },
  7: { short: 'So', long: 'Sonntag' },
};

/** `Montag, Dienstag und Freitag` in Monday-first order. */
export function weekdayList(days: Iterable<IsoWeekday>): string {
  const names = sortWeekdays(days).map((day) => WEEKDAY_LABELS[day].long);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} und ${names.at(-1)}`;
}

export function sortWeekdays(days: Iterable<IsoWeekday>): IsoWeekday[] {
  return ISO_WEEKDAYS.filter((day) => new Set(days).has(day));
}

export function sameWeekdays(a: Iterable<IsoWeekday>, b: Iterable<IsoWeekday>): boolean {
  return sortWeekdays(a).join(',') === sortWeekdays(b).join(',');
}

/** The stored set in force for the read's month (empty when MISSING). */
export function storedWeekdays(read: CalendarRead): IsoWeekday[] {
  return read.effective ? [...read.effective.operatingWeekdays] : [];
}

/** Change of the selection against the version in force; null when nothing is in force (MISSING). */
export function weekdayChange(read: CalendarRead, selection: Iterable<IsoWeekday>) {
  if (!read.effective) return null;
  const selected = new Set(selection);
  const before = new Set(read.effective.operatingWeekdays);
  return {
    closed: ISO_WEEKDAYS.filter((day) => before.has(day) && !selected.has(day)),
    opened: ISO_WEEKDAYS.filter((day) => !before.has(day) && selected.has(day)),
  };
}

/** `normal`: month-effective change from the current company month on; `bootstrap`: one-time historical setup. */
export type CalendarEditMode = 'normal' | 'bootstrap';

export type CalendarEditOptions =
  | { mode: CalendarEditMode; reason: null }
  | { mode: null; reason: string };

/**
 * Which write the screen offers for `read`:
 * - an inactive project is read-only;
 * - a month that is past in EVERY supported time zone offers only the
 *   bootstrap, and only while the project has no stored version at all;
 * - every other month offers the normal write (at a month boundary the server
 *   decides with the company's time zone and may still refuse it).
 */
export function calendarEditOptions(read: CalendarRead, status: ProjectStatus, now: Date): CalendarEditOptions {
  const monthLabel = formatMonthLabel(read.month);
  if (status !== 'ACTIVE') {
    return {
      mode: null,
      reason: 'Das Projekt ist inaktiv. Betriebstage können nur angesehen werden; reaktivieren Sie das Projekt, um sie zu ändern.',
    };
  }
  if (!isCertainlyPastMonth(read.month, now)) return { mode: 'normal', reason: null };
  if (hasNoCalendarVersions(read)) return { mode: 'bootstrap', reason: null };
  const past = `${monthLabel} liegt in der Vergangenheit. Betriebstage vergangener Monate können nicht geändert werden.`;
  return {
    mode: null,
    reason: read.state === 'MISSING' && read.nextEffectiveFromMonth !== null
      ? `${past} Die einmalige Ersteinrichtung ist nicht mehr möglich, weil für dieses Projekt bereits Betriebstage ab ${formatMonthLabel(read.nextEffectiveFromMonth)} gespeichert sind.`
      : past,
  };
}

/** Applicability of a write to `read.month`: up to the next stored version, if any. */
export function applicabilityText(read: CalendarRead): string {
  const from = formatMonthLabel(read.month);
  const next = read.nextEffectiveFromMonth;
  if (next === null) return `Ihre Auswahl gilt ab ${from} für alle folgenden Monate, bis eine spätere Fassung gespeichert wird.`;
  const last = addMonths(next, -1);
  const until = last === read.month ? `nur für ${from}` : `von ${from} bis einschließlich ${formatMonthLabel(last)}`;
  return `Ihre Auswahl gilt ${until}. Ab ${formatMonthLabel(next)} gilt weiterhin die dort gespeicherte Fassung.`;
}

export type CalendarErrorText = { title: string; description: string };

const NOTHING_SAVED = 'Es wurde nichts gespeichert.';
const KEPT = 'Ihre Auswahl bleibt erhalten.';

/**
 * True when a failed write may still have been applied: no or an unreadable
 * response, or a technical 5xx. A rollback is never inferred from a missing
 * answer; the administrator reads the current state before the next write.
 */
export function calendarOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.kind !== 'http' || error.status === null) return true;
  return error.status >= 500;
}

/** Refusals after which the reviewed read is no longer a valid basis (stale or unknown). */
export function calendarNeedsReload(error: unknown): boolean {
  return calendarOutcomeUnknown(error)
    || (error instanceof ApiError && error.code === 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION');
}

/** Refusals after which this form cannot save at all (only "Abbrechen" remains). */
export function calendarWriteTerminal(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http'
    && (error.code === 'PROJECT_INACTIVE' || error.status === 404 || error.status === 403);
}

/** Context-specific German text, or undefined for the shared fallback text. */
export function calendarErrorText(error: unknown, mode: CalendarEditMode, month: MonthKey): CalendarErrorText | undefined {
  const monthLabel = formatMonthLabel(month);
  if (calendarOutcomeUnknown(error)) {
    return {
      title: 'Ergebnis unbekannt',
      description: `Es ist nicht bekannt, ob die Betriebstage ab ${monthLabel} gespeichert wurden. Laden Sie den aktuellen Stand und prüfen Sie ihn, bevor Sie erneut speichern. ${KEPT}`,
    };
  }
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION':
      return {
        title: 'Betriebstage wurden inzwischen geändert',
        description: `Seit dem Laden wurden die Betriebstage dieses Projekts geändert. Laden Sie den aktuellen Stand und prüfen Sie Ihre Auswahl, bevor Sie erneut speichern. ${KEPT} ${NOTHING_SAVED}`,
      };
    case 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT':
      return mode === 'bootstrap'
        ? {
            title: 'Gespeicherte Dienste an ausgeschlossenen Tagen',
            description: `Die Ersteinrichtung muss alle gespeicherten Dienste ab ${monthLabel} abdecken, auch Dienste ohne Besetzung und Dienste veröffentlichter Pläne. Mindestens ein Dienst beginnt an einem Wochentag, den Ihre Auswahl ausschließt. Dienste werden dabei nie geändert oder gelöscht. ${KEPT} ${NOTHING_SAVED}`,
          }
        : {
            title: 'Gespeicherte Dienste an geschlossenen Tagen',
            description: `Im Geltungszeitraum ab ${monthLabel} beginnt mindestens ein gespeicherter Dienst an einem Wochentag, den Ihre Auswahl schließen würde; auch Dienste ohne Besetzung und Dienste veröffentlichter Pläne zählen. Wählen Sie diese Wochentage wieder aus, wählen Sie einen späteren Monat oder ändern bzw. löschen Sie die betroffenen Dienste ausdrücklich in der Monatsplanung. ${KEPT} ${NOTHING_SAVED}`,
          };
    case 'PROJECT_CALENDAR_INVALID':
      if (error.fieldErrors.some((field) => field.pointer === '#/effectiveFromMonth')) {
        return mode === 'bootstrap'
          ? {
              title: `Ersteinrichtung für ${monthLabel} nicht möglich`,
              description: `Die einmalige Ersteinrichtung ist nur ab dem Monat des frühesten gespeicherten Dienstes dieses Projekts möglich; gibt es keine gespeicherten Dienste, ab dem aktuellen Monat Ihres Unternehmens. Wechseln Sie über die Monatsnavigation zu diesem Monat. ${NOTHING_SAVED}`,
            }
          : {
              title: 'Monat nicht mehr änderbar',
              description: `Betriebstage können nur ab dem aktuellen Monat Ihres Unternehmens festgelegt werden; ${monthLabel} liegt in der Zeitzone Ihres Unternehmens bereits in der Vergangenheit. ${NOTHING_SAVED}`,
            };
      }
      return { title: 'Auswahl nicht angenommen', description: `Bitte prüfen Sie die Auswahl der Betriebstage. ${NOTHING_SAVED}` };
    case 'PROJECT_INACTIVE':
      return {
        title: 'Projekt ist inaktiv',
        description: `Für ein inaktives Projekt können keine Betriebstage gespeichert werden. Reaktivieren Sie das Projekt zuerst. ${NOTHING_SAVED}`,
      };
    case 'RESOURCE_NOT_FOUND':
      return { title: 'Projekt nicht verfügbar', description: `Das Projekt ist nicht mehr verfügbar. Laden Sie die Übersicht neu. ${NOTHING_SAVED}` };
    default:
      return undefined;
  }
}
