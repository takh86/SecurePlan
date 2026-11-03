import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../../shared/api/api-error';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { dateInMonth, daysInMonth, formatDate, formatMonthLabel, type MonthKey } from '../../../shared/time/month';
import { ApiErrorAlert } from '../../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { LoadingState } from '../../../shared/ui/ViewStates';
import { civilDate } from '../../employees/availability-api';
import type { Employee } from '../../employees/employee-types';
import type { EditState } from '../../projects/edit-state';
import type { ProjectAssignment } from '../../projects/project-assignments-api';
import type { Project } from '../../projects/project-types';
import { SHIFT_KINDS } from '../../projects/shift-configuration-api';
import type { LeaseStatus } from './duty-edit-lease';
import {
  ROSTER_REASON_TEXT,
  describeChanges,
  draftOf,
  dutyChanges,
  hasChanges,
  matchesDraft,
  rosterView,
  type DutyDraft,
  type RosterOption,
} from './duty-editor-model';
import { dutyTimeView } from './duty-time';
import { DUTY_ROLES, DUTY_ROLE_LABELS, type Duty, type DutyRole, type MonthlyPlan } from './monthly-plan-types';
import type { MonthlyPlansApi } from './monthly-plans-api';
import { UNKNOWN_PERSON } from './planning-matrix';
import { outcomeUnknown, planningErrorText, unknownOutcomeText, type PlanningWrite } from './planning-errors';
import { useDutyEditLease } from './use-duty-edit-lease';

export type DutyEditorProps = {
  plan: MonthlyPlan;
  project: Project;
  /** The duty as the matrix shows it; the editor works on the server's current state. */
  snapshot: Duty;
  /** Person whose matrix cell opened the editor; listed first. */
  focusEmployeeId: string | null;
  employees: Employee[];
  assignments: ProjectAssignment[];
  /** All live duties of the plan (to catch an occupied date/kind before sending). */
  duties: readonly Duty[];
  apis: { plans: MonthlyPlansApi };
  timeZone: string;
  /** The server's state differs from the matrix (newer version): show it there too. */
  onFresh: (duty: Duty) => void;
  /** The plan's current status, read when the lease was granted (CR-03 wording). */
  onPlanFresh: (plan: MonthlyPlan) => void;
  /** `verified`: confirmed by a re-read after an unknown outcome. */
  onSaved: (duty: Duty, verified: boolean) => void;
  onRemoved: (duty: Duty, verified: boolean) => void;
  /** The duty is no longer visible: the caller re-reads the plan's duties. */
  onGone: () => void;
  onClose: () => void;
  onEditStateChange: (state: EditState) => void;
};

type Phase = 'idle' | 'loading' | 'saving' | 'removing' | 'checking';
type WriteFailure = { write: Extract<PlanningWrite, 'update-duty' | 'remove-duty'>; error: Error };

