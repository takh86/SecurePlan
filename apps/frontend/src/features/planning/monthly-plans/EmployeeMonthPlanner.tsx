import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { formatDate, formatMonthLabel, type DateOnly, type MonthKey } from '../../../shared/time/month';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import '../../../shared/ui/PreviewNotice.css';
import { EMPLOYEE_STATUS, SHIFT_ELIGIBILITY_LABELS } from '../../employees/employee-types';
import type { EditState } from '../../projects/edit-state';
import type { Project } from '../../projects/project-types';
import {
  CORRECTION_TEXT,
  DAY_ISSUE_TEXT,
  PAINT_MODES,
  PAINT_MODE_LABELS,
  RESTRICTION_TEXT,
  SLOT_KINDS,
  UNKNOWN_CALENDAR,
  calendarWeeks,
  changeRestriction,
  changeText,
  conflictText,
  correctionOf,
  corrections,
  dayStateText,
  dayStatus,
  daySlots,
  dayText,
  emptyDraft,
  isClosed,
  issuesAfterEdit,
  keepChoice,
  monthBase,
  monthCommand,
  monthSummary,
  paint,
  paintRestriction,
  pendingChanges,
  rebase,
  revertDay,
  setDay,
  setRole,
  storedDay,
  wanted,
  withoutDuty,
  type DayIssue,
  type DayPlan,
  type DayStatus,
  type EmployeeMonthDraft,
  type EmployeeMonthSave,
  type EmployeeMonthSaveOutcome,
  type PaintMode,
  type PlannerContext,
  type ProjectCalendar,
  type RebaseReport,
} from './employee-month-draft';
import { DUTY_ROLE_LABELS, DUTY_ROLES, type Duty, type DutyRole, type MonthlyPlan } from './monthly-plan-types';
import { spokenDate, type MatrixRow } from './planning-matrix';

/** Where a save attempt stands; the draft itself is never dropped by any of them. */
type Phase =
  | { kind: 'editing' }
  | { kind: 'saving' }
  /** Lost or unreadable answer: nothing is claimed, a re-read must come first. */
  | { kind: 'unknown' }
  /** Waiting for the re-read after a confirmed save or an unknown outcome. */
  | { kind: 'verifying'; after: 'saved' | 'unknown' };

type PlannerState = {
  /** The duty read the draft is based on. */
  duties: readonly Duty[];
  draft: EmployeeMonthDraft;
  phase: Phase;
  /** Findings of the last rejected save, by day (until the day is edited). */
  issues: readonly DayIssue[];
  /** True while the last save was rejected and nothing was saved. */
  rejected: boolean;
  /** Polite status line: the last date change, a re-read or a save. */
  message: string | null;
};

type PlannerProps = {
  plan: MonthlyPlan;
  project: Project;
  month: MonthKey;
  person: MatrixRow;
  duties: readonly Duty[];
  nameOf: (employeeId: string) => string;
  /**
   * The atomic employee-month save (#88). Absent until its contract is approved
   * and implemented: the planner is then a preview and cannot save.
   */
  save?: EmployeeMonthSave;
  /** Open #88 decision: may a choice target a date/kind that has no duty yet? */
  newDuties?: boolean;
  /** Project operating days (#90). Absent until that contract exists: no date is treated as closed. */
  calendar?: ProjectCalendar;
  /** Re-reads the plan's duties (the draft is moved onto the new state). */
  onReload: () => void;
  reloading: boolean;
  onEditStateChange: (state: EditState) => void;
};

const WEEKDAYS: readonly { short: string; long: string }[] = [
  { short: 'Mo', long: 'Montag' },
  { short: 'Di', long: 'Dienstag' },
  { short: 'Mi', long: 'Mittwoch' },
  { short: 'Do', long: 'Donnerstag' },
  { short: 'Fr', long: 'Freitag' },
  { short: 'Sa', long: 'Samstag' },
  { short: 'So', long: 'Sonntag' },
];
const MARK: Record<Exclude<DayStatus, 'unchanged'>, string> = { added: '+', removed: '−', switched: '↔', 'role-changed': '~', corrected: '↔' };
const MODE_HINT: Record<PaintMode | 'NONE', string> = {
  NONE: 'Wählen Sie Tag, Nacht oder Frei und klicken Sie dann nacheinander auf die Tage.',
  DAY: 'Ein Klick auf einen Tag trägt den Tagdienst ein; ein Nachtdienst an diesem Tag wird dabei ersetzt.',
  NIGHT: 'Ein Klick auf einen Tag trägt den Nachtdienst ein; ein Tagdienst an diesem Tag wird dabei ersetzt.',
  FREE: 'Ein Klick auf einen Tag setzt ihn auf Frei: nicht eingeplant, keine Abwesenheit.',
};
const SHORTCUTS: Record<string, PaintMode> = { t: 'DAY', n: 'NIGHT', f: 'FREE' };

