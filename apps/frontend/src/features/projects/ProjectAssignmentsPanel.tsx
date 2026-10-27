import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ReadSource } from '../../shared/data/data-source';
import { MAX_PAGE_SIZE, loadAllPages } from '../../shared/data/load-all-pages';
import { useReadSource } from '../../shared/data/use-read-source';
import { formatMonthLabel, type MonthKey } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import { EMPLOYEE_STATUS, fullName, type Employee } from '../employees/employee-types';
import type { EmployeesApi } from '../employees/employees-api';
import { monthStartOf, type ProjectAssignment, type ProjectAssignmentsApi } from './project-assignments-api';
import type { Project } from './project-types';
import type { ProjectsApi } from './projects-api';

export type AssignmentApis = {
  assignments: ProjectAssignmentsApi;
  employees: EmployeesApi;
  projects: ProjectsApi;
};

type MonthData = {
  assignments: ProjectAssignment[];
  employees: Employee[];
  projects: Project[];
};

/** Feedback of the last write; kept outside the form so it survives the reload. */
type Outcome = { kind: 'success'; text: string } | { kind: 'error'; error: Error };

type PanelProps = {
  project: Project;
  month: MonthKey;
  apis: AssignmentApis;
};

/**
 * UX A09 "Mitarbeiterzuordnung": who belongs to this project in one calendar
 * month. The pool is the company's employees; the server decides (one project
 * per employee and month, active employee and project). After every write the
 * month is read again, so the view always shows the persisted state.
 * Mount with `key={month}`: a new month starts without old feedback.
 */
export function ProjectAssignmentsPanel({ project, month, apis }: PanelProps) {
  const source = useMemo<ReadSource<MonthKey, MonthData>>(
    () => ({
      kind: 'api',
      load: async (requested, signal) => {
        const [assignments, employees, projects] = await Promise.all([
          apis.assignments.listMonth(requested, signal),
          loadAllPages((page) => apis.employees.list({ page, pageSize: MAX_PAGE_SIZE }, signal)),
          loadAllPages((page) => apis.projects.list({ page, pageSize: MAX_PAGE_SIZE }, signal)),
        ]);
        return { assignments, employees, projects };
      },
    }),
    [apis],
  );
  const { state, retry } = useReadSource(source, month);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [focusOutcome, setFocusOutcome] = useState<object | null>(null);
  const monthLabel = formatMonthLabel(month);

  useEffect(() => {
    if (focusOutcome) outcomeRef.current?.focus();
  }, [focusOutcome]);

  function report(next: Outcome) {
    setOutcome(next);
    setFocusOutcome({});
    // Success or conflict: show the server's current state, not a guess.
    retry();
  }

  return (
    <div className="assignments">
      {/* Focus target after a write; the status region is always mounted so it is announced. */}
      <div ref={outcomeRef} tabIndex={-1} className="assignments__outcome">
        <div role="status" aria-live="polite">
          {outcome?.kind === 'success' && <p className="employees__notice">{outcome.text}</p>}
        </div>
        {outcome?.kind === 'error' && <ApiErrorAlert error={outcome.error} />}
      </div>

      {state.status === 'loading' ? (
        <LoadingState label="Zuordnungen werden geladen …" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <MonthContent
          project={project}
          month={month}
          monthLabel={monthLabel}
          data={state.data}
          apis={apis}
          onSaved={(employee) => report({
            kind: 'success',
            text: `${fullName(employee)} ist dem Projekt ${project.name} für ${monthLabel} zugeordnet.`,
          })}
          onFailed={(error) => report({ kind: 'error', error })}
          onFeedbackCleared={() => setOutcome(null)}
        />
      )}
    </div>
  );
}

type ContentProps = {
  project: Project;
  month: MonthKey;
  monthLabel: string;
  data: MonthData;
  apis: AssignmentApis;
  onSaved: (employee: Employee) => void;
  onFailed: (error: Error) => void;
  onFeedbackCleared: () => void;
};

