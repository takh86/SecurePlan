import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ApiError } from '../../shared/api/api-error';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import type { Clock } from '../../shared/time/clock';
import { formatMonthLabel, type MonthKey } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import type { EditState } from './edit-state';
import {
  hasNoCalendarVersions,
  ISO_WEEKDAYS,
  type CalendarRead,
  type CalendarWriteResult,
  type IsoWeekday,
  type OperatingCalendarApi,
} from './operating-calendar-api';
import {
  WEEKDAY_LABELS,
  applicabilityText,
  calendarEditOptions,
  calendarErrorText,
  calendarNeedsReload,
  calendarWriteTerminal,
  sameWeekdays,
  sortWeekdays,
  storedWeekdays,
  weekdayChange,
  weekdayList,
  type CalendarEditMode,
  type CalendarEditOptions,
} from './operating-calendar-form';
import type { Project } from './project-types';

type SectionProps = {
  project: Project;
  /** The month selected in the page URL. */
  month: MonthKey;
  api: OperatingCalendarApi;
  clock: Clock;
  /** Reports the edit state, so leaving the page can be confirmed first. */
  onEditStateChange: (state: EditState) => void;
};

type Editing = { mode: CalendarEditMode; basis: CalendarRead };

/**
 * F-A1-2 "Betriebstage": the project's operating weekdays in force for the
 * selected month (A1 month-effective calendar, #92). Shows exactly what the
 * server stored, including MISSING; there is no default set. A write replaces
 * the complete set of the SELECTED month with the reviewed read as its
 * precondition; the server's answer is shown afterwards. Mount with
 * `key={month}`: a new month starts without old state.
 */
