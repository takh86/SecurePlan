/**
 * A2 employee-month Save protocol (#88, contract A2-GATE-1), pure rules:
 *
 * - The request is the COMPLETE desired month (every date, OFF included) with
 *   the exact preconditions of the read the draft is based on: lifecycle,
 *   creation checksum, effective calendar token and both slot tokens per date
 *   (also empty duties and duties staffed only by others). Other people,
 *   assignment IDs, sources, times and tenant data are never sent.
 * - One attempt = one Idempotency-Key and one frozen body. Only an unknown
 *   outcome keeps them; a definite refusal ends the attempt, and any later
 *   save is a new decision with a new key.
 * - Unknown outcome (no/unreadable answer, 5xx, 429, the key still running):
 *   ask the server (`save-result`) before anything else. COMPLETED proves the
 *   commit; NOT_COMPLETED proves failure and allows an explicitly confirmed
 *   resend of the SAME key and body; UNKNOWN proves nothing and requires a
 *   fresh read and a new decision. A matching current state never proves
 *   which command produced it.
 */
import { ApiError } from '../../../shared/api/api-error';
import type { DateOnly } from '../../../shared/time/month';
import { newIdempotencyKey } from './initial-publish';
import { wanted, type DayIssue, type EmployeeMonthDraft } from './employee-month-draft';
import type { EmployeeMonthRead, MonthSlot, SaveEmployeeMonthBody, SaveResult, SlotToken } from './employee-month-api';

function token(slot: MonthSlot | null): SlotToken | null {
  return slot === null ? null : { id: slot.dutyId, version: slot.version };
}

/**
 * The request for the draft's wanted month, built only from the read the
 * draft is based on (`draft.base.source`). Throws for a caller defect: a
 * preview draft, a date that still has both shifts, or a base that does not
 * match its read.
 */
export function buildSaveBody(draft: EmployeeMonthDraft): SaveEmployeeMonthBody {
  const read = draft.base.source;
  if (!read) throw new Error('A preview draft has no save basis');
  const dates = read.days.map((day) => day.date);
  if (dates.length !== draft.base.days.length || dates.some((date, index) => date !== draft.base.days[index])) {
    throw new Error('The draft does not match its read');
  }
  const days = read.days.map((day) => {
    const plan = wanted(draft, day.date);
    if (plan === 'BOTH') throw new Error('A date still has both shifts');
    return Object.freeze({
      date: day.date,
      expected: Object.freeze({ day: token(day.day), night: token(day.night) }),
      desired: Object.freeze(plan === null ? { state: 'OFF' as const } : { state: plan.kind, role: plan.role }),
    });
  });
  return Object.freeze({
    expectedPlan: Object.freeze({ status: read.plan.status, publishedAt: read.plan.publishedAt }),
    expectedCreationContext: read.creationContextFingerprint,
    expectedCalendar: read.calendar === null ? null : Object.freeze({ id: read.calendar.id, version: read.calendar.version }),
    days: Object.freeze(days),
  });
}

/** One save decision: its route, key and exact body never change. */
export type SaveAttempt = Readonly<{ planId: string; employeeId: string; key: string; body: SaveEmployeeMonthBody }>;

export function newSaveAttempt(draft: EmployeeMonthDraft): SaveAttempt {
  const body = buildSaveBody(draft);
  const read = draft.base.source!;
  return Object.freeze({ planId: read.plan.id, employeeId: read.employeeId, key: newIdempotencyKey(), body });
}

export type RefusalStage = 'PRECONDITION' | 'LEASE' | 'VALIDATION' | 'REQUEST' | 'OTHER';

/** A definite refusal: nothing was saved. */
export type SaveRefusal = {
  stage: RefusalStage;
  /** Dated findings, at most one per date and shift (may be empty). */
  issues: readonly DayIssue[];
  /** A fresh read must come before the next attempt (the basis is stale or the request was not accepted). */
  needsReload: boolean;
  correlationId: string | null;
};

export type SaveFailure =
  /** The command may have committed (or may still commit): ask the server before anything else. */
  | { kind: 'unknown' }
  | { kind: 'refused'; refusal: SaveRefusal }
  /** Concealed 404: the plan or the person is no longer visible. Nothing was saved. */
  | { kind: 'gone' }
  /** 403 (role or CSRF): nothing was saved; the page must be loaded again. */
  | { kind: 'forbidden' }
  /** 401: the session is gone; the session boundary shows the login. */
  | { kind: 'signed-out' };

function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.kind !== 'http' || error.status === null) return true;
  return error.status >= 500 || error.status === 429 || error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
}

