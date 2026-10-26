import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../shared/api/api-error';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { validateProjectName } from './project-types';

type ProjectNameFormProps = {
  initialName: string;
  submitLabel: string;
  pendingLabel: string;
  /** Resolves when done; rejects with the API error, which is shown here. */
  onSubmit: (name: string) => Promise<void>;
  /** Secondary action (link or button) rendered next to submit. */
  cancel: ReactNode;
};

/** Field-level text for server errors that belong to the name field. */
function nameErrorFrom(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'PROJECT_NAME_ALREADY_EXISTS') {
    return 'Dieser Projektname wird in Ihrem Unternehmen bereits verwendet.';
  }
  const field = error.fieldErrors.find((item) => item.pointer === '#/name');
  if (!field) return null;
  return field.code === 'TOO_LONG'
    ? 'Der Projektname darf höchstens 100 Zeichen lang sein.'
    : 'Bitte geben Sie einen Projektnamen mit 2 bis 100 Zeichen ein.';
}

/** Create/rename form for the only editable project master-data field (API v1). */
export function ProjectNameForm({ initialName, submitLabel, pendingLabel, onSubmit, cancel }: ProjectNameFormProps) {
  const [name, setName] = useState(initialName);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // A new object per request, so the field can be focused again.
  const [focusRequest, setFocusRequest] = useState<object | null>(null);
  const id = useId();

  // Runs after commit, i.e. once the input is enabled again after a submit.
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(null);
    const clientError = validateProjectName(name);
    if (clientError) {
      setFieldError(clientError);
      setFocusRequest({});
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await onSubmit(name.trim());
    } catch (cause) {
      const message = nameErrorFrom(cause);
      if (message) {
        setFieldError(message);
        setFocusRequest({});
      } else {
        setFormError(cause instanceof Error ? cause : new Error('Save failed'));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className="employee-form" noValidate aria-busy={submitting} onSubmit={(event) => { void submit(event); }}>
      <div className="employee-form__field">
        <label htmlFor={id}>Projektname</label>
        <p id={`${id}-hint`} className="employee-form__hint">2 bis 100 Zeichen; in Ihrem Unternehmen eindeutig.</p>
        <input
          ref={input}
          id={id}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setFieldError(null);
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-hint ${id}-error` : `${id}-hint`}
          disabled={submitting}
        />
        {fieldError && <p id={`${id}-error`} className="employee-form__error">{fieldError}</p>}
      </div>
      <ApiErrorAlert error={formError} />
      <div className="employee-form__actions">
        <button type="submit" className="employees-button employees-button--primary" disabled={submitting}>
          {submitting ? pendingLabel : submitLabel}
        </button>
        {cancel}
      </div>
    </form>
  );
}