/** Anything but a well-formed outcome claims nothing: it is handled as unknown. */
function knownOutcome(value: unknown): EmployeeMonthSaveOutcome {
  const outcome = value as Partial<EmployeeMonthSaveOutcome> | null | undefined;
  if (outcome?.kind === 'saved') return { kind: 'saved' };
  if (outcome?.kind === 'rejected' && Array.isArray(outcome.issues)) return { kind: 'rejected', issues: outcome.issues };
  return { kind: 'unknown' };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * Status line after the draft moved onto a newer read. It reports which wanted
 * states the server already shows, without claiming who produced them (another
 * admin may have made the same change).
 */
function reloadMessage(report: RebaseReport, phase: Phase, draft: EmployeeMonthDraft): string {
  const remaining = draft.choices.size;
  if (phase.kind === 'verifying' && phase.after === 'saved') {
    return remaining === 0
      ? 'Der Monat wurde gespeichert. Der aktuelle Stand ist geladen.'
      : `Der Monat wurde gespeichert. ${plural(remaining, 'Änderung entspricht', 'Änderungen entsprechen')} nicht dem aktuellen Stand; bitte prüfen Sie sie.`;
  }
  const parts = ['Der aktuelle Stand wurde geladen.'];
  const reached = report.reached.length;
  if (reached > 0) {
    parts.push(reached === 1 ? 'Eine Ihrer Änderungen ist darin bereits enthalten.' : `${reached} Ihrer Änderungen sind darin bereits enthalten.`);
  }
  if (report.conflicts.length > 0) {
    parts.push(`${plural(report.conflicts.length, 'Änderung betrifft', 'Änderungen betreffen')} inzwischen geänderte Dienste; bitte entscheiden Sie dort.`);
  }
  const elsewhere = report.changedElsewhere.length;
  if (elsewhere > 0) {
    parts.push(elsewhere === 1
      ? 'Ein weiterer Tag dieser Person wurde inzwischen geändert.'
      : `${elsewhere} weitere Tage dieser Person wurden inzwischen geändert.`);
  }
  parts.push(remaining === 0 ? 'Es gibt keine ungespeicherten Änderungen.' : `${plural(remaining, 'Änderung ist', 'Änderungen sind')} noch nicht gespeichert.`);
  return parts.join(' ');
}

/**
 * Issue #88 employee-month planning for ONE person: the admin chooses a mode
 * (Tag, Nacht or Frei) and marks dates in a month calendar. Per date the
 * person has one shift or none; Tag and Nacht replace each other, and
 * repeating a mode changes nothing. Changes stay in a local draft until one
 * "Monat speichern". Other members of a duty are shown and never changed.
 * Without `save` this is a preview: "Monat speichern" stays unavailable and
 * nothing is written.
 */
export function EmployeeMonthPlanner({
  plan, project, month, person, duties, nameOf, save, newDuties = true, calendar = UNKNOWN_CALENDAR, onReload, reloading, onEditStateChange,
}: PlannerProps) {
  const [state, setState] = useState<PlannerState>(() => ({
    duties,
    draft: emptyDraft(monthBase(duties, person.employeeId, month)),
    phase: { kind: 'editing' },
    issues: [],
    rejected: false,
    message: null,
  }));
  // A newer duty read moves the draft onto it during render ("adjust state on change").
  if (state.duties !== duties) {
    const moved = rebase(state.draft, monthBase(duties, person.employeeId, month));
    const phase = state.phase;
    setState({
      ...state,
      duties,
      draft: moved.draft,
      phase: phase.kind === 'saving' ? phase : { kind: 'editing' },
      message: phase.kind === 'saving' ? state.message : reloadMessage(moved.report, phase, moved.draft),
    });
  }
  const { draft, phase, issues } = state;
  const context: PlannerContext = {
    employee: person.employee,
    assigned: person.assigned,
    projectActive: project.status === 'ACTIVE',
    newDuties,
    calendar,
  };
  const changes = useMemo(() => pendingChanges(draft), [draft]);
  const fixes = useMemo(() => corrections(draft, calendar), [draft, calendar]);
  const summary = useMemo(() => monthSummary(draft), [draft]);
  const [mode, setMode] = useState<PaintMode | null>(null);
  const [active, setActive] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const grid = useRef<HTMLTableElement>(null);
  const alertRef = useRef<HTMLHeadingElement>(null);
  const [focusAlert, setFocusAlert] = useState<object | null>(null);
  const ids = useId();

  const editState: EditState = phase.kind === 'saving' ? 'saving' : draft.choices.size > 0 ? 'dirty' : 'clean';
  useEffect(() => {
    onEditStateChange(editState);
  }, [editState, onEditStateChange]);
  useEffect(() => () => onEditStateChange('clean'), [onEditStateChange]);
  useEffect(() => {
    if (focusAlert) alertRef.current?.focus();
  }, [focusAlert]);

  const days = draft.base.days;
  const activeDate = days[Math.min(active, days.length - 1)];
  const locked = phase.kind === 'saving';

  function announce(message: string) {
    setState((current) => ({ ...current, message }));
  }

  function chooseMode(next: PaintMode) {
    setMode(next);
    announce(`Eintragen als: ${PAINT_MODE_LABELS[next]}.`);
  }

  /** One click or key activation on a date: paint it with the current mode. */
  function onDate(date: DateOnly) {
    setActive(days.indexOf(date));
    if (locked) return;
    if (mode === null) {
      announce('Wählen Sie zuerst Tag, Nacht oder Frei.');
      return;
    }
    setState((current) => {
      const restriction = paintRestriction(context, current.draft, date, mode);
      if (restriction !== null) {
        return { ...current, message: `${spokenDate(date)}: ${PAINT_MODE_LABELS[mode]} nicht möglich – ${RESTRICTION_TEXT[restriction]}.` };
      }
      const next = paint(current.draft, date, mode);
      if (next === current.draft) {
        return { ...current, message: `${spokenDate(date)}: bereits ${dayText(wanted(next, date))}, keine Änderung.` };
      }
      return { ...current, draft: next, issues: issuesAfterEdit(current.issues, date), message: `${spokenDate(date)}: ${dayText(wanted(next, date))}.` };
    });
  }

  function editDay(date: DateOnly, change: (draft: EmployeeMonthDraft) => EmployeeMonthDraft) {
    if (locked) return;
    setState((current) => {
      const next = change(current.draft);
      if (next === current.draft) return current;
      return { ...current, draft: next, issues: issuesAfterEdit(current.issues, date), message: `${spokenDate(date)}: ${dayText(wanted(next, date))}.` };
    });
  }

  function onRole(date: DateOnly, role: DutyRole) {
    const current = wanted(draft, date);
    if (current === null || current === 'BOTH') return;
    if (changeRestriction(context, daySlots(draft.base, date)[current.kind], role) !== null) return;
    editDay(date, (value) => setRole(value, date, role));
  }

  function resolve(date: DateOnly, keep: boolean) {
    if (locked) return;
    setState((current) => ({ ...current, draft: keep ? keepChoice(current.draft, date) : revertDay(current.draft, date), message: null }));
  }

  function discardAll() {
    setConfirmDiscard(false);
    setState((current) => ({ ...current, draft: emptyDraft(current.draft.base), issues: [], rejected: false, message: 'Alle ungespeicherten Änderungen wurden verworfen.' }));
  }

  function reload() {
    setState((current) => ({
      ...current,
      phase: current.phase.kind === 'unknown' ? { kind: 'verifying', after: 'unknown' } : current.phase,
      message: null,
    }));
    onReload();
  }

  function focusIndex(index: number) {
    setActive(index);
    grid.current?.querySelector<HTMLButtonElement>(`button[data-index="${index}"]`)?.focus();
  }

  function focusDate(date: DateOnly) {
    const index = days.indexOf(date);
    if (index >= 0) focusIndex(index);
  }

  async function onSave() {
    if (!save || phase.kind !== 'editing') return;
    const command = monthCommand(draft, plan.id, calendar);
    if (command === null) return;
    setState((current) => ({ ...current, phase: { kind: 'saving' }, rejected: false, message: null }));
    let outcome: EmployeeMonthSaveOutcome;
    try {
      outcome = knownOutcome(await save(command));
    } catch {
      // An adapter failure proves nothing about the server: treat it as unknown.
      outcome = { kind: 'unknown' };
    }
    if (outcome.kind === 'saved') {
      setState((current) => ({ ...current, phase: { kind: 'verifying', after: 'saved' }, issues: [], message: 'Gespeichert. Der aktuelle Stand wird geladen …' }));
      onReload();
      return;
    }
    if (outcome.kind === 'rejected') {
      setState((current) => ({ ...current, phase: { kind: 'editing' }, issues: outcome.issues, rejected: true }));
    } else {
      setState((current) => ({ ...current, phase: { kind: 'unknown' } }));
    }
    setFocusAlert({});
  }

  const saveBlocked = !save
    ? 'Vorschau: Das Speichern eines ganzen Monats ist noch nicht freigegeben. Es wird nichts gespeichert.'
    : phase.kind === 'saving'
      ? 'Der Monat wird gespeichert …'
      : phase.kind === 'unknown'
        ? 'Prüfen Sie zuerst den aktuellen Stand.'
        : phase.kind === 'verifying'
          ? 'Der aktuelle Stand wird geladen …'
          : draft.choices.size === 0
            ? 'Es gibt keine ungespeicherten Änderungen.'
            : draft.conflicts.size > 0
              ? 'Entscheiden Sie zuerst über die inzwischen geänderten Dienste.'
              : fixes.length > 0
                ? `Korrigieren Sie zuerst ${plural(fixes.length, 'Tag', 'Tage')} unter „Korrektur nötig“.`
                : null;

  return (
    <div className="month-planner">
      {!save && (
        <aside className="preview-notice month-planner__preview" aria-label="Hinweis zur Vorschau">
          <p>
            <strong>Vorschau:</strong> Monat einer Person planen – noch ohne Speichern. Ihre Auswahl bleibt nur in
            dieser Ansicht und wird beim Verlassen verworfen. Einzelne Dienste ändern Sie weiterhin in der Ansicht
            „Alle Personen“.
          </p>
        </aside>
      )}
      <PersonFacts person={person} month={month} context={context} />
      {calendar.status === 'unknown' && (
        <p className="employees-card__hint">
          Betriebstage des Projekts sind hier noch nicht hinterlegt: Die Ansicht sperrt keine Wochentage. Ob das
          Projekt an einem Tag in Betrieb ist, prüft der Server beim Speichern.
        </p>
      )}

      {/* Always mounted, so screen readers announce new messages. */}
      <div role="status" aria-live="polite">
        {state.message && <p className="employees__notice">{state.message}</p>}
      </div>
      {state.rejected && (
        <div className="planning-editor__problem" role="alert">
          <h4 ref={alertRef} tabIndex={-1}>Monat nicht gespeichert</h4>
          <p>
            Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.{' '}
            {issues.length === 0
              ? 'Laden Sie den aktuellen Stand und prüfen Sie Ihre Auswahl.'
              : `Bitte korrigieren Sie ${plural(new Set(issues.map((issue) => issue.date)).size, 'Tag', 'Tage')}:`}
          </p>
          {issues.length > 0 && (
            <ul>
              {issues.map((issue) => (
                <li key={`${issue.date}|${issue.kind ?? ''}|${issue.reason}`}>
                  <button type="button" className="month-planner__link" onClick={() => focusDate(issue.date)}>
                    {formatDate(issue.date)}{issue.kind ? `, ${SHIFT_TYPE_LABELS[issue.kind]}` : ''}
                  </button>
                  : {DAY_ISSUE_TEXT[issue.reason]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(phase.kind === 'unknown' || (phase.kind === 'verifying' && phase.after === 'unknown')) && (
        <div className="planning-editor__problem" role="alert">
          <h4 ref={alertRef} tabIndex={-1}>Ergebnis unbekannt</h4>
          <p>
            Die Antwort des Servers ist nicht angekommen. Ob der Monat gespeichert wurde, ist unklar. Ihre Auswahl
            bleibt erhalten. Prüfen Sie den aktuellen Stand, bevor Sie erneut speichern.
          </p>
          <button type="button" className="employees-button" disabled={reloading} onClick={reload}>
            Aktuellen Stand prüfen
          </button>
        </div>
      )}

      <div className="month-planner__layout">
        <div className="month-planner__main">
          <fieldset className="month-planner__modes">
            <legend>Eintragen als</legend>
            {PAINT_MODES.map((value) => (
              <label key={value} className={`month-planner__mode month-planner__mode--${value.toLowerCase()}`}>
                <input type="radio" name={`${ids}-mode`} checked={mode === value} onChange={() => chooseMode(value)} />
                {PAINT_MODE_LABELS[value]}
              </label>
            ))}
            <p className="month-planner__mode-hint">{MODE_HINT[mode ?? 'NONE']}</p>
          </fieldset>
          <p className="month-planner__summary">
            Im Monat: {summary.day} × Tag, {summary.night} × Nacht, {summary.free} × Frei
            {summary.both > 0 && `, ${summary.both} × Tag und Nacht (Korrektur nötig)`}
          </p>

          {fixes.length > 0 && (
            <section className="month-planner__fixes" aria-labelledby={`${ids}-fixes`}>
              <h4 id={`${ids}-fixes`}>Korrektur nötig ({fixes.length})</h4>
              <p>
                Diese Tage verstoßen gegen „ein Dienst pro Tag“{calendar.status === 'known' ? ' oder die Betriebstage des Projekts' : ''}.
                Es wird nichts automatisch geändert; der Monat kann erst nach Ihrer Korrektur gespeichert werden.
              </p>
              <ul>
                {fixes.map((fix) => (
                  <li key={fix.date}>
                    <button type="button" className="month-planner__link" onClick={() => focusDate(fix.date)}>
                      {formatDate(fix.date)}
                    </button>
                    : {CORRECTION_TEXT[fix.reason]}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <MonthCalendar
            caption={`Dienste von ${person.name} im ${formatMonthLabel(month)}`}
            draft={draft}
            context={context}
            mode={mode}
            issues={issues}
            active={active}
            locked={locked}
            gridRef={grid}
            onActive={setActive}
            onFocusIndex={focusIndex}
            onMode={chooseMode}
            onDate={onDate}
          />
          <p className="employees-card__hint">
            Tag = Tagdienst, Nacht = Nachtdienst, – = Frei (nicht eingeplant; keine Abwesenheit), SL = Schichtleitung.
            Ungespeicherte Änderungen: + neu, − auf Frei gesetzt, ↔ Dienst gewechselt, ~ Funktion geändert; ! = Hinweis,
            ⚠ = bitte prüfen oder korrigieren. Tastatur: T, N oder F wählt den Modus; Leertaste oder Eingabe markiert den Tag;
            Pfeiltasten bewegen um einen Tag oder eine Woche, Pos1/Ende zum Wochenanfang/-ende, Strg+Pos1/Ende zum
            Monatsanfang/-ende.
          </p>
        </div>

        <div className="month-planner__side">
          <DayDetails
            date={activeDate}
            draft={draft}
            context={context}
            issues={issues}
            locked={locked}
            plannerId={ids}
            nameOf={nameOf}
            onRole={onRole}
            onSet={(date, value) => editDay(date, (current) => setDay(current, date, value))}
            onRevert={(date) => editDay(date, (current) => revertDay(current, date))}
            onResolve={resolve}
          />

          <section className="month-planner__changes" aria-labelledby={`${ids}-changes`}>
            <h4 id={`${ids}-changes`}>Ungespeicherte Änderungen ({changes.length})</h4>
            {changes.length === 0 ? (
              <p>Keine ungespeicherten Änderungen.</p>
            ) : (
              <>
                <ul className="month-planner__change-list">
                  {changes.map((change) => (
                    <li key={change.date} className={change.conflict ? 'month-planner__change--conflict' : undefined}>
                      <button type="button" className="month-planner__link" onClick={() => focusDate(change.date)}>
                        {formatDate(change.date)}
                      </button>
                      {' · '}{changeText(change)}
                      {change.conflict && (
                        <> <StatusBadge tone="attention">Prüfen</StatusBadge> {conflictText(change.conflict, change.before)}</>
                      )}
                      {' '}
                      <button
                        type="button"
                        className="employees-button month-planner__small"
                        disabled={locked}
                        aria-label={`Zurücksetzen: ${formatDate(change.date)}`}
                        onClick={() => editDay(change.date, (current) => revertDay(current, change.date))}
                      >
                        Zurücksetzen
                      </button>
                    </li>
                  ))}
                </ul>
                {confirmDiscard ? (
                  <div className="employees-confirm" role="group" aria-label="Alle Änderungen verwerfen">
                    <p>{plural(changes.length, 'ungespeicherte Änderung', 'ungespeicherte Änderungen')} verwerfen?</p>
                    <div className="employee-form__actions">
                      <button type="button" className="employees-button employees-button--danger" onClick={discardAll}>Ja, alle verwerfen</button>
                      <button type="button" className="employees-button" onClick={() => setConfirmDiscard(false)}>Abbrechen</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="employees-button" disabled={locked} onClick={() => setConfirmDiscard(true)}>
                    Alle Änderungen verwerfen
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      <div className="month-planner__savebar">
        <p className="month-planner__count">
          {changes.length === 0 ? 'Keine ungespeicherten Änderungen' : plural(changes.length, 'ungespeicherte Änderung', 'ungespeicherte Änderungen')}
          {draft.conflicts.size > 0 && ` · ${plural(draft.conflicts.size, 'Tag', 'Tage')} prüfen`}
          {fixes.length > 0 && ` · ${plural(fixes.length, 'Tag', 'Tage')} korrigieren`}
        </p>
        <button
          type="button"
          className="employees-button"
          disabled={reloading || locked}
          onClick={reload}
        >
          Aktuellen Stand laden
        </button>
        <button
          type="button"
          className="employees-button employees-button--primary"
          aria-disabled={saveBlocked !== null ? true : undefined}
          aria-describedby={saveBlocked !== null ? `${ids}-save-blocked` : undefined}
          onClick={() => { if (saveBlocked === null) void onSave(); }}
        >
          {phase.kind === 'saving' ? 'Monat wird gespeichert …' : 'Monat speichern'}
        </button>
        {saveBlocked !== null && <p id={`${ids}-save-blocked`} className="month-planner__save-note">{saveBlocked}</p>}
        {plan.status === 'PUBLISHED' && (
          <p className="month-planner__save-note">
            Der Plan ist veröffentlicht: Gespeicherte Änderungen gelten sofort, ohne erneutes Veröffentlichen.
          </p>
        )}
      </div>
    </div>
  );
}

function PersonFacts({ person, month, context }: { person: MatrixRow; month: MonthKey; context: PlannerContext }) {
  const employee = person.employee;
  const notes: string[] = [];
  if (!context.projectActive) notes.push('Das Projekt ist inaktiv: Sie können Tage nur auf Frei setzen.');
  if (employee === null) notes.push('Diese Person ist nicht mehr unter den Mitarbeitenden: Sie können Tage nur auf Frei setzen.');
  else if (!person.assigned) notes.push(`Im ${formatMonthLabel(month)} nicht diesem Projekt zugeordnet: Sie können Tage nur auf Frei setzen.`);
  else if (employee.status !== 'ACTIVE') notes.push('Die Person ist deaktiviert: Sie können Tage nur auf Frei setzen.');
  return (
    <>
      <dl className="employees-card__facts">
        {employee && (
          <>
            <div><dt>Eignung</dt><dd>{SHIFT_ELIGIBILITY_LABELS[employee.shiftEligibility]}</dd></div>
            <div>
              <dt>Status</dt>
              <dd><StatusBadge tone={EMPLOYEE_STATUS[employee.status].tone}>{EMPLOYEE_STATUS[employee.status].label}</StatusBadge></dd>
            </div>
            <div>
              <dt>Beschäftigt</dt>
              <dd>
                {employee.employmentStart ? `ab ${formatDate(employee.employmentStart)}` : 'Beginn nicht dokumentiert'}
                {employee.employmentEnd ? ` bis ${formatDate(employee.employmentEnd)}` : ''}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Projektzuordnung</dt>
          <dd>{person.assigned ? `Im ${formatMonthLabel(month)} zugeordnet` : `Im ${formatMonthLabel(month)} nicht zugeordnet`}</dd>
        </div>
      </dl>
      {notes.map((note) => <p key={note} className="planning-day__hint">{note}</p>)}
    </>
  );
}

type CalendarProps = {
  caption: string;
  draft: EmployeeMonthDraft;
  context: PlannerContext;
  mode: PaintMode | null;
  issues: readonly DayIssue[];
  active: number;
  locked: boolean;
  gridRef: RefObject<HTMLTableElement | null>;
  onActive: (index: number) => void;
  onFocusIndex: (index: number) => void;
  onMode: (mode: PaintMode) => void;
  onDate: (date: DateOnly) => void;
};

/** Short visible label of a date's wanted state. */
function shortState(after: ReturnType<typeof wanted>, status: DayStatus): string {
  if (after === 'BOTH') return 'Tag + Nacht';
  if (after === null) return status === 'unchanged' ? '–' : 'Frei';
  return PAINT_MODE_LABELS[after.kind];
}

/**
 * The month as a calendar (Monday first) in an ARIA grid. Each date is one
 * button: activating it paints the date with the current mode. Roving
 * tabindex (one tab stop); arrows move by a day or a week, Home/End to the
 * start/end of the week, Ctrl+Home/End to the first/last day; T, N and F
 * choose the mode. A date's name carries its state, the description carries
 * the unsaved change, restriction, correction and findings.
 */
function MonthCalendar({ caption, draft, context, mode, issues, active, locked, gridRef, onActive, onFocusIndex, onMode, onDate }: CalendarProps) {
  const captionId = useId();
  const describe = useId();
  const days = draft.base.days;
  const weeks = calendarWeeks(days);
  const position = Math.min(active, days.length - 1);

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const target = event.target as HTMLElement;
    if (target.dataset.index === undefined) return;
    if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      const shortcut = SHORTCUTS[event.key.toLowerCase()];
      if (shortcut) {
        event.preventDefault();
        onMode(shortcut);
        return;
      }
    }
    const index = Number(target.dataset.index);
    const weekday = Number(target.dataset.weekday);
    const last = days.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = Math.min(last, index + 1); break;
      case 'ArrowLeft': next = Math.max(0, index - 1); break;
      case 'ArrowDown': next = index + 7 <= last ? index + 7 : index; break;
      case 'ArrowUp': next = index - 7 >= 0 ? index - 7 : index; break;
      case 'Home': next = event.ctrlKey ? 0 : Math.max(0, index - weekday); break;
      case 'End': next = event.ctrlKey ? last : Math.min(last, index + 6 - weekday); break;
      default: return;
    }
    event.preventDefault();
    onFocusIndex(next);
  }

  return (
    <>
      <p className="planning-matrix__title" aria-hidden="true">{caption}</p>
      <table
        ref={gridRef}
        className="month-calendar"
        role="grid"
        aria-labelledby={captionId}
        onKeyDown={onKeyDown}
      >
        <caption id={captionId} className="planning-matrix__sr">{caption}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday.short} scope="col" abbr={weekday.long}>{weekday.short}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find((date) => date !== null)}>
              {week.map((date, weekday) => {
                if (date === null) return <td key={`pad-${weekday}`} className="month-calendar__pad" />;
                const index = days.indexOf(date);
                const slots = daySlots(draft.base, date);
                const before = storedDay(draft.base, date);
                const after = wanted(draft, date);
                const status = dayStatus(before, after);
                const conflict = draft.conflicts.get(date) ?? null;
                const found = issues.filter((issue) => issue.date === date);
                const fix = correctionOf(draft, date, context.calendar);
                const closed = isClosed(context.calendar, date);
                const restriction = mode === null ? null : paintRestriction(context, draft, date, mode);
                const unavailable = SLOT_KINDS.some((kind) => slots[kind].unavailable);
                const lead = after !== null && after !== 'BOTH'
                  ? after.role === 'SHIFT_LEAD'
                  : after === 'BOTH' && SLOT_KINDS.some((kind) => slots[kind].role === 'SHIFT_LEAD');
                const name = `${spokenDate(date)}: ${after === 'BOTH' ? 'Tagdienst und Nachtdienst, Korrektur nötig' : dayText(after)}`;
                const description = [
                  status !== 'unchanged' ? `Geändert, bisher ${dayText(before)}, noch nicht gespeichert` : null,
                  withoutDuty(slots, after) ? 'Dienst noch nicht angelegt' : null,
                  unavailable ? 'Hinweis: nicht verfügbar' : null,
                  closed ? 'Projekt an diesem Tag nicht in Betrieb' : null,
                  fix ? `Korrektur nötig: ${CORRECTION_TEXT[fix]}` : null,
                  restriction && mode ? `${PAINT_MODE_LABELS[mode]} nicht möglich: ${RESTRICTION_TEXT[restriction]}` : null,
                  conflict ? conflictText(conflict, before) : null,
                  ...found.map((issue) => `Nicht gespeichert: ${issue.kind ? `${SHIFT_TYPE_LABELS[issue.kind]}: ` : ''}${DAY_ISSUE_TEXT[issue.reason]}`),
                ].filter(Boolean).join('. ');
                const classes = [
                  'month-calendar__day',
                  after === 'BOTH' ? 'month-calendar__day--both' : after === null ? 'month-calendar__day--free' : `month-calendar__day--${after.kind.toLowerCase()}`,
                  status !== 'unchanged' ? 'month-calendar__day--changed' : '',
                  closed ? 'month-calendar__day--closed' : '',
                  restriction ? 'month-calendar__day--restricted' : '',
                  fix || conflict || found.length > 0 ? 'month-calendar__day--problem' : '',
                ].filter(Boolean).join(' ');
                return (
                  <td key={date}>
                    <button
                      type="button"
                      className={classes}
                      data-index={index}
                      data-weekday={weekday}
                      tabIndex={index === position ? 0 : -1}
                      aria-label={name}
                      aria-describedby={description ? `${describe}-${index}` : undefined}
                      aria-disabled={restriction !== null || locked ? true : undefined}
                      onFocus={() => onActive(index)}
                      onClick={() => onDate(date)}
                    >
                      <span className="month-calendar__top" aria-hidden="true">
                        <span className="month-calendar__num">{Number(date.slice(8, 10))}</span>
                        {status !== 'unchanged' && <span className="month-calendar__mark">{MARK[status]}</span>}
                      </span>
                      <span className="month-calendar__state" aria-hidden="true">{shortState(after, status)}</span>
                      <span className="month-calendar__flags" aria-hidden="true">
                        {lead && <span className="planning-matrix__mark">SL</span>}
                        {unavailable && <span className="planning-matrix__mark planning-matrix__mark--hint">!</span>}
                        {(fix || conflict || found.length > 0) && <span className="month-calendar__warn">⚠</span>}
                        {closed && <span className="month-calendar__closed">geschl.</span>}
                      </span>
                    </button>
                    {description && <span id={`${describe}-${index}`} className="planning-matrix__sr">{description}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

type DayDetailsProps = {
  date: DateOnly;
  draft: EmployeeMonthDraft;
  context: PlannerContext;
  issues: readonly DayIssue[];
  locked: boolean;
  plannerId: string;
  nameOf: (employeeId: string) => string;
  onRole: (date: DateOnly, role: DutyRole) => void;
  onSet: (date: DateOnly, plan: DayPlan) => void;
  onRevert: (date: DateOnly) => void;
  onResolve: (date: DateOnly, keep: boolean) => void;
};

const byName = new Intl.Collator('de-DE', { sensitivity: 'base' });

/**
 * The active date: wanted state, role, correction of stored data with both
 * shifts, other members of both duties (unchanged), conflicts and findings.
 */
function DayDetails({ date, draft, context, issues, locked, plannerId, nameOf, onRole, onSet, onRevert, onResolve }: DayDetailsProps) {
  const slots = daySlots(draft.base, date);
  const before = storedDay(draft.base, date);
  const after = wanted(draft, date);
  const status = dayStatus(before, after);
  const conflict = draft.conflicts.get(date) ?? null;
  const fix = correctionOf(draft, date, context.calendar);
  return (
    <section className="month-planner__day" aria-labelledby={`${plannerId}-day`}>
      <h4 id={`${plannerId}-day`}>Ausgewählter Tag: {spokenDate(date)}</h4>
      <p><strong>Geplant:</strong> {dayStateText(slots, before, after)}</p>
      {isClosed(context.calendar, date) && <p className="planning-day__hint">Das Projekt ist an diesem Tag nicht in Betrieb.</p>}
      {fix && (
        <div className="planning-editor__problem">
          <p><StatusBadge tone="attention">Korrektur nötig</StatusBadge> {CORRECTION_TEXT[fix]}</p>
          <div className="employee-form__actions">
            {fix === 'BOTH_SHIFTS' && SLOT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="employees-button"
                disabled={locked}
                onClick={() => onSet(date, { kind, role: slots[kind].role! })}
              >
                Nur {SHIFT_TYPE_LABELS[kind]} behalten
              </button>
            ))}
            <button type="button" className="employees-button" disabled={locked} onClick={() => onSet(date, null)}>
              {fix === 'BOTH_SHIFTS' ? 'Frei (beide austragen)' : 'Auf Frei setzen'}
            </button>
          </div>
        </div>
      )}
      {after !== null && after !== 'BOTH' && (
        <fieldset className="month-planner__roles">
          <legend>Funktion im {SHIFT_TYPE_LABELS[after.kind]}</legend>
          {DUTY_ROLES.map((role) => {
            const restricted = changeRestriction(context, slots[after.kind], role);
            return (
              <label key={role}>
                <input
                  type="radio"
                  name={`${plannerId}-${date}-role`}
                  checked={after.role === role}
                  disabled={locked || (restricted !== null && after.role !== role)}
                  onChange={() => onRole(date, role)}
                />
                {DUTY_ROLE_LABELS[role]}
              </label>
            );
          })}
        </fieldset>
      )}
      {SLOT_KINDS.map((kind) => {
        const others = [...slots[kind].others].sort((a, b) => byName.compare(nameOf(a.employeeId), nameOf(b.employeeId)));
        return (
          <p key={kind} className="month-planner__others">
            {slots[kind].dutyId === null
              ? `Noch kein ${SHIFT_TYPE_LABELS[kind]} angelegt.`
              : others.length === 0
                ? `${SHIFT_TYPE_LABELS[kind]}: keine weiteren Personen eingeplant.`
                : `${SHIFT_TYPE_LABELS[kind]}, weitere Personen (bleiben unverändert): ${others
                  .map((other) => `${nameOf(other.employeeId)}${other.dutyRole === 'SHIFT_LEAD' ? ` (${DUTY_ROLE_LABELS.SHIFT_LEAD})` : ''}`)
                  .join(', ')}`}
          </p>
        );
      })}
      {conflict && (
        <div className="planning-editor__problem">
          <p>{conflictText(conflict, before)}</p>
          <div className="employee-form__actions">
            <button type="button" className="employees-button" disabled={locked} onClick={() => onResolve(date, true)}>Meine Auswahl behalten</button>
            <button type="button" className="employees-button" disabled={locked} onClick={() => onResolve(date, false)}>Aktuellen Stand übernehmen</button>
          </div>
        </div>
      )}
      {issues.filter((issue) => issue.date === date).map((issue) => (
        <p key={`${issue.kind ?? ''}|${issue.reason}`} className="planning-day__hint">
          <StatusBadge tone="attention">Nicht gespeichert</StatusBadge>{' '}
          {issue.kind ? `${SHIFT_TYPE_LABELS[issue.kind]}: ` : ''}{DAY_ISSUE_TEXT[issue.reason]}
        </p>
      ))}
      {status !== 'unchanged' && !conflict && (
        <button type="button" className="employees-button month-planner__small" disabled={locked} onClick={() => onRevert(date)}>
          Diesen Tag zurücksetzen
        </button>
      )}
    </section>
  );
}
