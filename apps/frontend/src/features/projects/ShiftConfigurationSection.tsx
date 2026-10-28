import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ApiError } from '../../shared/api/api-error';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import type { Clock } from '../../shared/time/clock';
import { isCertainlyPastMonth } from '../../shared/time/company-month';
import { formatMonthLabel, type MonthKey } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import type { EditState } from './edit-state';
import type { Project } from './project-types';
import {
  SHIFT_KINDS,
  type ShiftConfiguration,
  type ShiftConfigurationApi,
  type ShiftKind,
  type ShiftRuleInput,
} from './shift-configuration-api';
import {
  SHIFT_KIND_LABELS,
  endsNextDay,
  initialShiftForm,
  isSameShiftForm,
  toShiftInputs,
  validateShiftForm,
  type ShiftFieldKey,
  type ShiftFormBasis,
  type ShiftFormErrors,
  type ShiftFormValues,
} from './shift-configuration-form';

/** `dirty`: unsaved input; `saving`: a save whose outcome is not yet confirmed. */
export type ShiftEditState = EditState;

type SectionProps = {
  project: Project;
  /** The month selected in the page URL (`requestedMonth`). */
  month: MonthKey;
  api: ShiftConfigurationApi;
  clock: Clock;
  /** Reports the edit state, so leaving the page can be confirmed first. */
  onEditStateChange: (state: ShiftEditState) => void;
};

type Editing = { values: ShiftFormValues; basis: ShiftFormBasis; effectiveFromMonth: MonthKey | null };

/**
 * SP-08b "Schichtzeiten" (ADR-0003): the shift configuration effective for the
 * selected month, which may be inherited from an earlier month. Saving always
 * writes the version of the SELECTED month (full replacement), never the
 * inherited one; afterwards the configuration is read again from the API.
 * Mount with `key={month}`: a new month starts without old state, and answers
 * that arrive for the previous month are discarded.
 */
