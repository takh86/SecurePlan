import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../shared/api/api-error';
import { formatMonthLabel } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { fullName, type Employee } from '../employees/employee-types';
import {
  correctionChanges,
  initialCorrection,
  isSameCorrection,
  serverCorrectionErrors,
  validateCorrection,
  type CorrectionErrors,
  type CorrectionField,
  type CorrectionValues,
} from './assignment-correction';
import type { EditState } from './edit-state';
import type { ProjectAssignment, ProjectAssignmentsApi } from './project-assignments-api';
import type { Project } from './project-types';

type FormProps = {
  assignment: ProjectAssignment;
  employees: Employee[];
  projects: Project[];
  api: ProjectAssignmentsApi;
  /** The correction was stored; `saved` is the server's answer. */
  onSaved: (saved: ProjectAssignment) => void;
  /** Nothing differs from the persisted assignment: no request was sent. */
  onUnchanged: () => void;
  onCancel: () => void;
  /** Discards the input and reads the current state again (after a failed save). */
  onDiscardAndReload: () => void;
  onEditStateChange: (state: EditState) => void;
};

/**
 * Correction of ONE existing month assignment (employee, project, month or a
 * combination). Only the changed fields are sent; the server re-validates the
 * whole result and stays the authority. The assignment is changed in place,
 * nothing is deleted, and the list is never moved optimistically: the caller
 * reads the month again after a successful save.
 */