/** Classifies a failed POST …/save. A rollback is never inferred from a missing answer. */
export function classifySaveError(error: unknown): SaveFailure {
  if (outcomeUnknown(error) || !(error instanceof ApiError)) return { kind: 'unknown' };
  switch (error.status) {
    case 401:
      return { kind: 'signed-out' };
    case 403:
      return { kind: 'forbidden' };
    case 404:
      return { kind: 'gone' };
  }
  const correlationId = error.correlationId;
  const conflict = error.employeeMonthConflict;
  if (error.status === 409 && conflict) {
    return {
      kind: 'refused',
      refusal: {
        stage: conflict.stage,
        issues: conflict.conflicts.map(({ date, shiftKind, reason }) => ({ date, kind: shiftKind, reason })),
        needsReload: conflict.stage === 'PRECONDITION',
        correlationId,
      },
    };
  }
  if (error.status === 409 && error.code === 'PLAN_CONCURRENT_MODIFICATION') {
    return { kind: 'refused', refusal: { stage: 'PRECONDITION', issues: [], needsReload: true, correlationId } };
  }
  const stage: RefusalStage = error.status === 400 || error.status === 413 || error.status === 415 ? 'REQUEST' : 'OTHER';
  return { kind: 'refused', refusal: { stage, issues: [], needsReload: true, correlationId } };
}

export type LookupFailure = 'unknown' | 'in-progress' | 'gone' | 'forbidden' | 'signed-out';

/** A failed GET …/save-result teaches nothing about the command, except a contended key (still running). */
export function classifyLookupError(error: unknown): LookupFailure {
  if (!(error instanceof ApiError) || error.kind !== 'http') return 'unknown';
  if (error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') return 'in-progress';
  if (error.status === 401) return 'signed-out';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404) return 'gone';
  return 'unknown';
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** Success line of a receipt (fresh or replayed): it proves the commit, nothing more. */
export function savedText(result: SaveResult): string {
  if (result.outcome === 'NO_OP') return 'Der Monat war bereits so gespeichert. Es wurde nichts geändert.';
  const { createdDuties, changedDuties } = result.counts;
  const parts = [
    createdDuties > 0 ? `${plural(createdDuties, 'Dienst', 'Dienste')} angelegt` : null,
    changedDuties > 0 ? `${plural(changedDuties, 'Dienst', 'Dienste')} geändert` : null,
  ].filter(Boolean);
  return `Der Monat wurde gespeichert: ${parts.join(', ')}.`;
}

export const REFUSAL_TITLE: Record<RefusalStage, string> = {
  PRECONDITION: 'Monat nicht gespeichert: inzwischen geändert',
  LEASE: 'Monat nicht gespeichert: Dienst wird bearbeitet',
  VALIDATION: 'Monat nicht gespeichert',
  REQUEST: 'Monat nicht gespeichert',
  OTHER: 'Monat nicht gespeichert',
};

const KEPT = 'Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.';

/** Lead text of a refusal; dated findings are listed separately. */
export function refusalText(refusal: SaveRefusal): string {
  switch (refusal.stage) {
    case 'PRECONDITION':
      return `Seit dem Laden wurden der Monat dieser Person, der Plan oder die Betriebstage geändert. ${KEPT} Laden Sie den aktuellen Stand und prüfen Sie Ihre Auswahl.`;
    case 'LEASE':
      return `Mindestens ein betroffener Dienst wird gerade einzeln bearbeitet. ${KEPT} Speichern Sie erneut, wenn die Bearbeitung abgeschlossen ist.`;
    case 'VALIDATION': {
      const dates = new Set(refusal.issues.map((issue) => issue.date)).size;
      return dates === 0
        ? `${KEPT} Prüfen Sie Ihre Auswahl.`
        : `${KEPT} Bitte prüfen Sie ${plural(dates, 'Tag', 'Tage')}:`;
    }
    default:
      return `Die Anfrage wurde nicht angenommen. ${KEPT} Laden Sie den aktuellen Stand und prüfen Sie Ihre Auswahl.`;
  }
}

function sameToken(a: { id: string; version: number } | null, b: { id: string; version: number } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id.toLowerCase() === b.id.toLowerCase() && a.version === b.version;
}

function sameDates(a: readonly DateOnly[], b: readonly DateOnly[]): boolean {
  return a.length === b.length && a.every((date, index) => date === b[index]);
}

/**
 * Month-wide changes between two reads, in words (slot changes are reported by
 * the draft rebase). Each of them changes the save's preconditions, so the
 * admin reviews the month again before the next save.
 */
export function readDrift(before: EmployeeMonthRead, after: EmployeeMonthRead): string[] {
  const notes: string[] = [];
  if (before.plan.status !== after.plan.status || before.plan.publishedAt !== after.plan.publishedAt) {
    notes.push(after.plan.status === 'PUBLISHED'
      ? 'Der Plan wurde inzwischen veröffentlicht: Gespeicherte Änderungen gelten danach sofort.'
      : 'Der Status des Plans wurde inzwischen geändert.');
  }
  const calendarChanged = !sameToken(before.calendar, after.calendar);
  if (calendarChanged) notes.push('Die Betriebstage des Projekts wurden inzwischen geändert.');
  if (!calendarChanged && before.creationContextFingerprint !== after.creationContextFingerprint) {
    notes.push('Die Grundlagen für neue Dienste (zum Beispiel die Schichtzeiten) wurden inzwischen geändert.');
  }
  if (!sameDates(before.unavailableDates, after.unavailableDates)) {
    notes.push('Die Verfügbarkeit dieser Person wurde inzwischen geändert.');
  }
  return notes;
}
