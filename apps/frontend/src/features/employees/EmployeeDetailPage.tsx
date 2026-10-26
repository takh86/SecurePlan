import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import { ApiError } from '../../shared/api/api-error';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import { formatDate } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import { serverFieldErrors, toUpdateInput, valuesFromEmployee, type EmployeeFormValues } from './employee-form';
import { EmployeeForm, type SubmitOutcome } from './EmployeeForm';
import type { EmployeeNotice } from './EmployeeCreatePage';
import {
  ACCOUNT_STATUS,
  EMPLOYEE_STATUS,
  SHIFT_ELIGIBILITY_LABELS,
  fullName,
  type Employee,
} from './employee-types';
import type { EmployeesApi } from './employees-api';

type DetailProps = { employeeId: string; basePath: string; employees: EmployeesApi };

function noticeFromLocation(state: unknown): EmployeeNotice | null {
  return typeof state === 'object' && state !== null && (state as { notice?: unknown }).notice === 'created'
    ? 'created'
    : null;
}

export function EmployeeDetailPage({ employeeId, basePath, employees }: DetailProps) {
  const location = useLocation();
  const source = useMemo<ReadSource<string, Employee>>(
    () => ({ kind: 'api', load: (id, signal) => employees.get(id, signal) }),
    [employees],
  );
  const { state, retry } = useReadSource(source, employeeId);
  // Results of writes replace the loaded record without a re-fetch.
  const [updated, setUpdated] = useState<Employee | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    noticeFromLocation(location.state) === 'created'
      ? 'Mitarbeiter:in wurde angelegt. Das Konto wartet auf die Aktivierung durch die Person selbst. Ob die Einladungs-E-Mail zugestellt wurde, kann diese Ansicht nicht bestätigen.'
      : null,
  );
  const employee = updated ?? (state.status === 'ready' ? state.data : null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [focusNotice, setFocusNotice] = useState<object | null>(null);

  // After a write the acting control may be gone (e.g. the deactivate button):
  // move focus to the confirmation message instead of losing it.
  useEffect(() => {
    if (focusNotice) noticeRef.current?.focus();
  }, [focusNotice]);

  function reload() {
    setUpdated(null);
    retry();
  }

  return (
    <PageFrame title={employee ? fullName(employee) : 'Mitarbeiterdetails'}>
      <div className="employees employees--narrow">
        <Link className="employees__back" to={basePath}>Zurück zur Übersicht</Link>
        {/* Always mounted, so screen readers announce new messages. */}
        <div role="status" aria-live="polite">
          {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
        </div>
        {employee ? (
          <EmployeeDetails
            employee={employee}
            employees={employees}
            onChanged={(next, message) => {
              setUpdated(next);
              setNotice(message);
              setFocusNotice({});
            }}
            onStale={reload}
          />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={reload} />
        ) : (
          <LoadingState label="Mitarbeiterdaten werden geladen …" />
        )}
      </div>
    </PageFrame>
  );
}

type DetailsProps = {
  employee: Employee;
  employees: EmployeesApi;
  onChanged: (employee: Employee, message: string) => void;
  onStale: () => void;
};

function EmployeeDetails({ employee, employees, onChanged, onStale }: DetailsProps) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const dataSection = useRef<HTMLElement>(null);
  const returnFocusToEdit = useRef(false);
  const status = EMPLOYEE_STATUS[employee.status];

  useEffect(() => {
    if (editing) {
      // The edit button unmounts: continue in the first field instead of <body>.
      dataSection.current?.querySelector<HTMLElement>('input')?.focus();
    } else if (returnFocusToEdit.current) {
      returnFocusToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  const account = ACCOUNT_STATUS[employee.accountStatus];

  async function save(values: EmployeeFormValues): Promise<SubmitOutcome> {
    const changes = toUpdateInput(values, employee);
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      onChanged(employee, 'Es gab keine Änderungen zu speichern.');
      return undefined;
    }
    try {
      const saved = await employees.update(employee.id, changes);
      setEditing(false);
      onChanged(saved, 'Änderungen wurden gespeichert.');
      return undefined;
    } catch (error) {
      const fieldErrors = serverFieldErrors(error);
      return fieldErrors ? { fieldErrors } : { error: error instanceof Error ? error : new Error('Update failed') };
    }
  }

  return (
    <>
      <section className="employees-card" aria-labelledby="employee-status-title">
        <h2 id="employee-status-title">Status</h2>
        <div className="employees-card__badges">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <StatusBadge tone={account.tone}>{account.label}</StatusBadge>
        </div>
        {employee.accountStatus === 'PENDING_ACTIVATION' && employee.status === 'ACTIVE' && (
          <p>
            Die Person kann sich erst anmelden, nachdem sie ihr Konto über den Einladungslink aktiviert hat.
            Ein erneuter Versand der Einladung ist in dieser Ausbaustufe nicht über die Oberfläche möglich.
          </p>
        )}
        {employee.status === 'INACTIVE' && (
          <p>Diese Person ist deaktiviert. Eine Anmeldung ist nicht möglich; die Daten bleiben für die Historie erhalten.</p>
        )}
      </section>

      <section ref={dataSection} className="employees-card" aria-labelledby="employee-data-title">
        <h2 id="employee-data-title">Stammdaten</h2>
        {editing ? (
          <EmployeeForm
            mode="edit"
            initialValues={valuesFromEmployee(employee)}
            submitLabel="Änderungen speichern"
            pendingLabel="Wird gespeichert …"
            onSubmit={save}
            cancel={
              <button
                type="button"
                className="employees-button"
                onClick={() => {
                  // Return focus to where the user started.
                  returnFocusToEdit.current = true;
                  setEditing(false);
                }}
              >
                Abbrechen
              </button>
            }
          />
        ) : (
          <>
            <dl className="employees-card__facts">
              <div><dt>Mitarbeiter-ID</dt><dd>{employee.employeeCode}</dd></div>
              <div><dt>Anmelde-E-Mail</dt><dd>{employee.email}</dd></div>
              <div><dt>Schicht-Eignung</dt><dd>{SHIFT_ELIGIBILITY_LABELS[employee.shiftEligibility]}</dd></div>
              <div><dt>Beschäftigungsbeginn</dt><dd>{employee.employmentStart ? formatDate(employee.employmentStart) : 'Nicht angegeben'}</dd></div>
              <div><dt>Beschäftigungsende</dt><dd>{employee.employmentEnd ? formatDate(employee.employmentEnd) : 'Nicht angegeben'}</dd></div>
            </dl>
            <p className="employees-card__hint">Die Anmelde-E-Mail kann in dieser Ausbaustufe nicht geändert werden.</p>
            <button ref={editButton} type="button" className="employees-button" onClick={() => setEditing(true)}>
              Stammdaten bearbeiten
            </button>
          </>
        )}
      </section>

      {employee.status === 'ACTIVE' && (
        <DeactivationSection
          employee={employee}
          employees={employees}
          onDeactivated={(next) => onChanged(next, `${fullName(next)} wurde deaktiviert. Alle aktiven Sitzungen wurden beendet.`)}
          onStale={onStale}
        />
      )}
    </>
  );
}

type DeactivationProps = {
  employee: Employee;
  employees: EmployeesApi;
  onDeactivated: (employee: Employee) => void;
  onStale: () => void;
};

function DeactivationSection({ employee, employees, onDeactivated, onStale }: DeactivationProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) panelHeading.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);

  function cancel() {
    returnFocus.current = true;
    setError(null);
    setConfirming(false);
  }

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onDeactivated(await employees.deactivate(employee.id));
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error('Deactivation failed');
      setError(failure);
      // Someone else changed the record meanwhile: show the current state.
      if (failure instanceof ApiError && failure.code === 'EMPLOYEE_INACTIVE') onStale();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="employees-card employees-card--danger" aria-labelledby={titleId}>
      <h2 id={titleId}>Deaktivieren</h2>
      {!confirming ? (
        <button ref={trigger} type="button" className="employees-button employees-button--danger" onClick={() => setConfirming(true)}>
          Mitarbeiter:in deaktivieren …
        </button>
      ) : (
        <div className="employees-confirm" role="group" aria-labelledby={`${titleId}-confirm`}>
          <h3 id={`${titleId}-confirm`} ref={panelHeading} tabIndex={-1}>
            {fullName(employee)} wirklich deaktivieren?
          </h3>
          <ul>
            <li>Die Anmeldung ist danach nicht mehr möglich.</li>
            <li>Alle aktiven Sitzungen der Person werden sofort beendet.</li>
            <li>Offene Einladungslinks werden ungültig.</li>
            <li>Die Stammdaten bleiben für die Historie erhalten.</li>
            <li>Eine Reaktivierung ist in dieser Ausbaustufe nicht vorgesehen.</li>
          </ul>
          <ApiErrorAlert error={error} />
          <div className="employee-form__actions">
            <button
              type="button"
              className="employees-button employees-button--danger"
              disabled={pending}
              aria-busy={pending}
              onClick={() => { void confirm(); }}
            >
              {pending ? 'Wird deaktiviert …' : 'Jetzt deaktivieren'}
            </button>
            <button type="button" className="employees-button" disabled={pending} onClick={cancel}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
