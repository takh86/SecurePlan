import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import { futureMonthCertainty } from '../../shared/time/company-month';
import { systemClock } from '../../shared/time/clock';
import { formatMonthLabel, type MonthKey } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import { AssignmentRemovalConfirmation } from '../projects/AssignmentRemovalConfirmation';
import { removalFailureText, removedText, type RemovalSnapshot } from '../projects/assignment-removal';
import { PROJECT_STATUS } from '../projects/project-types';
import { fullName, type Employee } from './employee-types';
import type { EmployeeFutureAssignmentsApi, FutureAssignmentPage } from './employee-future-assignments-api';

export type FutureAssignmentsHandle = { review: () => void };
type Props = { employee: Employee; api: EmployeeFutureAssignmentsApi; ref?: Ref<FutureAssignmentsHandle> };
type Outcome = { kind: 'success'; text: string } | { kind: 'error'; error: Error };

/** Independent section state: refreshing assignments never remounts the employee form. */
export function EmployeeFutureAssignmentsSection({ employee, api, ref }: Props) {
  const [page, setPage] = useState(1);
  const source = useMemo<ReadSource<number, FutureAssignmentPage>>(
    () => ({ kind: 'api', load: (requestedPage, signal) => api.list(employee.id, requestedPage, signal) }),
    [api, employee.id],
  );
  const { state, retry } = useReadSource(source, page);
  const [removing, setRemoving] = useState<RemovalSnapshot | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [focus, setFocus] = useState<{ target: 'heading' | 'outcome' | 'trigger' } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const confirmingAssignment =
    state.status === 'ready' ? state.data.items.find((item) => item.id === removing?.id) : undefined;

  useEffect(() => {
    if (focus?.target === 'heading') heading.current?.focus();
    if (focus?.target === 'outcome') feedback.current?.focus();
    if (focus?.target === 'trigger') trigger.current?.focus();
  }, [focus]);

  function reload(nextPage = page) {
    setRemoving(null);
    setPage(nextPage);
    retry();
  }

  useImperativeHandle(ref, () => ({
    review() {
      setOutcome(null);
      reload(1);
      setFocus({ target: 'heading' });
    },
  }));

  function changePage(nextPage: number) {
    setOutcome(null);
    reload(nextPage);
    setFocus({ target: 'heading' });
  }

  return (
    <section className="employees-card employee-future-assignments" aria-labelledby={titleId}>
      <h2 id={titleId} ref={heading} tabIndex={-1}>
        Zukünftige Projektzuordnungen
      </h2>
      <p className="employees-card__hint">
        Monate nach dem aktuellen Unternehmensmonat. Laufende und vergangene Monate werden hier nicht angezeigt. Die
        Zeitzone des Unternehmens ist maßgeblich; Planungsdaten können das Entfernen verhindern.
      </p>
      <div ref={feedback} tabIndex={-1}>
        <div role="status" aria-live="polite">
          {outcome?.kind === 'success' && <p className="employees__notice">{outcome.text}</p>}
        </div>
        {outcome?.kind === 'error' && (
          <ApiErrorAlert error={outcome.error} text={removalFailureText(outcome.error) ?? undefined} />
        )}
      </div>
      <button
        type="button"
        className="employees-button"
        disabled={removing !== null || state.status === 'loading'}
        onClick={() => {
          reload();
          setFocus({ target: 'heading' });
        }}
      >
        Liste aktualisieren
      </button>

      {state.status === 'loading' ? (
        <LoadingState label="Zukünftige Projektzuordnungen werden geladen …" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={() => reload()} />
      ) : (
        <>
          <p>{state.data.pagination.totalItems} zukünftige Projektzuordnungen</p>
          {state.data.pagination.totalItems === 0 ? (
            <EmptyState
              title="Keine zukünftigen Projektzuordnungen vorhanden."
              description="Beschäftigungsdaten können Sie bei Bedarf separat bearbeiten. Es wird kein Ersatz automatisch zugeordnet."
            />
          ) : state.data.items.length === 0 ? (
            <>
              <p>
                Auf dieser Seite sind keine Zuordnungen vorhanden. Die Liste kann sich zwischenzeitlich geändert haben.
              </p>
              <button type="button" className="employees-button" onClick={() => changePage(1)}>
                Zur ersten Seite
              </button>
            </>
          ) : (
            <div className="employees-table-wrap">
              <table className="employees-table" aria-labelledby={titleId}>
                <thead>
                  <tr>
                    <th scope="col">Projekt</th>
                    <th scope="col">Monat</th>
                    <th scope="col">Projektstatus</th>
                    <th scope="col">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.items.map((assignment) => {
                    const projectName = assignment.projectName ?? 'Projekt nicht verfügbar';
                    const monthLabel = formatMonthLabel(assignment.monthStart.slice(0, 7) as MonthKey);
                    return (
                      <tr key={assignment.id}>
                        <th scope="row">
                          {projectName}
                          {assignment.projectName === null && (
                            <span className="employee-future-assignments__reference">
                              Referenz: {assignment.projectId}
                            </span>
                          )}
                        </th>
                        <td data-label="Monat">{monthLabel}</td>
                        <td data-label="Projektstatus">
                          {assignment.projectStatus === null ? (
                            'Nicht verfügbar'
                          ) : (
                            <StatusBadge tone={PROJECT_STATUS[assignment.projectStatus].tone}>
                              {PROJECT_STATUS[assignment.projectStatus].label}
                            </StatusBadge>
                          )}
                        </td>
                        <td data-label="Aktion">
                          <button
                            type="button"
                            className="employees-button employees-button--danger"
                            aria-label={`Entfernen: ${projectName}, ${monthLabel}`}
                            disabled={removing !== null}
                            onClick={(event) => {
                              trigger.current = event.currentTarget;
                              setOutcome(null);
                              setRemoving({
                                id: assignment.id,
                                version: assignment.version,
                                employeeName: fullName(employee),
                                projectName,
                                monthLabel,
                              });
                            }}
                          >
                            Entfernen
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(state.data.pagination.totalPages > 1 || page > 1) && (
            <nav className="employees__pagination" aria-label="Seiten der zukünftigen Projektzuordnungen">
              <button
                type="button"
                className="employees-button"
                disabled={page <= 1 || removing !== null}
                onClick={() => changePage(page - 1)}
              >
                Vorherige Seite
              </button>
              <span>
                {page <= state.data.pagination.totalPages
                  ? `Seite ${page} von ${state.data.pagination.totalPages}`
                  : `Seite ${page} ist nicht mehr belegt.`}
              </span>
              <button
                type="button"
                className="employees-button"
                disabled={page >= state.data.pagination.totalPages || removing !== null}
                onClick={() => changePage(page + 1)}
              >
                Nächste Seite
              </button>
            </nav>
          )}
          {removing && confirmingAssignment && (
            <AssignmentRemovalConfirmation
              snapshot={removing}
              // A hint only; the returned rows were future in the server snapshot.
              uncertainMonth={
                futureMonthCertainty(confirmingAssignment.monthStart.slice(0, 7) as MonthKey, systemClock()) !==
                'always'
              }
              api={api}
              onCancel={() => {
                setRemoving(null);
                setFocus({ target: 'trigger' });
              }}
              onSettled={(error) => {
                setOutcome(
                  error === null ? { kind: 'success', text: removedText(removing) } : { kind: 'error', error },
                );
                reload(1);
                setFocus({ target: 'outcome' });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