export function OperatingCalendarSection({ project, month, api, clock, onEditStateChange }: SectionProps) {
  const titleId = useId();
  const source = useMemo<ReadSource<MonthKey, CalendarRead>>(
    () => ({ kind: 'api', load: (requested, signal) => api.get(project.id, requested, signal) }),
    [api, project.id],
  );
  const { state, retry } = useReadSource(source, month);
  // The latest server state seen by a write or an explicit reload in the form.
  const [latest, setLatest] = useState<CalendarRead | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusNotice, setFocusNotice] = useState<object | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocusToEdit = useRef(false);
  const monthLabel = formatMonthLabel(month);
  const read = latest ?? (state.status === 'ready' ? state.data : null);

  useEffect(() => {
    if (focusNotice) noticeRef.current?.focus();
  }, [focusNotice]);

  useEffect(() => {
    if (!editing && returnFocusToEdit.current) {
      returnFocusToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  function finished(message: string, result: CalendarRead | null) {
    if (result) setLatest(result);
    setEditing(null);
    setNotice(message);
    setFocusNotice({});
  }

  function saved(result: CalendarWriteResult, mode: CalendarEditMode) {
    const version = result.exactVersion?.version;
    finished(
      result.outcome === 'NO_OP'
        ? `Die Betriebstage ab ${monthLabel} waren bereits so gespeichert. Es wurde nichts geändert.`
        : mode === 'bootstrap'
          ? `Die einmalige Ersteinrichtung ab ${monthLabel} wurde gespeichert (Version ${version}).`
          : `Die Betriebstage ab ${monthLabel} wurden gespeichert (Version ${version}).`,
      result,
    );
  }

  return (
    <section className="employees-card operating-calendar" aria-labelledby={titleId}>
      <h2 id={titleId}>Betriebstage</h2>
      <p className="employees-card__hint">
        Betriebstage sind die Wochentage, an denen das Projekt in Betrieb ist. Maßgeblich ist der Tag, an dem ein Dienst
        beginnt, bei Nachtdiensten also der Starttag. Eine Fassung gilt ab ihrem Monat, bis eine spätere Fassung gespeichert
        wird.
      </p>
      {/* Always mounted, so screen readers announce the confirmation. */}
      <div role="status" aria-live="polite">
        {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
      </div>

      {editing ? (
        <OperatingCalendarForm
          project={project}
          editing={editing}
          api={api}
          clock={clock}
          onSaved={saved}
          onUnchanged={() => finished('Es gab keine Änderungen zu speichern.', null)}
          onRead={setLatest}
          onCancel={() => {
            returnFocusToEdit.current = true;
            setEditing(null);
          }}
          onEditStateChange={onEditStateChange}
        />
      ) : read ? (
        <OperatingCalendarView
          read={read}
          options={calendarEditOptions(read, project.status, clock())}
          editButton={editButton}
          onEdit={(mode) => {
            setNotice(null);
            setEditing({ mode, basis: read });
          }}
        />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <LoadingState label="Betriebstage werden geladen …" />
      )}
    </section>
  );
}

type ViewProps = {
  read: CalendarRead;
  options: CalendarEditOptions;
  editButton: RefObject<HTMLButtonElement | null>;
  onEdit: (mode: CalendarEditMode) => void;
};

function OperatingCalendarView({ read, options, editButton, onEdit }: ViewProps) {
  const monthLabel = formatMonthLabel(read.month);
  const effective = read.effective;
  const inherited = effective !== null && read.exactVersion === null;
  const next = read.nextEffectiveFromMonth;
  const { mode } = options;
  const editLabel =
    mode === 'bootstrap'
      ? `Einmalige Ersteinrichtung ab ${monthLabel} …`
      : effective === null
        ? `Betriebstage ab ${monthLabel} festlegen`
        : inherited
          ? `Eigene Betriebstage ab ${monthLabel} festlegen`
          : `Betriebstage ab ${monthLabel} ändern`;

  return (
    <>
      <dl className="employees-card__facts">
        <div>
          <dt>Stand für {monthLabel}</dt>
          <dd>
            {effective === null ? (
              <StatusBadge tone="attention">Nicht festgelegt</StatusBadge>
            ) : inherited ? (
              <StatusBadge tone="info">Übernommen aus {formatMonthLabel(effective.effectiveFromMonth)}</StatusBadge>
            ) : (
              <StatusBadge tone="success">Für {monthLabel} gespeichert</StatusBadge>
            )}
          </dd>
        </div>
        <div>
          <dt>Wirksame Fassung</dt>
          <dd>{effective === null ? 'Keine' : `ab ${formatMonthLabel(effective.effectiveFromMonth)} · Version ${effective.version}`}</dd>
        </div>
        <div>
          <dt>Nächste gespeicherte Fassung</dt>
          <dd>{next === null ? 'Keine' : `ab ${formatMonthLabel(next)}`}</dd>
        </div>
      </dl>

      {effective === null ? (
        <EmptyState
          title="Keine Betriebstage festgelegt"
          description={`Für ${monthLabel} sind für dieses Projekt keine Betriebstage festgelegt. Ohne Betriebstage können in diesem Monat keine Dienste angelegt und kein Monatsplan veröffentlicht werden. Es gibt keine Voreinstellung.${
            next === null ? '' : ` Ab ${formatMonthLabel(next)} sind Betriebstage gespeichert.`
          }`}
        />
      ) : (
        <>
          {inherited && (
            <p>
              Für {monthLabel} ist keine eigene Fassung gespeichert. Es gelten die Betriebstage ab{' '}
              {formatMonthLabel(effective.effectiveFromMonth)}.
            </p>
          )}
          <WeekdayOverview days={effective.operatingWeekdays} label={`Betriebstage ab ${formatMonthLabel(effective.effectiveFromMonth)}`} />
        </>
      )}

      {options.reason !== null ? (
        <p className="employees-card__hint">{options.reason}</p>
      ) : (
        <>
          {mode === 'bootstrap' && (
            <p className="employees-card__hint">
              Für dieses Projekt sind noch keine Betriebstage gespeichert. Für einen vergangenen Monat ist nur die einmalige
              Ersteinrichtung möglich.
            </p>
          )}
          <button ref={editButton} type="button" className="employees-button" onClick={() => { if (mode) onEdit(mode); }}>
            {editLabel}
          </button>
        </>
      )}
    </>
  );
}

/** Seven fixed entries, Monday first; state as text, never by colour alone. */
function WeekdayOverview({ days, label }: { days: readonly IsoWeekday[]; label: string }) {
  const open = new Set(days);
  return (
    <ul className="operating-calendar__week" aria-label={label}>
      {ISO_WEEKDAYS.map((day) => {
        const isOpen = open.has(day);
        return (
          <li key={day} className={`operating-calendar__day operating-calendar__day--${isOpen ? 'open' : 'closed'}`}>
            <span className="operating-calendar__short" aria-hidden="true">{WEEKDAY_LABELS[day].short}</span>
            <span className="operating-calendar__sr-only">{WEEKDAY_LABELS[day].long}: </span>
            <span>{isOpen ? 'in Betrieb' : 'geschlossen'}</span>
          </li>
        );
      })}
    </ul>
  );
}

type FormProps = {
  project: Project;
  editing: Editing;
  api: OperatingCalendarApi;
  clock: Clock;
  onSaved: (result: CalendarWriteResult, mode: CalendarEditMode) => void;
  onUnchanged: () => void;
  /** A fresh read loaded inside the form; the view shows it after leaving the form. */
  onRead: (read: CalendarRead) => void;
  onCancel: () => void;
  onEditStateChange: (state: EditState) => void;
};

type FieldErrors = { weekdays?: string; confirm?: string };

function OperatingCalendarForm({
  project, editing, api, clock, onSaved, onUnchanged, onRead, onCancel, onEditStateChange,
}: FormProps) {
  const { mode } = editing;
  const [basis, setBasis] = useState<CalendarRead>(editing.basis);
  // No default: the selection starts with exactly the stored set in force (empty when MISSING).
  const [initial, setInitial] = useState<IsoWeekday[]>(() => storedWeekdays(editing.basis));
  const [selection, setSelection] = useState<ReadonlySet<IsoWeekday>>(() => new Set(storedWeekdays(editing.basis)));
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<Error | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<Error | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const reloadNoticeRef = useRef<HTMLParagraphElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: 'invalid' | 'alert' | 'reloaded' } | null>(null);
  const titleId = useId();
  const introId = useId();
  const hintId = useId();
  const weekdaysErrorId = useId();
  const confirmErrorId = useId();
  const monthLabel = formatMonthLabel(basis.month);
  const effective = basis.effective;
  const dirty = !sameWeekdays(selection, initial) || confirmed;

  const options = calendarEditOptions(basis, project.status, clock());
  // A fresh read (or the passing time) can withdraw the opened write, e.g. the bootstrap once any version exists.
  const modeBlocked = options.mode === mode
    ? null
    : (options.reason ?? `${monthLabel} kann hier nicht mehr so geändert werden. Brechen Sie ab und laden Sie die Ansicht neu.`);
  const blockedReason = terminal
    ? 'Speichern ist hier nicht mehr möglich. Brechen Sie ab und laden Sie die Ansicht neu.'
    : needsReload
      ? 'Laden Sie zuerst den aktuellen Stand, bevor Sie erneut speichern.'
      : modeBlocked;

  // The edit button unmounts: continue on the form heading, so the explanation is read first.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    if (focusRequest?.target === 'alert') alertRef.current?.focus();
    else if (focusRequest?.target === 'reloaded') reloadNoticeRef.current?.focus();
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

  function toggle(day: IsoWeekday, checked: boolean) {
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(day);
      else next.delete(day);
      return next;
    });
    setErrors((current) => ({ ...current, weekdays: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Prevents a double mutation; a blocked form never sends.
    if (inFlight.current || blockedReason) return;
    setFormError(null);
    setReloadNotice(null);
    const found: FieldErrors = {};
    if (selection.size === 0) {
      found.weekdays = 'Bitte wählen Sie mindestens einen Betriebstag aus. Ein Projekt ohne Betriebstage ist nicht vorgesehen; setzen Sie es bei Bedarf auf inaktiv.';
    }
    if (mode === 'bootstrap' && !confirmed) found.confirm = 'Bitte bestätigen Sie die einmalige Ersteinrichtung ausdrücklich.';
    setErrors(found);
    if (found.weekdays || found.confirm) {
      setFocusRequest({ target: 'invalid' });
      return;
    }
    // The exact stored set again: nothing to write (no request).
    if (mode === 'normal' && basis.exactVersion !== null && sameWeekdays(selection, storedWeekdays(basis))) {
      onUnchanged();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const result = await api.replace(project.id, {
        basis,
        operatingWeekdays: sortWeekdays(selection),
        bootstrap: mode === 'bootstrap',
      });
      onSaved(result, mode);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Save failed');
      setFormError(error);
      if (calendarNeedsReload(error)) setNeedsReload(true);
      if (calendarWriteTerminal(error)) setTerminal(true);
      if (error instanceof ApiError && error.fieldErrors.some((field) => field.pointer.startsWith('#/operatingWeekdays'))) {
        setErrors({ weekdays: 'Diese Auswahl wurde nicht angenommen. Bitte prüfen Sie die Betriebstage.' });
      }
      setFocusRequest({ target: 'alert' });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  /** Explicit re-read after a stale or unknown outcome: new preconditions, the selection is kept. */
  async function reload() {
    if (reloading || inFlight.current) return;
    setReloading(true);
    setReloadError(null);
    try {
      const fresh = await api.get(project.id, basis.month);
      setBasis(fresh);
      setInitial(storedWeekdays(fresh));
      // A new basis needs a new, explicit confirmation.
      setConfirmed(false);
      setNeedsReload(false);
      setFormError(null);
      onRead(fresh);
      setReloadNotice(
        `Aktueller Stand geladen: ${
          fresh.effective
            ? `Ab ${formatMonthLabel(fresh.effective.effectiveFromMonth)} gelten ${weekdayList(fresh.effective.operatingWeekdays)} (Version ${fresh.effective.version}).`
            : `Für ${monthLabel} sind keine Betriebstage festgelegt.`
        } Ihre Auswahl ist unverändert. Prüfen Sie sie und speichern Sie bei Bedarf erneut.`,
      );
      setFocusRequest({ target: 'reloaded' });
    } catch (cause) {
      setReloadError(cause instanceof Error ? cause : new Error('Load failed'));
      setFocusRequest({ target: 'alert' });
    } finally {
      setReloading(false);
    }
  }

  const change = weekdayChange(basis, selection);
  const firstVersion = mode === 'normal' && hasNoCalendarVersions(basis);

  return (
    <form
      ref={form}
      className="employee-form operating-calendar__form"
      noValidate
      aria-labelledby={titleId}
      aria-describedby={introId}
      aria-busy={submitting}
      onSubmit={(event) => { void submit(event); }}
    >
      <h3 id={titleId} ref={heading} tabIndex={-1}>
        {mode === 'bootstrap'
          ? `Einmalige Ersteinrichtung ab ${monthLabel}`
          : `Betriebstage ab ${monthLabel} ${basis.exactVersion ? 'ändern' : 'festlegen'}`}
      </h3>

      <div id={introId} className={`operating-calendar__notice${mode === 'bootstrap' || firstVersion ? ' operating-calendar__notice--warning' : ''}`}>
        {mode === 'bootstrap' ? (
          <>
            <p><strong>Einmalige Ersteinrichtung – bitte sorgfältig prüfen.</strong></p>
            <ul>
              <li>
                Für dieses Projekt sind noch keine Betriebstage gespeichert. Die Ersteinrichtung legt sie rückwirkend ab{' '}
                {monthLabel} fest; sie gelten für alle folgenden Monate, bis eine spätere Fassung gespeichert wird.
              </li>
              <li>
                Sie ist nur einmal möglich und nur ab dem Monat des frühesten gespeicherten Dienstes dieses Projekts; gibt es
                keine gespeicherten Dienste, ab dem aktuellen Monat Ihres Unternehmens. Den Monat prüft der Server.
              </li>
              <li>
                Alle gespeicherten Dienste ab {monthLabel} müssen an einem ausgewählten Wochentag beginnen, auch Dienste ohne
                Besetzung und Dienste veröffentlichter Pläne. Dienste werden dabei nicht geändert oder gelöscht.
              </li>
              <li>
                Die Auswahl ist Ihre ausdrückliche Festlegung, kein Nachweis früherer Betriebszeiten. Für vergangene Monate
                kann sie danach nicht mehr geändert werden.
              </li>
            </ul>
          </>
        ) : (
          <>
            {firstVersion && (
              <p>
                <strong>Erste Fassung für dieses Projekt.</strong> Gibt es bereits gespeicherte Dienste vor {monthLabel},
                richten Sie zuerst über „Vorheriger Monat“ im Monat des frühesten Dienstes die einmalige Ersteinrichtung
                ein. Nach diesem Speichern ist die Ersteinrichtung nicht mehr möglich; Monate vor {monthLabel} bleiben dann
                ohne Betriebstage.
              </p>
            )}
            <p>
              {effective === null
                ? 'Es gibt keine Voreinstellung. Wählen Sie jeden Wochentag, an dem das Projekt in Betrieb ist, ausdrücklich aus.'
                : basis.exactVersion === null
                  ? `Vorausgewählt sind die gespeicherten Betriebstage ab ${formatMonthLabel(effective.effectiveFromMonth)} (Version ${effective.version}). Beim Speichern entsteht eine eigene Fassung ab ${monthLabel}, auch wenn Sie die Auswahl nicht ändern. Die Fassung ab ${formatMonthLabel(effective.effectiveFromMonth)} bleibt unverändert.`
                  : `Sie ändern die gespeicherte Fassung ab ${monthLabel} (Version ${effective.version}). Frühere Monate bleiben unverändert.`}
            </p>
          </>
        )}
      </div>

      <p>
        <span className="operating-calendar__label">Derzeit gespeichert: </span>
        {effective === null
          ? `keine Betriebstage für ${monthLabel}`
          : `${weekdayList(effective.operatingWeekdays)} (ab ${formatMonthLabel(effective.effectiveFromMonth)}, Version ${effective.version})`}
      </p>
      {dirty && (
        <p className="shift-config__unsaved">
          <StatusBadge tone="attention">Ungespeicherte Änderungen</StatusBadge>
        </p>
      )}

      <fieldset className="operating-calendar__days" disabled={submitting}>
        <legend>Betriebstage ab {monthLabel}</legend>
        <p id={hintId} className="employee-form__hint">
          Wählen Sie jeden Wochentag aus, an dem das Projekt in Betrieb ist (Montag bis Sonntag).
        </p>
        <div className="operating-calendar__choices">
          {ISO_WEEKDAYS.map((day) => (
            <label key={day} className="operating-calendar__choice">
              <input
                type="checkbox"
                checked={selection.has(day)}
                onChange={(event) => toggle(day, event.target.checked)}
                aria-invalid={errors.weekdays ? true : undefined}
                aria-describedby={errors.weekdays ? `${hintId} ${weekdaysErrorId}` : hintId}
              />
              <span aria-hidden="true">{WEEKDAY_LABELS[day].short}</span>
              <span className="operating-calendar__sr-only">{WEEKDAY_LABELS[day].long}</span>
            </label>
          ))}
        </div>
        {errors.weekdays && <p id={weekdaysErrorId} className="employee-form__error">{errors.weekdays}</p>}
      </fieldset>

      {mode === 'normal' && change === null && (
        <p className="employee-form__hint">
          Für diesen Zeitraum sind bisher keine Betriebstage festgelegt. Beginnt im Geltungszeitraum bereits ein gespeicherter
          Dienst an einem nicht ausgewählten Wochentag, wird die Auswahl abgelehnt.
        </p>
      )}
      {change && change.closed.length > 0 && (
        <p className="operating-calendar__closing">
          <strong>Neu geschlossen: </strong>
          {weekdayList(change.closed)}. Beginnt im Geltungszeitraum bereits ein gespeicherter Dienst an einem dieser
          Wochentage (auch ohne Besetzung oder in einem veröffentlichten Plan), wird die Änderung abgelehnt. Dienste werden nie
          automatisch geändert oder gelöscht.
        </p>
      )}
      {change && change.opened.length > 0 && (
        <p>
          <strong>Neu in Betrieb: </strong>
          {weekdayList(change.opened)}.
        </p>
      )}
      <p className="employee-form__hint">{applicabilityText(basis)}</p>
      <p className="employee-form__hint">
        Ändert jemand anderes die Betriebstage dieses Projekts, bevor Sie speichern, wird Ihre Änderung nicht übernommen. Sie
        können dann den aktuellen Stand laden und neu prüfen.
      </p>

      {mode === 'bootstrap' && (
        <div className="employee-form__field">
          <label className="operating-calendar__confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={submitting}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                setErrors((current) => ({ ...current, confirm: undefined }));
              }}
              aria-invalid={errors.confirm ? true : undefined}
              aria-describedby={errors.confirm ? confirmErrorId : undefined}
            />
            <span>
              Ich habe die Auswahl geprüft. Diese Betriebstage sollen einmalig ab {monthLabel} für alle gespeicherten Dienste
              dieses Projekts gelten.
            </span>
          </label>
          {errors.confirm && <p id={confirmErrorId} className="employee-form__error">{errors.confirm}</p>}
        </div>
      )}

      {blockedReason && <p className="employees-card__hint">{blockedReason}</p>}

      {/* Focus target after a failed save or reload; the selection stays as entered. */}
      <div ref={alertRef} tabIndex={-1} className="assignments__outcome">
        <ApiErrorAlert error={formError} text={formError ? calendarErrorText(formError, mode, basis.month) : undefined} />
        <ApiErrorAlert error={reloadError} />
        {needsReload && !terminal && (
          <div>
            <button type="button" className="employees-button" disabled={reloading} aria-busy={reloading} onClick={() => { void reload(); }}>
              {reloading ? 'Aktueller Stand wird geladen …' : 'Aktuellen Stand laden'}
            </button>
          </div>
        )}
      </div>
      <div role="status" aria-live="polite">
        {reloadNotice && <p ref={reloadNoticeRef} tabIndex={-1} className="operating-calendar__reloaded">{reloadNotice}</p>}
      </div>

      <div className="employee-form__actions">
        <button
          type="submit"
          className="employees-button employees-button--primary"
          disabled={submitting || blockedReason !== null}
        >
          {submitting ? 'Wird gespeichert …' : mode === 'bootstrap' ? 'Ersteinrichtung speichern' : 'Betriebstage speichern'}
        </button>
        <button type="button" className="employees-button" disabled={submitting} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
