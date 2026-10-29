import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { ApiError } from '../../shared/api/api-error';
import {
  FIELD_ORDER,
  validateEmployeeForm,
  type EmployeeFormValues,
  type FieldErrors,
  type FieldName,
  type FormMode,
} from './employee-form';
import { SHIFT_ELIGIBILITY_LABELS, type ShiftEligibility } from './employee-types';

export type SubmitOutcome = { fieldErrors?: FieldErrors; error?: Error } | void;

type EmployeeFormProps = {
  mode: FormMode;
  initialValues: EmployeeFormValues;
  submitLabel: string;
  pendingLabel: string;
  /** Resolves with field errors or a general error; navigation/updates are the caller's job. */
  onSubmit: (values: EmployeeFormValues) => Promise<SubmitOutcome>;
  /** Secondary action (link or button) rendered next to submit. */
  cancel: ReactNode;
  onReviewFutureAssignments?: () => void;
};

const ELIGIBILITIES: readonly ShiftEligibility[] = ['DAY', 'NIGHT', 'BOTH'];

/** Shared create/edit form. Labels, hints and errors are programmatically linked. */
export function EmployeeForm({ mode, initialValues, submitLabel, pendingLabel, onSubmit, cancel, onReviewFutureAssignments }: EmployeeFormProps) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A new object per request, so the same field can be focused again.
  const [focusRequest, setFocusRequest] = useState<{ field: FieldName } | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const prefix = useId();
  const id = (field: FieldName, suffix = '') => `${prefix}-${field}${suffix}`;
  const employmentConflict = formError instanceof ApiError && formError.status === 409
    && formError.code === 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS';
  const summary = employmentConflict ? formError.employmentPeriodConflict : undefined;

  // Runs after commit, i.e. once inputs are enabled again after a submit.
  useEffect(() => {
    if (focusRequest) {
      formRef.current?.querySelector<HTMLElement>(`[data-field="${focusRequest.field}"]`)?.focus();
    }
  }, [focusRequest]);

  function update(field: FieldName, value: string) {
    if (employmentConflict) setFormError(null);
    setValues((current) => ({ ...current, [field]: value }));
    // Editing a field clears its message; the next submit re-validates everything.
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function focusFirstError(fieldErrors: FieldErrors) {
    const first = FIELD_ORDER.find((field) => fieldErrors[field]);
    if (first) setFocusRequest({ field: first });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const clientErrors = validateEmployeeForm(values, mode);
    setFormError(null);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      focusFirstError(clientErrors);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    let outcome: SubmitOutcome;
    try {
      outcome = await onSubmit(values);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
    if (outcome?.fieldErrors) {
      setErrors(outcome.fieldErrors);
      focusFirstError(outcome.fieldErrors);
    }
    if (outcome?.error) setFormError(outcome.error);
  }

  function describedBy(field: FieldName, hint: boolean): string | undefined {
    const ids = [hint ? id(field, '-hint') : null, errors[field] ? id(field, '-error') : null].filter(Boolean);
    return ids.length > 0 ? ids.join(' ') : undefined;
  }

  function textField(field: FieldName, label: string, options: { type?: string; hint?: string; autoComplete?: string } = {}) {
    return (
      <div className="employee-form__field">
        <label htmlFor={id(field)}>{label}</label>
        {options.hint && <p id={id(field, '-hint')} className="employee-form__hint">{options.hint}</p>}
        <input
          id={id(field)}
          data-field={field}
          type={options.type ?? 'text'}
          autoComplete={options.autoComplete ?? 'off'}
          value={values[field]}
          onChange={(event) => update(field, event.target.value)}
          aria-invalid={errors[field] ? true : undefined}
          aria-describedby={describedBy(field, Boolean(options.hint))}
          disabled={submitting}
        />
        {errors[field] && <p id={id(field, '-error')} className="employee-form__error">{errors[field]}</p>}
      </div>
    );
  }

  return (
    <form ref={formRef} className="employee-form" noValidate aria-busy={submitting} onSubmit={(event) => { void submit(event); }}>
      <p className="employee-form__required-note">Alle Felder ohne „optional“ sind Pflichtfelder.</p>
      {textField('employeeCode', 'Mitarbeiter-ID', {
        hint: 'Eindeutig in Ihrem Unternehmen; bis 30 Zeichen: Buchstaben, Ziffern sowie . _ -',
      })}
      <div className="employee-form__row">
        {textField('firstName', 'Vorname', { autoComplete: 'off' })}
        {textField('lastName', 'Nachname', { autoComplete: 'off' })}
      </div>
      {mode === 'create' &&
        textField('email', 'E-Mail-Adresse', {
          type: 'email',
          hint: 'Persönliche Anmelde-E-Mail. Dorthin wird der Einladungslink zur Kontoaktivierung gesendet. Sie kann später hier nicht geändert werden.',
        })}
      <div className="employee-form__row">
        {textField('employmentStart', 'Beschäftigungsbeginn (optional)', { type: 'date' })}
        {mode === 'edit' && textField('employmentEnd', 'Beschäftigungsende (optional)', { type: 'date' })}
      </div>
      <fieldset
        className="employee-form__choices"
        aria-describedby={errors.shiftEligibility ? id('shiftEligibility', '-error') : undefined}
      >
        <legend>Schicht-Eignung</legend>
        {ELIGIBILITIES.map((value, index) => (
          <label key={value}>
            <input
              type="radio"
              name={id('shiftEligibility')}
              value={value}
              data-field={index === 0 ? 'shiftEligibility' : undefined}
              checked={values.shiftEligibility === value}
              onChange={() => update('shiftEligibility', value)}
              aria-invalid={errors.shiftEligibility ? true : undefined}
              disabled={submitting}
            />
            {SHIFT_ELIGIBILITY_LABELS[value]}
          </label>
        ))}
        {errors.shiftEligibility && (
          <p id={id('shiftEligibility', '-error')} className="employee-form__error">{errors.shiftEligibility}</p>
        )}
      </fieldset>
      <ApiErrorAlert error={formError} />
      {employmentConflict && onReviewFutureAssignments && (
        <div>
          {summary && (
            <>
              <p>{summary.conflictingAssignments.length} von {summary.conflictCount} betroffenen Projektzuordnungen (Hinweis):</p>
              <ul aria-label="Betroffene Zuordnungsmonate">
                {summary.conflictingAssignments.map((assignment) => <li key={assignment.assignmentId}>{assignment.monthStart}</li>)}
              </ul>
            </>
          )}
          <button type="button" className="employees-button" onClick={onReviewFutureAssignments}>
            Zukünftige Projektzuordnungen prüfen
          </button>
        </div>
      )}
      <div className="employee-form__actions">
        <button type="submit" className="employees-button employees-button--primary" disabled={submitting}>
          {submitting ? pendingLabel : submitLabel}
        </button>
        {cancel}
      </div>
    </form>
  );
}
