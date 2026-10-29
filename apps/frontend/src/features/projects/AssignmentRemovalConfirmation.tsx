import { useEffect, useId, useRef, useState } from 'react';
import { removalQuestion, type RemovalSnapshot } from './assignment-removal';
import type { ProjectAssignmentsApi } from './project-assignments-api';

type ConfirmationProps = {
  /** The row as displayed when "Entfernen" was chosen; the DELETE is bound to it. */
  snapshot: RemovalSnapshot;
  /** The month lies in the window where only the company's time zone decides (R2-a). */
  uncertainMonth: boolean;
  api: ProjectAssignmentsApi;
  /** The DELETE settled (`null` = removed). The caller closes this and reloads; nothing is retried. */
  onSettled: (error: Error | null) => void;
  onCancel: () => void;
};

/**
 * #73 inline confirmation (no browser dialog) for removing ONE assignment of a
 * future month. It sends the confirmed snapshot's version as Expected-Version,
 * so a row changed since it was displayed is refused, never removed. The
 * caller reads the month again after every outcome, which also unmounts this
 * confirmation: it can never silently continue with a newer version.
 */
export function AssignmentRemovalConfirmation({ snapshot, uncertainMonth, api, onSettled, onCancel }: ConfirmationProps) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  // The row's button is disabled now: continue at the question instead of <body>.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function confirm() {
    // Prevents a double DELETE (UX 5.5 "Submitting").
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    let outcome: Error | null = null;
    try {
      await api.remove(snapshot.id, snapshot.version);
    } catch (cause) {
      outcome = cause instanceof Error ? cause : new Error('Removal failed');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
    onSettled(outcome);
  }

  return (
    <div className="employees-confirm assignment-correction" role="group" aria-labelledby={titleId} aria-busy={pending}>
      <h3 id={titleId} ref={heading} tabIndex={-1}>{removalQuestion(snapshot)}</h3>
      <ul>
        <li>Es wird kein Ersatz angelegt; Dienste und Beschäftigungsdaten bleiben unverändert.</li>
        <li>Der Monat ist danach für eine neue Zuordnung frei.</li>
        <li>Wurde die Zuordnung inzwischen geändert, wird sie nicht entfernt.</li>
      </ul>
      {uncertainMonth && (
        <p className="employees-card__hint">
          Ob der Monat bereits begonnen hat, entscheidet die Zeitzone des Unternehmens; das Entfernen kann abgelehnt werden.
        </p>
      )}
      <div className="employee-form__actions">
        <button
          type="button"
          className="employees-button employees-button--danger"
          disabled={pending}
          onClick={() => { void confirm(); }}
        >
          {pending ? 'Wird entfernt …' : 'Zuordnung entfernen'}
        </button>
        <button type="button" className="employees-button" disabled={pending} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
