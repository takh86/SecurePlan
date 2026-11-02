/**
 * German texts for errors of the two planning writes. They are context-specific
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

/**
 * A lost or unreadable response after a create request: the server may or may
 * not have committed. No success and no failure is claimed.
 */
const UNKNOWN_OUTCOME: Record<'create-plan' | 'create-duty', ErrorText> = {
  'create-plan': {
    title: 'Ergebnis unbekannt',
    description: 'Die Antwort des Servers ist nicht angekommen. Ob der Monatsplan erstellt wurde, ist unklar. Laden Sie die Übersicht neu und prüfen Sie den Stand, bevor Sie es erneut versuchen.',
  },
  'create-duty': {
    title: 'Ergebnis unbekannt',
    description: 'Die Antwort des Servers ist nicht angekommen. Ob der Dienst angelegt wurde, ist unklar. Laden Sie die Dienste neu und prüfen Sie den Stand, bevor Sie erneut speichern.',
  },
};

export type PlanningWrite = 'create-plan' | 'create-duty';

/** Context text for a failed planning write, or undefined for the shared default text. */
export function planningErrorText(error: unknown, write: PlanningWrite): ErrorText | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.kind === 'network' || error.kind === 'invalid-response') return UNKNOWN_OUTCOME[write];
  if (error.code === null) return undefined;
  return (write === 'create-plan' ? CREATE_PLAN : CREATE_DUTY)[error.code];
}

/** True when the outcome of a write is unknown and the view should be re-read before another attempt. */
export function outcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || error.kind === 'invalid-response');
}