function monthOf(plan: MonthlyPlan): MonthKey {
  return plan.monthStart.slice(0, 7);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * UX A10 focus editor for ONE existing duty (SP-12). It acquires the duty's
 * edit lease, reads the duty's current state, and saves exactly one PATCH or
 * DELETE under `Expected-Version` and the lease. Nothing is retried: a lost
 * response, a version conflict or a lost lease is shown, the admin's input is
 * kept, and only an explicit action re-reads the server state. Under CR-03 a
 * change to a PUBLISHED plan is effective at once; there is no re-publish.
 */
export function DutyEditor(props: DutyEditorProps) {
  const {
    plan, project, snapshot, focusEmployeeId, employees, assignments, duties, apis, timeZone,
    onFresh, onPlanFresh, onSaved, onRemoved, onGone, onClose, onEditStateChange,
  } = props;
  const dutyId = snapshot.id;
  const id = useId();
  const { lease, status } = useDutyEditLease(apis.plans, plan.id, dutyId);
  const [base, setBase] = useState<Duty | null>(null);
  const [draft, setDraft] = useState<DutyDraft | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [goneRead, setGone] = useState(false);
  // Gone: a read found no duty, or the lease endpoint did (404).
  const gone = goneRead || status.kind === 'gone';
  /** A version conflict: the admin's draft is kept until they explicitly load the current state. */
  const [stale, setStale] = useState(false);
  const [unknown, setUnknown] = useState<'update-duty' | 'remove-duty' | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const verifiedGrant = useRef(0);
  const confirmHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const month = monthOf(plan);
  const names = useMemo(
    () => new Map(employees.map((employee) => [employee.id.toLowerCase(), `${employee.firstName} ${employee.lastName}`])),
    [employees],
  );
  const nameOf = (employeeId: string) => names.get(employeeId.toLowerCase()) ?? UNKNOWN_PERSON;

  const changes = base && draft ? dutyChanges(base, draft) : {};
  const dirty = hasChanges(changes);
  const busy = phase !== 'idle';
  const editState: EditState = phase === 'saving' || phase === 'removing' ? 'saving' : dirty ? 'dirty' : 'clean';
  useEffect(() => {
    onEditStateChange(editState);
  }, [editState, onEditStateChange]);
  useEffect(() => () => onEditStateChange('clean'), [onEditStateChange]);

  /**
   * After every NEW grant (first open, re-acquire after a loss, back/forward
   * cache restore): read the duty and the plan. The first read becomes the
   * base; later reads keep the draft only if the duty is still unchanged.
   */
  useEffect(() => {
    if (status.kind !== 'held' || status.grant === verifiedGrant.current) return;
    verifiedGrant.current = status.grant;
    const first = base === null;
    setPhase('loading');
    setLoadError(null);
    Promise.all([apis.plans.getDuty(plan.id, dutyId), apis.plans.get(plan.id)]).then(
      ([fresh, currentPlan]) => {
        if (!mounted.current) return;
        onPlanFresh(currentPlan);
        if (fresh.version !== snapshot.version) onFresh(fresh);
        if (first) {
          setBase(fresh);
          setDraft(draftOf(fresh));
        } else if (base !== null && fresh.version === base.version) {
          setBase(fresh);
          setInfo('Der Dienst ist wieder für Sie reserviert und unverändert. Ihre Eingaben sind erhalten; Sie können speichern.');
        } else {
          setStale(true);
        }
        setPhase('idle');
      },
      (error: unknown) => {
        if (!mounted.current) return;
        if (isNotFound(error)) setGone(true);
        else setLoadError(error instanceof Error ? error : new Error('Load failed'));
        setPhase('idle');
      },
    );
  }, [status, base, apis, plan.id, dutyId, snapshot.version, onFresh, onPlanFresh]);

  useEffect(() => {
    if (confirmRemove) confirmHeading.current?.focus();
  }, [confirmRemove]);

  const view = base && draft
    ? rosterView(base, draft, employees, assignments, project.id, plan.monthStart, focusEmployeeId)
    : null;
  const projectActive = project.status === 'ACTIVE';
  const blocked = stale || unknown !== null || gone;
  const fieldsDisabled = busy || blocked || !projectActive;
  const canSave = lease.held && dirty && !busy && !blocked && projectActive;
  const canRemove = lease.held && !busy && !blocked && base !== null;
  const current = base ?? snapshot;
  const first = dateInMonth(month, 1)!;
  const last = dateInMonth(month, daysInMonth(month))!;

  function update(next: (draft: DutyDraft) => DutyDraft) {
    setDraft((value) => (value ? next(value) : value));
    setFieldError(null);
    setInfo(null);
    setFailure(null);
  }

  function toggle(option: RosterOption, checked: boolean) {
    update((value) => {
      const roster = { ...value.roster };
      if (checked) roster[option.key] = { employeeId: option.employeeId, dutyRole: option.role };
      else delete roster[option.key];
      return { ...value, roster };
    });
  }

  function setRole(option: RosterOption, role: DutyRole) {
    update((value) => ({ ...value, roster: { ...value.roster, [option.key]: { employeeId: option.employeeId, dutyRole: role } } }));
  }

  function validate(value: DutyDraft): string | null {
    if (!civilDate(value.dutyDate)) return 'Bitte geben Sie ein gültiges Datum ein.';
    if (value.dutyDate < first || value.dutyDate > last) return `Das Datum muss im ${formatMonthLabel(month)} liegen.`;
    const taken = duties.some((duty) =>
      duty.id.toLowerCase() !== dutyId.toLowerCase() && duty.dutyDate === value.dutyDate && duty.shiftKind === value.shiftKind);
    return taken ? `Am ${formatDate(value.dutyDate)} gibt es in diesem Plan bereits einen ${SHIFT_TYPE_LABELS[value.shiftKind]}.` : null;
  }

  function failed(error: unknown, write: WriteFailure['write']) {
    const cause = error instanceof Error ? error : new Error('Write failed');
    if (isCode(cause, 'EDIT_LEASE_NOT_HELD')) lease.markLost();
    if (isCode(cause, 'PLAN_CONCURRENT_MODIFICATION')) {
      setStale(true);
      return;
    }
    if (outcomeUnknown(cause)) {
      setUnknown(write);
      return;
    }
    setFailure({ write, error: cause });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !base || !draft || !canSave) return;
    const problem = validate(draft);
    if (problem) {
      setFieldError(problem);
      document.getElementById(`${id}-date`)?.focus();
      return;
    }
    inFlight.current = true;
    setPhase('saving');
    setFailure(null);
    setInfo(null);
    try {
      const saved = await lease.withToken((token) => apis.plans.updateDuty(plan.id, base.id, changes, base.version, token));
      onSaved(saved, false);
    } catch (error) {
      if (mounted.current) failed(error, 'update-duty');
    } finally {
      inFlight.current = false;
      if (mounted.current) setPhase('idle');
    }
  }

  async function remove() {
    if (inFlight.current || !base || !canRemove) return;
    inFlight.current = true;
    setPhase('removing');
    setFailure(null);
    setInfo(null);
    try {
      await lease.withToken((token) => apis.plans.removeDuty(plan.id, base.id, base.version, token));
      lease.markEnded();
      onRemoved(base, false);
    } catch (error) {
      if (mounted.current) {
        setConfirmRemove(false);
        failed(error, 'remove-duty');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPhase('idle');
    }
  }

  /** Explicit re-read after an unknown outcome or a "not found": decides what actually happened. */
  async function checkCurrent() {
    if (inFlight.current || !base) return;
    inFlight.current = true;
    setPhase('checking');
    try {
      const fresh = await apis.plans.getDuty(plan.id, dutyId);
      if (!mounted.current) return;
      if (fresh.version !== snapshot.version) onFresh(fresh);
      setFailure(null);
      if (fresh.version === base.version) {
        setBase(fresh);
        setInfo(unknown === 'remove-duty'
          ? 'Der Dienst wurde nicht gelöscht; er ist unverändert.'
          : 'Die Änderungen wurden nicht gespeichert; der Dienst ist unverändert. Ihre Eingaben sind erhalten.');
        setUnknown(null);
      } else if (unknown === 'update-duty' && draft && matchesDraft(fresh, draft)) {
        onSaved(fresh, true);
      } else {
        setUnknown(null);
        setStale(true);
      }
    } catch (error) {
      if (!mounted.current) return;
      if (isNotFound(error)) {
        if (unknown === 'remove-duty') {
          lease.markEnded();
          onRemoved(base, true);
        } else {
          setGone(true);
        }
      } else {
        setFailure({ write: unknown ?? 'update-duty', error: error instanceof Error ? error : new Error('Load failed') });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPhase('idle');
    }
  }

  /** Stale: replace base AND draft with the server state, on explicit request only. */
  async function loadCurrent() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase('checking');
    try {
      const fresh = await apis.plans.getDuty(plan.id, dutyId);
      if (!mounted.current) return;
      onFresh(fresh);
      // The newer state is exactly what the admin wanted (e.g. their own write, re-sent by the
      // browser after a dropped connection and refused as a duplicate): say so, discard nothing.
      if (base !== null && draft !== null && fresh.version !== base.version && hasChanges(changes) && matchesDraft(fresh, draft)) {
        onSaved(fresh, true);
        return;
      }
      setBase(fresh);
      setDraft(draftOf(fresh));
      setStale(false);
      setFailure(null);
      setInfo('Der aktuelle Stand wurde geladen.');
    } catch (error) {
      if (!mounted.current) return;
      if (isNotFound(error)) setGone(true);
      else setFailure({ write: 'update-duty', error: error instanceof Error ? error : new Error('Load failed') });
    } finally {
      inFlight.current = false;
      if (mounted.current) setPhase('idle');
    }
  }

  const time = dutyTimeView(current, timeZone);
  const pending = base && draft ? describeChanges(base, draft, nameOf) : [];
  const title = `${SHIFT_TYPE_LABELS[current.shiftKind]} am ${formatDate(current.dutyDate)}`;

  return (
    <div className="planning-editor" aria-busy={busy}>
      <p className="planning-editor__time">
        Dienstzeit: {time.text}
        {base && draft && (draft.dutyDate !== base.dutyDate || draft.shiftKind !== base.shiftKind) && (
          <> – wird beim Speichern aus den Schichtzeiten des Projekts neu bestimmt.</>
        )}
      </p>
      <PlanEffectNote plan={plan} />
      <LeaseNotice status={status} hasDraft={base !== null} onAcquire={() => { void lease.acquire(); }} />
      {/* Always mounted, so screen readers announce new messages. */}
      <div role="status" aria-live="polite">
        {info && <p className="planning-editor__info">{info}</p>}
      </div>

      {gone ? (
        <div className="planning-editor__problem" role="alert">
          <p><strong>Dienst nicht mehr vorhanden</strong></p>
          <p>Dieser Dienst ist nicht mehr vorhanden oder nicht mehr sichtbar. Es wurde nichts gespeichert.</p>
          <button type="button" className="employees-button" onClick={onGone}>Dienste neu laden</button>
        </div>
      ) : (
        <>
          {stale && (
            <div className="planning-editor__problem" role="alert">
              <p><strong>Dienst wurde inzwischen geändert</strong></p>
              <p>
                Der Dienst wurde geändert, seit Sie ihn geöffnet haben. Es wurde nichts überschrieben. Laden Sie den
                aktuellen Stand; Ihre ungespeicherten Eingaben werden dabei verworfen.
              </p>
              {pending.length > 0 && (
                <>
                  <p>Ihre bisher nicht gespeicherten Eingaben (zum erneuten Eintragen):</p>
                  <ul>{pending.map((line) => <li key={line}>{line}</li>)}</ul>
                </>
              )}
              <button type="button" className="employees-button" disabled={busy} onClick={() => { void loadCurrent(); }}>
                Aktuellen Stand laden
              </button>
            </div>
          )}
          {unknown && (
            <div className="planning-editor__problem" role="alert">
              <p><strong>{unknownOutcomeText(unknown).title}</strong></p>
              <p>{unknownOutcomeText(unknown).description}</p>
              <button type="button" className="employees-button" disabled={busy} onClick={() => { void checkCurrent(); }}>
                {phase === 'checking' ? 'Stand wird geprüft …' : 'Aktuellen Stand prüfen'}
              </button>
            </div>
          )}
          {failure && (
            <>
              <ApiErrorAlert error={failure.error} text={planningErrorText(failure.error, failure.write)} />
              {isNotFound(failure.error) && (
                <button type="button" className="employees-button" disabled={busy} onClick={() => { void checkCurrent(); }}>
                  Aktuellen Stand prüfen
                </button>
              )}
            </>
          )}
          {loadError && <ApiErrorAlert error={loadError} />}

          {base && draft && view ? (
            <form className="employee-form planning-editor__form" noValidate onSubmit={(event) => { void save(event); }}>
              {!projectActive && (
                <p className="employees-card__hint">
                  Das Projekt ist inaktiv: Datum, Dienstart und Besetzung können nicht geändert werden. Löschen bleibt möglich.
                </p>
              )}
              <div className="employee-form__field">
                <label htmlFor={`${id}-date`}>Datum</label>
                <input
                  id={`${id}-date`}
                  type="date"
                  min={first}
                  max={last}
                  required
                  value={draft.dutyDate}
                  disabled={fieldsDisabled}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? `${id}-date-error` : undefined}
                  onChange={(event) => update((value) => ({ ...value, dutyDate: event.target.value }))}
                />
                {fieldError && <p id={`${id}-date-error`} className="employee-form__error">{fieldError}</p>}
              </div>
              <fieldset className="employee-form__choices" disabled={fieldsDisabled}>
                <legend>Dienstart</legend>
                {SHIFT_KINDS.map((option) => (
                  <label key={option}>
                    <input
                      type="radio"
                      name={`${id}-kind`}
                      value={option}
                      checked={draft.shiftKind === option}
                      onChange={() => update((value) => ({ ...value, shiftKind: option }))}
                    />
                    {SHIFT_TYPE_LABELS[option]}
                  </label>
                ))}
              </fieldset>
              <RosterFieldset
                id={id}
                options={view.options}
                excluded={view.excluded}
                disabled={fieldsDisabled}
                onToggle={toggle}
                onRole={setRole}
              />

              <div className="planning-editor__pending" aria-live="polite">
                {pending.length === 0 ? (
                  <p className="employee-form__hint">Keine ungespeicherten Änderungen.</p>
                ) : (
                  <>
                    <p className="employee-form__hint">Noch nicht gespeichert:</p>
                    <ul>{pending.map((line) => <li key={line}>{line}</li>)}</ul>
                  </>
                )}
              </div>
              <div className="employee-form__actions">
                <button type="submit" className="employees-button employees-button--primary" disabled={!canSave} aria-busy={phase === 'saving'}>
                  {phase === 'saving' ? 'Änderungen werden gespeichert …' : 'Änderungen speichern'}
                </button>
                <button
                  type="button"
                  className="employees-button employees-button--danger"
                  disabled={!canRemove || confirmRemove}
                  onClick={() => setConfirmRemove(true)}
                >
                  Dienst löschen
                </button>
                <button type="button" className="employees-button" disabled={phase === 'saving' || phase === 'removing'} onClick={onClose}>
                  Schließen
                </button>
              </div>
              {!lease.held && <p className="employee-form__hint">Speichern und Löschen sind nur mit einer gültigen Reservierung möglich.</p>}
            </form>
          ) : phase === 'loading' || status.kind === 'acquiring' ? (
            <LoadingState label="Dienst wird geladen …" />
          ) : (
            <ReadOnlyDuty duty={current} nameOf={nameOf} onClose={onClose} />
          )}

          {confirmRemove && base && (
            <div className="employees-confirm planning-editor__confirm" role="group" aria-labelledby={`${id}-remove-title`}>
              <h4 id={`${id}-remove-title`} ref={confirmHeading} tabIndex={-1}>{title} löschen?</h4>
              <ul>
                <li>
                  {base.assignments.length === 0
                    ? 'Der Dienst hat keine Besetzung.'
                    : base.assignments.length === 1
                      ? '1 eingeplante Person wird aus diesem Dienst ausgetragen.'
                      : `${base.assignments.length} eingeplante Personen werden aus diesem Dienst ausgetragen.`}
                </li>
                <li>
                  {plan.status === 'PUBLISHED'
                    ? 'Der Plan ist veröffentlicht: Das Löschen gilt sofort, ohne erneutes Veröffentlichen.'
                    : 'Der Plan ist noch nicht veröffentlicht.'}
                </li>
                <li>Wurde der Dienst inzwischen geändert, wird er nicht gelöscht.</li>
                {dirty && <li>Ihre ungespeicherten Änderungen werden verworfen.</li>}
              </ul>
              <div className="employee-form__actions">
                <button
                  type="button"
                  className="employees-button employees-button--danger"
                  disabled={busy || !lease.held}
                  onClick={() => { void remove(); }}
                >
                  {phase === 'removing' ? 'Dienst wird gelöscht …' : 'Ja, Dienst löschen'}
                </button>
                <button type="button" className="employees-button" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Abbrechen
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** CR-03: what a saved change means for the plan (no employee visibility is promised: SP-14 reads do not exist yet). */
function PlanEffectNote({ plan }: { plan: MonthlyPlan }) {
  return plan.status === 'PUBLISHED' ? (
    <p className="planning-editor__effect">
      <StatusBadge tone="success">Veröffentlicht</StatusBadge> Gespeicherte Änderungen gelten sofort im veröffentlichten
      Plan; ein erneutes Veröffentlichen ist nicht nötig.
    </p>
  ) : (
    <p className="planning-editor__effect">
      <StatusBadge tone="info">Unveröffentlicht</StatusBadge> Gespeicherte Änderungen werden Teil der späteren Veröffentlichung.
    </p>
  );
}

function LeaseNotice({ status, hasDraft, onAcquire }: { status: LeaseStatus; hasDraft: boolean; onAcquire: () => void }) {
  // Always mounted: changes of the reservation are announced politely.
  return (
    <div className="planning-lease" role="status" aria-live="polite">
      {status.kind === 'acquiring' && <p>Der Dienst wird für Ihre Bearbeitung reserviert …</p>}
      {status.kind === 'held' && (
        <p>
          <StatusBadge tone="success">Für Sie reserviert</StatusBadge> Solange dieser Bereich geöffnet ist, kann niemand
          sonst den Dienst ändern. Die Reservierung wird automatisch verlängert.
          {status.renewalProblem && ' Die letzte Verlängerung ist fehlgeschlagen (Verbindung); sie wird wiederholt.'}
        </p>
      )}
      {status.kind === 'locked' && (
        <div className="planning-lease__problem">
          <p>
            <StatusBadge tone="attention">Wird bearbeitet</StatusBadge> Dieser Dienst wird gerade von einer anderen Person
            bearbeitet. Sie sehen den zuletzt geladenen Stand; ändern oder löschen können Sie ihn erst, wenn diese
            Bearbeitung endet oder ihre Reservierung abläuft.
          </p>
          <button type="button" className="employees-button" onClick={onAcquire}>Erneut versuchen</button>
        </div>
      )}
      {status.kind === 'lost' && (
        <div className="planning-lease__problem">
          <p>
            <StatusBadge tone="attention">Reservierung abgelaufen</StatusBadge> Ihre Reservierung gilt nicht mehr (abgelaufen
            oder in einem anderen Fenster übernommen).{hasDraft && ' Ihre Eingaben sind erhalten, aber noch nicht gespeichert.'}
          </p>
          <button type="button" className="employees-button" onClick={onAcquire}>Erneut reservieren</button>
        </div>
      )}
      {status.kind === 'failed' && (
        <div className="planning-lease__problem">
          <ApiErrorAlert error={status.error} />
          <button type="button" className="employees-button" onClick={onAcquire}>Erneut reservieren</button>
        </div>
      )}
    </div>
  );
}

type RosterProps = {
  id: string;
  options: RosterOption[];
  excluded: { key: string; name: string; reason: keyof typeof ROSTER_REASON_TEXT }[];
  disabled: boolean;
  onToggle: (option: RosterOption, checked: boolean) => void;
  onRole: (option: RosterOption, role: DutyRole) => void;
};

function RosterFieldset({ id, options, excluded, disabled, onToggle, onRole }: RosterProps) {
  const selected = options.filter((option) => option.selected).length;
  return (
    <fieldset className="planning-roster" disabled={disabled}>
      <legend>Besetzung</legend>
      <p className="employee-form__hint">
        Beim Speichern prüft SecurePlan die gesamte Besetzung erneut, auch Abwesenheiten und Überschneidungen.
      </p>
      {options.length === 0 ? (
        <p>Für diesen Dienst ist keine Person auswählbar.</p>
      ) : (
        <ul className="planning-roster__list" aria-label="Besetzung des Dienstes">
          {options.map((option) => {
            const noteId = `${id}-note-${option.key}`;
            const note = rosterNote(option);
            return (
              <li key={option.key} className={`planning-roster__item${option.focus ? ' planning-roster__item--focus' : ''}`}>
                <label className="planning-roster__person">
                  <input
                    type="checkbox"
                    checked={option.selected}
                    disabled={!option.selected && !option.selectable}
                    aria-describedby={note ? noteId : undefined}
                    onChange={(event) => onToggle(option, event.target.checked)}
                  />
                  {option.name}
                  {option.code && <> <span className="planning-roster__code">({option.code})</span></>}
                </label>
                <select
                  className="assignments__select planning-roster__role"
                  aria-label={`Funktion im Dienst für ${option.name}`}
                  disabled={!option.selected}
                  value={option.role}
                  onChange={(event) => onRole(option, event.target.value as DutyRole)}
                >
                  {DUTY_ROLES.map((role) => <option key={role} value={role}>{DUTY_ROLE_LABELS[role]}</option>)}
                </select>
                {note && <p id={noteId} className="planning-roster__note">{note}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="employees__count" aria-live="polite">
        {selected === 0 ? 'Niemand eingeplant' : selected === 1 ? '1 Person eingeplant' : `${selected} Personen eingeplant`}
      </p>
      {excluded.length > 0 && (
        <details className="planning-roster__excluded">
          <summary>
            {excluded.length === 1
              ? '1 weitere zugeordnete Person ist nicht auswählbar'
              : `${excluded.length} weitere zugeordnete Personen sind nicht auswählbar`}
          </summary>
          <ul>{excluded.map((item) => <li key={item.key}>{item.name}: {ROSTER_REASON_TEXT[item.reason]}</li>)}</ul>
        </details>
      )}
    </fieldset>
  );
}

function rosterNote(option: RosterOption): string | null {
  const parts: string[] = [];
  if (option.focus) parts.push('Person aus der gewählten Zelle.');
  if (option.reason) {
    parts.push(option.selected || option.stored
      ? `${capitalize(ROSTER_REASON_TEXT[option.reason])}: Solange die Person eingeplant ist, wird eine Änderung voraussichtlich abgelehnt.`
      : `${capitalize(ROSTER_REASON_TEXT[option.reason])}: nicht auswählbar.`);
  }
  if (option.unavailable) {
    parts.push('Am Diensttag nicht verfügbar: Solange die Person eingeplant ist, wird eine Änderung voraussichtlich abgelehnt.');
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ReadOnlyDuty({ duty, nameOf, onClose }: { duty: Duty; nameOf: (employeeId: string) => string; onClose: () => void }) {
  return (
    <div className="planning-editor__readonly">
      <p className="employee-form__hint">Besetzung (nur Ansicht):</p>
      {duty.assignments.length === 0 ? (
        <p>Noch keine Besetzung</p>
      ) : (
        <ul className="planning-members">
          {duty.assignments.map((member) => (
            <li key={member.id}>
              {nameOf(member.employeeId)}
              {member.dutyRole === 'SHIFT_LEAD' && <span className="planning-members__role"> · {DUTY_ROLE_LABELS.SHIFT_LEAD}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="employee-form__actions">
        <button type="button" className="employees-button" onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}