function MonthContent({ project, month, monthLabel, data, apis, onSaved, onFailed, onFeedbackCleared }: ContentProps) {
  const captionId = useId();
  const employeesById = new Map(data.employees.map((employee) => [employee.id, employee]));
  const projectsById = new Map(data.projects.map((item) => [item.id, item]));
  const assignedHere = data.assignments.filter((assignment) => assignment.projectId === project.id);
  const otherProject = new Map(
    data.assignments
      .filter((assignment) => assignment.projectId !== project.id)
      .map((assignment) => [assignment.employeeId, projectsById.get(assignment.projectId)?.name ?? 'einem anderen Projekt']),
  );
  const assignedIds = new Set(assignedHere.map((assignment) => assignment.employeeId));
  // Pool: active employees not yet in this project for the month.
  const pool = data.employees.filter((employee) => employee.status === 'ACTIVE' && !assignedIds.has(employee.id));

  return (
    <>
      {assignedHere.length === 0 ? (
        <EmptyState
          title="Noch keine Zuordnungen"
          description={`Für ${monthLabel} sind diesem Projekt noch keine Mitarbeitenden zugeordnet.`}
        />
      ) : (
        <div className="employees-table__wrap">
          <table className="employees-table" aria-labelledby={captionId}>
            <caption id={captionId}>Zugeordnet im {monthLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Mitarbeiter-ID</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {assignedHere.map((assignment) => {
                const employee = employeesById.get(assignment.employeeId);
                const status = employee ? EMPLOYEE_STATUS[employee.status] : null;
                return (
                  <tr key={assignment.id}>
                    <th scope="row">{employee ? fullName(employee) : 'Unbekannte Person'}</th>
                    <td data-label="Mitarbeiter-ID">{employee?.employeeCode ?? '–'}</td>
                    <td data-label="Status">{status && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {project.status === 'ACTIVE' ? (
        <AssignForm
          project={project}
          month={month}
          monthLabel={monthLabel}
          pool={pool}
          otherProject={otherProject}
          assignments={apis.assignments}
          onSaved={onSaved}
          onFailed={onFailed}
          onFeedbackCleared={onFeedbackCleared}
        />
      ) : (
        <p className="employees-card__hint">
          Das Projekt ist inaktiv. Neue Zuordnungen sind nicht möglich; bestehende bleiben erhalten.
        </p>
      )}
    </>
  );
}

type FormProps = {
  project: Project;
  month: MonthKey;
  monthLabel: string;
  pool: Employee[];
  otherProject: Map<string, string>;
  assignments: ProjectAssignmentsApi;
  onSaved: (employee: Employee) => void;
  onFailed: (error: Error) => void;
  onFeedbackCleared: () => void;
};

function AssignForm({ project, month, monthLabel, pool, otherProject, assignments, onSaved, onFailed, onFeedbackCleared }: FormProps) {
  const [employeeId, setEmployeeId] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const select = useRef<HTMLSelectElement>(null);
  const id = useId();
  const selectable = pool.filter((employee) => !otherProject.has(employee.id));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Prevents a double mutation (UX 5.5 "Submitting").
    if (inFlight.current) return;
    const employee = selectable.find((candidate) => candidate.id === employeeId);
    if (!employee) {
      setFieldError('Bitte wählen Sie eine Person aus.');
      select.current?.focus();
      return;
    }
    setFieldError(null);
    onFeedbackCleared();
    inFlight.current = true;
    setSubmitting(true);
    try {
      await assignments.create({ employeeId: employee.id, projectId: project.id, monthStart: monthStartOf(month) });
      onSaved(employee);
    } catch (cause) {
      onFailed(cause instanceof Error ? cause : new Error('Assignment failed'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (pool.length === 0) {
    return <p className="employees-card__hint">Es gibt keine weiteren aktiven Mitarbeitenden, die zugeordnet werden können.</p>;
  }

  return (
    <form className="employee-form" noValidate aria-busy={submitting} onSubmit={(event) => { void submit(event); }}>
      <div className="employee-form__field">
        <label htmlFor={id}>Mitarbeiter:in für {monthLabel} zuordnen</label>
        <p id={`${id}-hint`} className="employee-form__hint">
          Je Kalendermonat gehört eine Person genau einem Projekt an. Bereits anders zugeordnete Personen sind nicht wählbar.
        </p>
        <select
          ref={select}
          id={id}
          className="assignments__select"
          value={employeeId}
          onChange={(event) => {
            setEmployeeId(event.target.value);
            setFieldError(null);
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-hint ${id}-error` : `${id}-hint`}
          disabled={submitting}
        >
          <option value="">Bitte auswählen</option>
          {pool.map((employee) => {
            const elsewhere = otherProject.get(employee.id);
            return (
              <option key={employee.id} value={employee.id} disabled={elsewhere !== undefined}>
                {`${fullName(employee)} (${employee.employeeCode})`}
                {elsewhere !== undefined && ` – bereits ${elsewhere} zugeordnet`}
              </option>
            );
          })}
        </select>
        {fieldError && <p id={`${id}-error`} className="employee-form__error">{fieldError}</p>}
      </div>
      <div className="employee-form__actions">
        <button type="submit" className="employees-button employees-button--primary" disabled={submitting}>
          {submitting ? 'Wird zugeordnet …' : 'Zuordnen'}
        </button>
      </div>
    </form>
  );
}