export function ShiftConfigurationSection({ project, month, api, clock, onEditStateChange }: SectionProps) {
  const titleId = useId();
  const source = useMemo<ReadSource<MonthKey, ShiftConfiguration>>(
    () => ({ kind: 'api', load: (requested, signal) => api.get(project.id, requested, signal) }),
    [api, project.id],
  );
  const { state, retry } = useReadSource(source, month);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusNotice, setFocusNotice] = useState<object | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocusToEdit = useRef(false);
  const monthLabel = formatMonthLabel(month);
  // Read-only only for months past in EVERY time zone (company zone unknown to
  // the client); at a month boundary the server decides in the company zone.
  const readOnlyReason =
    project.status !== 'ACTIVE'
      ? 'Das Projekt ist inaktiv. Schichtzeiten können nur angesehen werden; reaktivieren Sie das Projekt, um sie zu ändern.'
      : isCertainlyPastMonth(month, clock())
        ? `${monthLabel} liegt in der Vergangenheit. Schichtzeiten vergangener Monate können nicht geändert werden.`
        : null;

  useEffect(() => {
    if (focusNotice) noticeRef.current?.focus();
  }, [focusNotice]);

  // After "Abbrechen" the form is gone: continue on the edit button instead of <body>.
  useEffect(() => {
    if (!editing && returnFocusToEdit.current) {
      returnFocusToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  function startEditing(configuration: ShiftConfiguration) {
    setNotice(null);
    setEditing({ ...initialShiftForm(configuration, month), effectiveFromMonth: configuration.effectiveFromMonth });
  }

  function saved() {
    setEditing(null);
    setNotice(`Die Schichtzeiten ab ${monthLabel} wurden gespeichert.`);
    setFocusNotice({});
    // Show what the server stored, not the submitted values.
    retry();
  }

  return (
    <section className="employees-card shift-config" aria-labelledby={titleId}>
      <h2 id={titleId}>Schichtzeiten</h2>
      <p className="employees-card__hint">
        Alle Uhrzeiten sind Ortszeit in der Zeitzone Ihres Unternehmens. Eine Nachtschicht kann am Folgetag enden.
      </p>
      {/* Always mounted, so screen readers announce the confirmation. */}
      <div role="status" aria-live="polite">
        {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
      </div>

      {editing ? (
        <ShiftConfigurationForm
          projectId={project.id}
          month={month}
          monthLabel={monthLabel}
          editing={editing}
          blockedReason={readOnlyReason}
          api={api}
          onSaved={saved}
          onCancel={() => {
            returnFocusToEdit.current = true;
            setEditing(null);
          }}
          onEditStateChange={onEditStateChange}
        />
      ) : state.status === 'loading' ? (
        <LoadingState label="Schichtzeiten werden geladen …" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <ShiftConfigurationView
          configuration={state.data}
          month={month}
          monthLabel={monthLabel}
          readOnlyReason={readOnlyReason}
          editButton={editButton}
          onEdit={() => startEditing(state.data)}
        />
      )}
    </section>
  );
}

type ViewProps = {
  configuration: ShiftConfiguration;
  month: MonthKey;
  monthLabel: string;
  readOnlyReason: string | null;
  editButton: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
};

function ShiftConfigurationView({ configuration, month, monthLabel, readOnlyReason, editButton, onEdit }: ViewProps) {
  const captionId = useId();
  const effective = configuration.effectiveFromMonth;
  const inherited = effective !== null && effective !== month;
  const editLabel =
    effective === null
      ? `Schichtzeiten ab ${monthLabel} festlegen`
      : inherited
        ? `Eigene Schichtzeiten ab ${monthLabel} festlegen`
        : `Schichtzeiten ab ${monthLabel} ändern`;

  return (
    <>
      <dl className="employees-card__facts">
        <div><dt>Gewählter Monat</dt><dd>{monthLabel}</dd></div>
        <div><dt>Wirksame Version</dt><dd>{effective === null ? 'Keine' : `ab ${formatMonthLabel(effective)}`}</dd></div>
        <div>
          <dt>Status</dt>
          <dd>
            {effective === null ? (
              <StatusBadge tone="attention">Nicht konfiguriert</StatusBadge>
            ) : inherited ? (
              <StatusBadge tone="info">Übernommen aus {formatMonthLabel(effective)}</StatusBadge>
            ) : (
              <StatusBadge tone="success">Für {monthLabel} gespeichert</StatusBadge>
            )}
          </dd>
        </div>
      </dl>

      {effective === null ? (
        <EmptyState
          title="Noch keine Schichtzeiten"
          description={`Für ${monthLabel} und die Monate davor sind für dieses Projekt keine Schichtzeiten gespeichert.`}
        />
      ) : (
        <>
          {inherited && (
            <p>
              Für {monthLabel} ist keine eigene Version gespeichert. Es gelten die Schichtzeiten ab {formatMonthLabel(effective)}.
            </p>
          )}
          <div className="employees-table__wrap">
            <table className="employees-table" aria-labelledby={captionId}>
              <caption id={captionId}>Schichtzeiten ab {formatMonthLabel(effective)}</caption>
              <thead>
                <tr>
                  <th scope="col">Schichtart</th>
                  <th scope="col">Beginn</th>
                  <th scope="col">Ende</th>
                </tr>
              </thead>
              <tbody>
                {SHIFT_KINDS.map((kind) => {
                  const rule = configuration.shifts.find((item) => item.shiftKind === kind);
                  return (
                    <tr key={kind}>
                      <th scope="row">{SHIFT_KIND_LABELS[kind]}</th>
                      {rule ? (
                        <>
                          <td data-label="Beginn">{rule.startLocal}</td>
                          <td data-label="Ende">{rule.endLocal}{endsNextDay(rule) && ' (Folgetag)'}</td>
                        </>
                      ) : (
                        <td data-label="Zeiten" colSpan={2}>Nicht konfiguriert</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {readOnlyReason ? (
        <p className="employees-card__hint">{readOnlyReason}</p>
      ) : (
        <button ref={editButton} type="button" className="employees-button" onClick={onEdit}>
          {editLabel}
        </button>
      )}
    </>
  );
}

type FormProps = {
  projectId: string;
  month: MonthKey;
  monthLabel: string;
  editing: Editing;
  /** Set when the project became read-only while editing: input is kept, saving is not offered. */
  blockedReason: string | null;
  api: ShiftConfigurationApi;
  onSaved: () => void;
  onCancel: () => void;
  onEditStateChange: (state: ShiftEditState) => void;
};

const SERVER_FIELD_ERROR = 'Diese Angabe wurde nicht angenommen. Bitte prüfen Sie das Format HH:MM.';

/** Maps safe `errors[]` pointers of the submitted payload back to the form fields. */
function serverFieldErrors(error: Error, sent: readonly ShiftRuleInput[]): ShiftFormErrors {
  const result: ShiftFormErrors = {};
  if (!(error instanceof ApiError)) return result;
  for (const { pointer } of error.fieldErrors) {
    const match = /^#\/shifts\/(\d+)\/(startLocal|endLocal)$/.exec(pointer);
    const kind = match ? sent[Number(match[1])]?.shiftKind : undefined;
    if (match && kind) result[`${kind}.${match[2]}` as ShiftFieldKey] = SERVER_FIELD_ERROR;
    else if (pointer === '#/shifts') result.kinds = 'Bitte prüfen Sie die Auswahl der Schichtarten.';
  }
  return result;
}

function ShiftConfigurationForm({
  projectId, month, monthLabel, editing, blockedReason, api, onSaved, onCancel, onEditStateChange,
}: FormProps) {
  const [values, setValues] = useState<ShiftFormValues>(editing.values);
  const [errors, setErrors] = useState<ShiftFormErrors>({});
  const [formError, setFormError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // A new object per request, so the same target can be focused again.
  const [focusRequest, setFocusRequest] = useState<{ target: 'invalid' | 'alert' } | null>(null);
  const titleId = useId();
  const kindsErrorId = useId();
  const dirty = !isSameShiftForm(values, editing.values);
  const inherited = editing.effectiveFromMonth !== null ? formatMonthLabel(editing.effectiveFromMonth) : null;

  // The edit button unmounts: continue in the first form control instead of <body>.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  // Runs after commit, i.e. once the controls are enabled again after a submit.
  useEffect(() => {
    if (focusRequest?.target === 'alert') alertRef.current?.focus();
    else if (focusRequest) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  // A save in flight is not yet confirmed either: leaving would hide its outcome.
  const editState: ShiftEditState = submitting ? 'saving' : dirty ? 'dirty' : 'clean';
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

  function update(kind: ShiftKind, change: Partial<ShiftFormValues[ShiftKind]>) {
    setValues((current) => ({ ...current, [kind]: { ...current[kind], ...change } }));
    setErrors((current) => {
      const next = { ...current };
      delete next.kinds;
      if ('startLocal' in change) delete next[`${kind}.startLocal`];
      if ('endLocal' in change || 'startLocal' in change) delete next[`${kind}.endLocal`];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Prevents a double mutation (UX 5.5 "Submitting").
    if (inFlight.current || blockedReason) return;
    setFormError(null);
    const found = validateShiftForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFocusRequest({ target: 'invalid' });
      return;
    }
    const shifts = toShiftInputs(values);
    inFlight.current = true;
    setSubmitting(true);
    try {
      // Always the SELECTED month: an inherited version is never overwritten.
      await api.replace(projectId, month, shifts);
      onSaved();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Save failed');
      setErrors(serverFieldErrors(error, shifts));
      setFormError(error);
      setFocusRequest({ target: 'alert' });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const basisText =
    editing.basis === 'suggestion'
      ? 'Vorschlagswerte (Tagschicht 06:00–18:00, Nachtschicht 18:00–06:00) sind vorbelegt und noch nicht gespeichert. Gespeichert wird erst mit „Schichtzeiten speichern“.'
      : editing.basis === 'inherited'
        ? `Vorbelegt sind die Schichtzeiten ab ${inherited}. Beim Speichern entsteht eine eigene Version ab ${monthLabel}, auch wenn Sie die Uhrzeiten nicht ändern. Die Version ab ${inherited} bleibt unverändert.`
        : `Sie ändern die gespeicherte Version ab ${monthLabel}. Frühere Monate bleiben unverändert.`;

  return (
    <form
      ref={form}
      className="employee-form shift-config__form"
      noValidate
      aria-labelledby={titleId}
      aria-busy={submitting}
      onSubmit={(event) => { void submit(event); }}
    >
      <h3 id={titleId}>Schichtzeiten ab {monthLabel} bearbeiten</h3>
      <p className={`shift-config__notice${editing.basis === 'suggestion' ? ' shift-config__notice--suggestion' : ''}`}>
        {editing.basis === 'suggestion' && <strong>Vorschlag, nicht gespeichert: </strong>}
        {basisText}
      </p>
      {dirty && (
        <p className="shift-config__unsaved">
          <StatusBadge tone="attention">Ungespeicherte Änderungen</StatusBadge>
        </p>
      )}

      {SHIFT_KINDS.map((kind) => (
        <ShiftKindFields
          key={kind}
          kind={kind}
          row={values[kind]}
          errors={errors}
          kindsErrorId={errors.kinds ? kindsErrorId : undefined}
          disabled={submitting}
          onChange={(change) => update(kind, change)}
        />
      ))}
      {errors.kinds && <p id={kindsErrorId} className="employee-form__error">{errors.kinds}</p>}

      <p className="employee-form__hint">
        Gespeichert wird immer die vollständige Auswahl. Eine nicht ausgewählte Schichtart gilt ab {monthLabel} als
        nicht konfiguriert; mindestens eine Schichtart ist erforderlich.
      </p>
      <p className="employee-form__hint">
        Ändern mehrere Personen die Schichtzeiten gleichzeitig, gilt die zuletzt gespeicherte Fassung. Gleichzeitige
        Änderungen werden nicht erkannt; prüfen Sie die Anzeige nach dem Speichern.
      </p>
      {blockedReason && <p className="employees-card__hint">{blockedReason}</p>}

      {/* Focus target after a failed save; the inputs stay as entered. */}
      <div ref={alertRef} tabIndex={-1} className="assignments__outcome">
        <ApiErrorAlert error={formError} />
      </div>
      <div className="employee-form__actions">
        <button
          type="submit"
          className="employees-button employees-button--primary"
          disabled={submitting || blockedReason !== null}
        >
          {submitting ? 'Wird gespeichert …' : 'Schichtzeiten speichern'}
        </button>
        <button type="button" className="employees-button" disabled={submitting} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

type KindFieldsProps = {
  kind: ShiftKind;
  row: ShiftFormValues[ShiftKind];
  errors: ShiftFormErrors;
  kindsErrorId: string | undefined;
  disabled: boolean;
  onChange: (change: Partial<ShiftFormValues[ShiftKind]>) => void;
};

function ShiftKindFields({ kind, row, errors, kindsErrorId, disabled, onChange }: KindFieldsProps) {
  const label = SHIFT_KIND_LABELS[kind];
  const toggleId = useId();
  return (
    <fieldset className="shift-config__kind" disabled={disabled}>
      <legend>{label}</legend>
      <div className="shift-config__toggle">
        <input
          id={toggleId}
          type="checkbox"
          checked={row.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
          aria-invalid={kindsErrorId ? true : undefined}
          aria-describedby={kindsErrorId}
        />
        <label htmlFor={toggleId}>{label} verwenden</label>
      </div>
      {row.enabled && (
        <div className="employee-form__row">
          <TimeField
            label={`Beginn ${label}`}
            hint="Format HH:MM, 24 Stunden."
            value={row.startLocal}
            error={errors[`${kind}.startLocal`]}
            onChange={(startLocal) => onChange({ startLocal })}
          />
          <TimeField
            label={`Ende ${label}`}
            hint={
              kind === 'DAY'
                ? 'Am selben Tag, nach dem Beginn.'
                : 'Liegt das Ende vor dem Beginn, endet die Schicht am Folgetag.'
            }
            value={row.endLocal}
            error={errors[`${kind}.endLocal`]}
            onChange={(endLocal) => onChange({ endLocal })}
          />
        </div>
      )}
    </fieldset>
  );
}

type TimeFieldProps = {
  label: string;
  hint: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
};

function TimeField({ label, hint, value, error, onChange }: TimeFieldProps) {
  const id = useId();
  return (
    <div className="employee-form__field">
      <label htmlFor={id}>{label}</label>
      <p id={`${id}-hint`} className="employee-form__hint">{hint}</p>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="HH:MM"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
      />
      {error && <p id={`${id}-error`} className="employee-form__error">{error}</p>}
    </div>
  );
}
