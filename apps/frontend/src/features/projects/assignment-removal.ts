/**
 * #73 removal of one month assignment of a FUTURE month: the confirmed
 * snapshot and the texts for each outcome. The server decides everything
 * (company time zone, version, planning data); the client never retries.
 */
import { ApiError } from '../../shared/api/api-error';

/**
 * What the admin saw and confirmed. The removal sends exactly this `version`,
 * so a row changed in the meantime is refused instead of removed.
 */
export type RemovalSnapshot = {
  id: string;
  version: number;
  employeeName: string;
  projectName: string;
  monthLabel: string;
};

export function removalQuestion(snapshot: RemovalSnapshot): string {
  return `Zuordnung ${snapshot.employeeName} → ${snapshot.projectName}, ${snapshot.monthLabel} entfernen?`;
}

export function removedText(snapshot: RemovalSnapshot): string {
  return `Zuordnung entfernt: ${snapshot.employeeName}, ${snapshot.projectName}, ${snapshot.monthLabel}. Ein Ersatz wird nicht automatisch angelegt.`;
}

/**
 * Removal-specific wording for a failed DELETE; `null` keeps the general text
 * (sign-in, permission, server errors). Shared codes mean something specific here.
 */
export function removalFailureText(error: unknown): { title: string; description: string } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.kind === 'network') {
    return {
      title: 'Ergebnis unbekannt',
      description: 'Ob die Zuordnung entfernt wurde, ist nicht bekannt. Die Ansicht wird neu geladen, um den aktuellen Stand zu zeigen.',
    };
  }
  if (error.status === 404) {
    return {
      title: 'Zuordnung nicht mehr vorhanden',
      description: 'Die Zuordnung ist nicht mehr vorhanden (bereits entfernt). Die Ansicht wurde neu geladen.',
    };
  }
  if (error.code === 'PROJECT_ASSIGNMENT_CONFLICT') {
    return {
      title: 'Zuordnung wurde geändert',
      description: 'Die Zuordnung wurde zwischenzeitlich geändert. Die Ansicht wurde neu geladen – bitte prüfen und bei Bedarf erneut entfernen.',
    };
  }
  if (error.code === 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT') {
    return {
      title: 'Entfernen nicht möglich',
      description: 'Nur Zuordnungen künftiger Monate können entfernt werden; maßgeblich ist die Zeitzone des Unternehmens. Auch bestehende Planungsdaten können das Entfernen verhindern. Es wurde nichts geändert.',
    };
  }
  // Missing or invalid Expected-Version: a client defect, never the admin's input.
  if (error.status === 400) {
    return {
      title: 'Anfrage unvollständig',
      description: 'Die Anfrage war unvollständig. Bitte laden Sie die Ansicht neu.',
    };
  }
  return null;
}
