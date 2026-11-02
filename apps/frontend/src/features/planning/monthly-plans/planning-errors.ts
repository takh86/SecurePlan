/**
 * German texts for errors of the planning writes. They are context-specific
 * versions of shared codes (e.g. PROJECT_INACTIVE, EMPLOYEE_INACTIVE) or the
 * planning-only codes. The server reports the FIRST violated rule only and
 * never names which selected person failed, so the texts do not either.
 * EMPLOYEE_UNAVAILABLE stays neutral: no reason (sickness, leave) is implied.
 */
import { ApiError } from '../../../shared/api/api-error';

export type ErrorText = { title: string; description: string };

const NOTHING_SAVED = 'Es wurde nichts gespeichert.';

const CREATE_PLAN: Partial<Record<string, ErrorText>> = {
  MONTHLY_PLAN_ALREADY_EXISTS: {
    title: 'Monatsplan existiert bereits',
    description: `Für dieses Projekt gibt es in diesem Monat bereits einen Monatsplan. Laden Sie die Übersicht neu, um ihn zu öffnen. ${NOTHING_SAVED}`,
  },
  PROJECT_INACTIVE: {
    title: 'Projekt ist inaktiv',
    description: `Für ein inaktives Projekt kann kein Monatsplan erstellt werden. Reaktivieren Sie das Projekt zuerst. ${NOTHING_SAVED}`,
  },
  RESOURCE_NOT_FOUND: {
    title: 'Projekt nicht verfügbar',
    description: `Das Projekt ist nicht mehr verfügbar. Laden Sie die Übersicht neu. ${NOTHING_SAVED}`,
  },
  INVALID_MONTH_START: { title: 'Monat ungültig', description: `Bitte wählen Sie einen gültigen Kalendermonat. ${NOTHING_SAVED}` },
  INVALID_DATE: { title: 'Monat ungültig', description: `Bitte wählen Sie einen gültigen Kalendermonat. ${NOTHING_SAVED}` },
};

const CREATE_DUTY: Partial<Record<string, ErrorText>> = {
  DUTY_ALREADY_EXISTS: {
    title: 'Dienst existiert bereits',
    description: `An diesem Datum gibt es in diesem Monatsplan bereits einen Dienst dieser Art. Laden Sie die Dienste neu. ${NOTHING_SAVED}`,
  },
  SHIFT_CONFIGURATION_MISSING: {
    title: 'Keine Schichtzeiten hinterlegt',
    description: `Für diese Dienstart sind für den Monat dieses Plans keine Schichtzeiten gespeichert. Legen Sie die Schichtzeiten im Projekt fest. ${NOTHING_SAVED}`,
  },
  DUTY_TIME_RANGE_INVALID: {
    title: 'Dienstzeit nicht bestimmbar',
    description: `Aus den gespeicherten Schichtzeiten ergibt sich für dieses Datum kein gültiger Dienstzeitraum. Prüfen Sie die Schichtzeiten des Projekts. ${NOTHING_SAVED}`,
  },
  DUTY_DATE_OUTSIDE_PLAN_MONTH: {
    title: 'Datum außerhalb des Planmonats',
    description: `Wählen Sie ein Datum im Monat dieses Plans. ${NOTHING_SAVED}`,
  },
  INVALID_DATE: { title: 'Datum ungültig', description: `Bitte wählen Sie ein gültiges Kalenderdatum. ${NOTHING_SAVED}` },
  PROJECT_INACTIVE: {
    title: 'Projekt ist inaktiv',
    description: `Für ein inaktives Projekt können keine Dienste angelegt werden. ${NOTHING_SAVED}`,
  },
  RESOURCE_NOT_FOUND: {
    title: 'Plan oder Person nicht verfügbar',
    description: `Der Monatsplan oder eine ausgewählte Person ist nicht mehr verfügbar. Laden Sie die Ansicht neu. ${NOTHING_SAVED}`,
  },
  EMPLOYEE_INACTIVE: {
    title: 'Person deaktiviert',
    description: `Eine ausgewählte Person ist deaktiviert. Passen Sie die Besetzung an. ${NOTHING_SAVED}`,
  },
  EMPLOYEE_NOT_EMPLOYED_FOR_DAY: {
    title: 'Am Diensttag nicht beschäftigt',
    description: `Für eine ausgewählte Person deckt der dokumentierte Beschäftigungszeitraum den Diensttag nicht ab. Passen Sie die Besetzung an. ${NOTHING_SAVED}`,
  },
  EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH: {
    title: 'Nicht dem Projekt zugeordnet',
    description: `Eine ausgewählte Person ist im Monat dieses Plans nicht diesem Projekt zugeordnet. Passen Sie die Besetzung an. ${NOTHING_SAVED}`,
  },
  EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT: {
    title: 'Nicht für diese Dienstart freigegeben',
    description: `Eine ausgewählte Person ist für diese Dienstart nicht freigegeben. Passen Sie die Besetzung an. ${NOTHING_SAVED}`,
  },
  EMPLOYEE_UNAVAILABLE: {
    title: 'Person nicht verfügbar',
    description: `Eine ausgewählte Person ist am Diensttag nicht verfügbar. Passen Sie die Besetzung an. ${NOTHING_SAVED}`,
  },
  DUTY_ASSIGNMENT_CONFLICT: {
    title: 'Zeitliche Überschneidung',
    description: `Eine ausgewählte Person ist in diesem Zeitraum bereits für einen anderen Dienst eingeplant. Passen Sie die Besetzung an. ${NOTHING_SAVED}`,
  },
};