export function AssignmentCorrectionForm({
  assignment, employees, projects, api, onSaved, onUnchanged, onCancel, onDiscardAndReload, onEditStateChange,
}: FormProps) {
  const [initial] = useState(() => initialCorrection(assignment));
  const [values, setValues] = useState<CorrectionValues>(initial);
  const [errors, setErrors] = useState<CorrectionErrors>({});
  const [formError, setFormError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // A new object per request, so the same target can be focused again.
  const [focusRequest, setFocusRequest] = useState<{ target: 'invalid' | 'alert' } | null>(null);
  const titleId = useId();
  const fieldId = useId();
  const dirty = !isSameCorrection(values, initial);

  const current = employees.find((employee) => employee.id === assignment.employeeId);
  const currentName = current ? fullName(current) : 'Unbekannte Person';
  const currentProject = projects.find((item) => item.id === assignment.projectId);
  const currentMonthLabel = formatMonthLabel(initial.month);
  // Newly chosen can only be ACTIVE (server rule D2); the current reference stays selectable as it is.
  const employeeOptions = employees.filter((employee) => employee.status === 'ACTIVE' || employee.id === assignment.employeeId);
  const projectOptions = projects.filter((item) => item.status === 'ACTIVE' || item.id === assignment.projectId);

  // The edit button is disabled now: continue in the first form control instead of <body>.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('select')?.focus();
  }, []);

  // Runs after commit, i.e. once the controls are enabled again after a submit.
  useEffect(() => {
    if (focusRequest?.target === 'alert') alertRef.current?.focus();
    else if (focusRequest) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  // A save in flight is not yet confirmed either: leaving would hide its outcome.
  const editState: EditState = submitting ? 'saving' : dirty ? 'dirty' : 'clean';
  useEffect(() => {
    onEditStateChange(editState);
  }, [editState, onEditStateChange]);
  useEffect(() => () => onEditStateChange('clean'), [onEditStateChange]);

  // Reload or closing the tab with unsaved input or a running save asks the browser to confirm.
  useEffect(() => {
    if (editState === 'clean') return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editState]);

  function update(field: CorrectionField, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Prevents a double mutation (UX 5.5 "Submitting").
    if (inFlight.current) return;
    setFormError(null);
    const found = validateCorrection(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFocusRequest({ target: 'invalid' });
      return;
    }
    const changes = correctionChanges(assignment, values);
    if (Object.keys(changes).length === 0) {
      onUnchanged();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const saved = await api.update(assignment.id, changes);
      onSaved(saved);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Correction failed');
      setErrors(serverCorrectionErrors(error));
      setFormError(error);
      setFocusRequest({ target: 'alert' });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const stale = formError instanceof ApiError && (formError.status === 404 || formError.status === 409);

  return (
    <form
      ref={form}
      className="employee-form assignment-correction"
      noValidate
      aria-labelledby={titleId}
      aria-busy={submitting}
      onSubmit={(event) => { void submit(event); }}
    >
      <h3 id={titleId}>Zuordnung von {currentName} korrigieren</h3>
      <p className="assignment-correction__notice">
        Gespeichert: {currentName}, {currentProject?.name ?? 'unbekanntes Projekt'}, {currentMonthLabel}. Die Korrektur
        ändert genau diese Zuordnung; es wird nichts gelöscht. Neu wählbar sind nur aktive Personen und Projekte. Ob die
        Korrektur zulässig ist, prüft der Server beim Speichern.
      </p>
      {dirty && (
        <p className="assignment-correction__unsaved">
          <StatusBadge tone="attention">Ungespeicherte Änderungen</StatusBadge>
        </p>
      )}

      <div className="employee-form__row">
        <SelectField
          id={`${fieldId}-employee`}
          label="Mitarbeiter:in"
          value={values.employeeId}
          error={errors.employeeId}
          disabled={submitting}
          onChange={(value) => update('employeeId', value)}
        >
          {current === undefined && <option value={assignment.employeeId}>Unbekannte Person – aktuell</option>}
          {employeeOptions.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {`${fullName(employee)} (${employee.employeeCode})`}
              {employee.status !== 'ACTIVE' && ' – deaktiviert'}
              {employee.id === assignment.employeeId && ' – aktuell'}
            </option>
          ))}
        </SelectField>
        <SelectField
          id={`${fieldId}-project`}
          label="Projekt"
          value={values.projectId}
          error={errors.projectId}
          disabled={submitting}
          onChange={(value) => update('projectId', value)}
        >
          {currentProject === undefined && <option value={assignment.projectId}>Unbekanntes Projekt – aktuell</option>}
          {projectOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.status !== 'ACTIVE' && ' – inaktiv'}
              {item.id === assignment.projectId && ' – aktuell'}
            </option>
          ))}
        </SelectField>
        <div className="employee-form__field">
          <label htmlFor={`${fieldId}-month`}>Monat</label>
          <p id={`${fieldId}-month-hint`} className="employee-form__hint">Format JJJJ-MM, z. B. 2027-01.</p>
          <input
            id={`${fieldId}-month`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="JJJJ-MM"
            value={values.month}
            disabled={submitting}
            onChange={(event) => update('month', event.target.value)}
            aria-invalid={errors.month ? true : undefined}
            aria-describedby={errors.month ? `${fieldId}-month-hint ${fieldId}-month-error` : `${fieldId}-month-hint`}
          />
          {errors.month && <p id={`${fieldId}-month-error`} className="employee-form__error">{errors.month}</p>}
        </div>
      </div>

      {/* Focus target after a failed save; the inputs stay as entered. */}
      <div ref={alertRef} tabIndex={-1} className="assignments__outcome">
        <ApiErrorAlert error={formError} />
        {stale && (
          <p className="employees-card__hint">
            Der gespeicherte Stand kann sich inzwischen geändert haben. Ihre Eingaben bleiben erhalten; Sie können sie
            anpassen und erneut speichern oder die Korrektur verwerfen und den aktuellen Stand laden.
          </p>
        )}
      </div>
      <div className="employee-form__actions">
        <button type="submit" className="employees-button employees-button--primary" disabled={submitting}>
          {submitting ? 'Wird gespeichert …' : 'Korrektur speichern'}
        </button>
        <button type="button" className="employees-button" disabled={submitting} onClick={onCancel}>
          Abbrechen
        </button>
        {formError && (
          <button type="button" className="employees-button" disabled={submitting} onClick={onDiscardAndReload}>
            Verwerfen und neu laden
          </button>
        )}
      </div>
    </form>
  );
}

type SelectFieldProps = {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
};

function SelectField({ id, label, value, error, disabled, onChange, children }: SelectFieldProps) {
  return (
    <div className="employee-form__field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="assignments__select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {children}
      </select>
      {error && <p id={`${id}-error`} className="employee-form__error">{error}</p>}
    </div>
  );
}