const NOTHING_CHANGED = 'Es wurde nichts geändert.';

/** SP-12 PATCH: the staffing rules of creation apply to the whole resulting roster. */
const UPDATE_DUTY: Partial<Record<string, ErrorText>> = {
  ...Object.fromEntries(Object.entries(CREATE_DUTY).map(([code, text]) => [
    code,
    { title: text!.title, description: text!.description.replace(NOTHING_SAVED, NOTHING_CHANGED) },
  ])),
  DUTY_ALREADY_EXISTS: {
    title: 'Dienst existiert bereits',
    description: `An diesem Datum gibt es in diesem Monatsplan bereits einen Dienst dieser Art. Wählen Sie ein anderes Datum oder eine andere Dienstart. ${NOTHING_CHANGED}`,
  },
  PROJECT_INACTIVE: {
    title: 'Projekt ist inaktiv',
    description: `Dienste eines inaktiven Projekts können nicht geändert werden; Löschen bleibt möglich. ${NOTHING_CHANGED}`,
  },
  RESOURCE_NOT_FOUND: {
    title: 'Dienst oder Person nicht verfügbar',
    description: `Der Dienst oder eine ausgewählte Person ist nicht mehr verfügbar. Prüfen Sie den aktuellen Stand. ${NOTHING_CHANGED}`,
  },
  EMPLOYEE_INACTIVE: {
    title: 'Person deaktiviert',
    description: `Eine eingeplante Person ist deaktiviert. Beim Speichern wird die gesamte Besetzung geprüft; tragen Sie die Person aus. ${NOTHING_CHANGED}`,
  },
  EMPLOYEE_UNAVAILABLE: {
    title: 'Person nicht verfügbar',
    description: `Eine eingeplante Person ist am Diensttag nicht verfügbar. Beim Speichern wird die gesamte Besetzung geprüft; passen Sie die Besetzung an. ${NOTHING_CHANGED}`,
  },
  EDIT_LEASE_NOT_HELD: {
    title: 'Reservierung abgelaufen',
    description: `Ihre Reservierung für diesen Dienst gilt nicht mehr. ${NOTHING_CHANGED} Reservieren Sie den Dienst erneut; Ihre Eingaben bleiben erhalten.`,
  },
  PLAN_CONCURRENT_MODIFICATION: {
    title: 'Dienst wurde inzwischen geändert',
    description: `Der Dienst wurde geändert, seit Sie ihn geöffnet haben. ${NOTHING_CHANGED} Laden Sie den aktuellen Stand, bevor Sie erneut speichern.`,
  },
  EMPTY_PATCH: { title: 'Keine Änderungen', description: `Es wurden keine Änderungen übermittelt. ${NOTHING_CHANGED}` },
};

const NOTHING_REMOVED = 'Es wurde nichts gelöscht.';

/** SP-12 DELETE: no staffing rule applies; only visibility, lease and version. */
const REMOVE_DUTY: Partial<Record<string, ErrorText>> = {
  RESOURCE_NOT_FOUND: {
    title: 'Dienst nicht mehr vorhanden',
    description: 'Der Dienst ist nicht mehr vorhanden oder nicht mehr sichtbar. Laden Sie die Dienste neu.',
  },
  EDIT_LEASE_NOT_HELD: {
    title: 'Reservierung abgelaufen',
    description: `Ihre Reservierung für diesen Dienst gilt nicht mehr. ${NOTHING_REMOVED} Reservieren Sie den Dienst erneut, um ihn zu löschen.`,
  },
  PLAN_CONCURRENT_MODIFICATION: {
    title: 'Dienst wurde inzwischen geändert',
    description: `Der Dienst wurde geändert, seit Sie ihn geöffnet haben. ${NOTHING_REMOVED} Laden Sie den aktuellen Stand und entscheiden Sie erneut.`,
  },
};

/**
 * A lost or unreadable response after a write: the server may or may not have
 * committed. No success and no failure is claimed.
 */
const UNKNOWN_OUTCOME: Record<PlanningWrite, ErrorText> = {
  'create-plan': {
    title: 'Ergebnis unbekannt',
    description: 'Die Antwort des Servers ist nicht angekommen. Ob der Monatsplan erstellt wurde, ist unklar. Laden Sie die Übersicht neu und prüfen Sie den Stand, bevor Sie es erneut versuchen.',
  },
  'create-duty': {
    title: 'Ergebnis unbekannt',
    description: 'Die Antwort des Servers ist nicht angekommen. Ob der Dienst angelegt wurde, ist unklar. Laden Sie die Dienste neu und prüfen Sie den Stand, bevor Sie erneut speichern.',
  },
  'update-duty': {
    title: 'Ergebnis unbekannt',
    description: 'Die Antwort des Servers ist nicht angekommen. Ob die Änderungen gespeichert wurden, ist unklar. Prüfen Sie den aktuellen Stand, bevor Sie erneut speichern; Ihre Eingaben bleiben bis dahin erhalten.',
  },
  'remove-duty': {
    title: 'Ergebnis unbekannt',
    description: 'Die Antwort des Servers ist nicht angekommen. Ob der Dienst gelöscht wurde, ist unklar. Prüfen Sie den aktuellen Stand, bevor Sie es erneut versuchen.',
  },
};

/**
 * A 400 without a known code on an edit or removal: a missing/invalid
 * Expected-Version or lease header is a client defect, never the admin's input.
 */
const REJECTED_REQUEST: Record<'update-duty' | 'remove-duty', ErrorText> = {
  'update-duty': {
    title: 'Änderung nicht angenommen',
    description: `Die Anfrage wurde nicht angenommen. ${NOTHING_CHANGED} Laden Sie die Ansicht neu und versuchen Sie es erneut.`,
  },
  'remove-duty': {
    title: 'Löschen nicht angenommen',
    description: `Die Anfrage wurde nicht angenommen. ${NOTHING_REMOVED} Laden Sie die Ansicht neu und versuchen Sie es erneut.`,
  },
};

export type PlanningWrite = 'create-plan' | 'create-duty' | 'update-duty' | 'remove-duty';

const TEXTS: Record<PlanningWrite, Partial<Record<string, ErrorText>>> = {
  'create-plan': CREATE_PLAN,
  'create-duty': CREATE_DUTY,
  'update-duty': UPDATE_DUTY,
  'remove-duty': REMOVE_DUTY,
};

/** Context text for a failed planning write, or undefined for the shared default text. */
export function planningErrorText(error: unknown, write: PlanningWrite): ErrorText | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.kind === 'network' || error.kind === 'invalid-response') return UNKNOWN_OUTCOME[write];
  if (error.code === null) {
    return error.status === 400 && (write === 'update-duty' || write === 'remove-duty') ? REJECTED_REQUEST[write] : undefined;
  }
  return TEXTS[write][error.code];
}

/** The "outcome unknown" text of a write (lost or unreadable response). */
export function unknownOutcomeText(write: PlanningWrite): ErrorText {
  return UNKNOWN_OUTCOME[write];
}

/** True when the outcome of a write is unknown and the view should be re-read before another attempt. */
export function outcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || error.kind === 'invalid-response');
}
