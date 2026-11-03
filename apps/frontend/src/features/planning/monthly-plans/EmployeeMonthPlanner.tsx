import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
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
  KEPT_ON_BLOCKED_DAY_TEXT,
  NEW_DUTY_TEXT,
  PAINT_MODES,
  PAINT_MODE_LABELS,
  RESTRICTION_TEXT,
  SLOT_KINDS,
  UNKNOWN_CALENDAR,
  calendarBlock,
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
  draftBlock,
  emptyDraft,
  isClosed,
  issuesAfterEdit,
  keepChoice,
  keptOnBlockedDay,
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
  type MonthBase,
  type OtherMember,
  type PaintMode,
  type PlannerContext,
  type ProjectCalendar,
  type RebaseReport,
  type SlotBase,
} from './employee-month-draft';
import type { EmployeeMonthApi, SaveResult } from './employee-month-api';
import {
  REFUSAL_TITLE,
  classifyLookupError,
  classifySaveError,
  newSaveAttempt,
  readDrift,
  refusalText,
  savedText,
  type SaveAttempt,
  type SaveRefusal,
} from './employee-month-save';
import { DUTY_ROLE_LABELS, DUTY_ROLES, type DutyRole, type MonthlyPlan } from './monthly-plan-types';
import { spokenDate, type MatrixRow } from './planning-matrix';

/**
 * Where a save stands. The draft itself is never dropped by any of them; an
 * attempt (route, key and exact body) stays frozen until its outcome is known.
 */
type Phase =
  | { kind: 'editing' }
  | { kind: 'saving'; attempt: SaveAttempt }
  /** No or unreadable answer: the command may have committed. Ask the server first. */
  | { kind: 'unknown'; attempt: SaveAttempt; lookupFailed: boolean }
  | { kind: 'checking'; attempt: SaveAttempt }
  /** The server still runs this key's command. */
  | { kind: 'running'; attempt: SaveAttempt }
  /** Proven not completed: the same key and body may be sent again after an explicit decision. */
  | { kind: 'not-completed'; attempt: SaveAttempt }
  /** No evidence either way (UNKNOWN): a fresh read and a new decision are required. */
  | { kind: 'unresolved' }
  /** A definite refusal: nothing was saved. */
  | { kind: 'refused'; refusal: SaveRefusal }
  /** Waiting for the re-read, after a committed save (`result`) or an explicit reconciliation. */
  | { kind: 'verifying'; result: SaveResult | null }
  /** The plan or person is gone (404) or the action is not allowed (403). */
  | { kind: 'terminal'; reason: 'gone' | 'forbidden' };

/** Phases a newer read does not end: a request is running or an attempt is unresolved. */
const HELD: ReadonlySet<Phase['kind']> = new Set(['saving', 'checking', 'unknown', 'running', 'not-completed', 'terminal']);
/** Phases in which the draft cannot be edited (until a re-read, it shows what was sent or committed). */
const LOCKED: ReadonlySet<Phase['kind']> = new Set(['saving', 'checking', 'unknown', 'running', 'not-completed', 'unresolved', 'verifying', 'terminal']);
/** Phases with an unresolved attempt: leaving would lose track of its outcome. */
const UNRESOLVED: ReadonlySet<Phase['kind']> = new Set(['unknown', 'running', 'not-completed', 'unresolved']);

type PlannerState = {
  /** The server state the draft is on (a new `base` prop moves it). */
  base: MonthBase;
  draft: EmployeeMonthDraft;
  phase: Phase;
  /** Findings of the last refusal, by day (until the day is edited). */
  issues: readonly DayIssue[];
  /** Polite status line: the last date change, a re-read or a save. */
  message: string | null;
};

type PlannerProps = {
  plan: MonthlyPlan;
  project: Project;
  month: MonthKey;
  person: MatrixRow;
  /**
   * The server state to plan on: the plan's duties (preview) or the A2
   * employee-month read (with `base.source`). A new object moves the draft onto it.
   */
  base: MonthBase;
  /** Other members of a slot's duty, context only (null = not known here). */
  othersOf?: (slot: SlotBase) => readonly OtherMember[] | null;
  nameOf: (employeeId: string) => string;
  /**
   * The A2 save client (#88, contract A2-GATE-1). Absent in the preview: the
   * planner then cannot save. Requires a `base` built from the A2 read.
   */
  api?: Pick<EmployeeMonthApi, 'save' | 'saveResult'>;
  /** Whether a choice may target a date/kind without a duty (settled by A2; preview switch). */
  newDuties?: boolean;
  /** Project operating days: from the A2 read; absent in the preview (no date is treated as closed). */
  calendar?: ProjectCalendar;
  /** Re-reads the server state (the draft is moved onto the new `base`). */
  onReload: () => void;
  reloading: boolean;
  /** The last re-read failed; the shown state is older. */
  reloadFailed?: boolean;
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
const PREVIEW_BLOCK = 'Vorschau: Das Speichern eines ganzen Monats ist hier noch nicht freigegeben. Es wird nichts gespeichert.';

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * Status line after the draft moved onto a newer read. It reports which wanted
 * states the server already shows, without claiming who produced them (another
 * admin may have made the same change), and month-wide changes of the basis.
 */
function reloadMessage(report: RebaseReport, phase: Phase, draft: EmployeeMonthDraft, drift: readonly string[]): string {
  const remaining = draft.choices.size;
  if (phase.kind === 'verifying' && phase.result !== null) {
    const parts = [savedText(phase.result), 'Der aktuelle Stand ist geladen.', ...drift];
    if (remaining > 0) parts.push(`${plural(remaining, 'Änderung entspricht', 'Änderungen entsprechen')} nicht dem aktuellen Stand; bitte prüfen Sie sie.`);
    return parts.join(' ');
  }
  const parts = ['Der aktuelle Stand wurde geladen.', ...drift];
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

function calendarHint(calendar: ProjectCalendar, base: MonthBase, month: MonthKey): string {
  if (calendar.status === 'unknown') {
    return 'Betriebstage des Projekts sind hier noch nicht hinterlegt: Die Ansicht sperrt keine Wochentage. Ob das Projekt an einem Tag in Betrieb ist, prüft der Server beim Speichern.';
  }
  if (calendar.status === 'missing') {
    return `Für das Projekt sind im ${formatMonthLabel(month)} keine Betriebstage festgelegt: Neue Dienste sind nicht möglich, Sie können Tage nur auf Frei setzen. Betriebstage legen Sie unter „Projekte“ im Abschnitt „Betriebstage“ fest.`;
  }
  const weekdays = base.source?.calendar?.operatingWeekdays ?? [];
  const names = weekdays.map((day) => WEEKDAYS[day - 1].short).join(', ');
  return `Betriebstage des Projekts: ${names}. An anderen Tagen sind keine neuen Dienste möglich; bestehende Dienste bleiben, bis Sie sie auf Frei setzen.`;
}

const ownOthers = (slot: SlotBase) => slot.others;

/**
 * Issue #88 employee-month planning for ONE person: the admin chooses a mode
 * (Tag, Nacht or Frei) and marks dates in a month calendar. Per date the
 * person has one shift or none; Tag and Nacht replace each other, and
 * repeating a mode changes nothing. Changes stay in a local draft until one
 * "Monat speichern": the A2 command with the complete month and every
 * precondition of the read (`api`). Other members of a duty are shown and
 * never changed. Without `api` this is a preview that cannot save.
 */
export function EmployeeMonthPlanner({
  plan, project, month, person, base, othersOf = ownOthers, nameOf, api, newDuties = true, calendar = UNKNOWN_CALENDAR,
  onReload, reloading, reloadFailed = false, onEditStateChange,
}: PlannerProps) {
  const [state, setState] = useState<PlannerState>(() => ({
    base,
    draft: emptyDraft(base),
    phase: { kind: 'editing' },
    issues: [],
    message: null,
  }));
  // A newer server state moves the draft onto it during render ("adjust state on change").
  if (state.base !== base) {
    const moved = rebase(state.draft, base);
    const drift = state.base.source && base.source ? readDrift(state.base.source, base.source) : [];
    const held = HELD.has(state.phase.kind);
    setState({
      ...state,
      base,
      draft: moved.draft,
      phase: held ? state.phase : { kind: 'editing' },
      message: held ? state.message : reloadMessage(moved.report, state.phase, moved.draft, drift),
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
  /** One request at a time (double clicks, a lookup during a save). */
  const busy = useRef(false);
  const ids = useId();

  // After a committed save every choice of the draft was part of the command: nothing is unsaved,
  // even while the re-read is pending or failed.
  const editState: EditState = phase.kind === 'saving' || phase.kind === 'checking'
    ? 'saving'
    : phase.kind === 'verifying' && phase.result !== null
      ? 'clean'
      : draft.choices.size > 0 || UNRESOLVED.has(phase.kind) ? 'dirty' : 'clean';
  useEffect(() => {
    onEditStateChange(editState);
  }, [editState, onEditStateChange]);
  useEffect(() => () => onEditStateChange('clean'), [onEditStateChange]);
  // Reloading or closing the tab would drop the in-memory draft (or an unresolved outcome): the browser asks first.
  useEffect(() => {
    if (editState === 'clean') return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editState]);
  useEffect(() => {
    if (focusAlert) alertRef.current?.focus();
  }, [focusAlert]);

  const days = draft.base.days;
  const activeDate = days[Math.min(active, days.length - 1)];
  const locked = LOCKED.has(phase.kind);
  const shownPlan = state.base.source?.plan ?? plan;

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
    setState((current) => ({ ...current, draft: emptyDraft(current.draft.base), issues: [], message: 'Alle ungespeicherten Änderungen wurden verworfen.' }));
  }

  /** Re-read; an unresolved attempt is given up only from not-completed/unresolved (after the lookup). */
  function reload() {
    setState((current) => {
      const ends = current.phase.kind === 'not-completed' || current.phase.kind === 'unresolved'
        || (current.phase.kind === 'refused' && current.phase.refusal.needsReload);
      return { ...current, phase: ends ? { kind: 'verifying', result: null } : current.phase, message: null };
    });
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

  /** A receipt proves the commit (fresh or replayed); the current state is then re-read. */
  function committed(result: SaveResult) {
    setState((current) => ({ ...current, phase: { kind: 'verifying', result }, issues: [], message: `${savedText(result)} Der aktuelle Stand wird geladen …` }));
    onReload();
  }

  /** Sends one attempt (a new one, or the same key and body after NOT_COMPLETED). Never retried here. */
  async function send(attempt: SaveAttempt) {
    if (!api || busy.current) return;
    busy.current = true;
    setState((current) => ({ ...current, phase: { kind: 'saving', attempt }, message: null }));
    try {
      committed(await api.save(attempt.planId, attempt.employeeId, attempt.key, attempt.body));
      return;
    } catch (error) {
      const failure = classifySaveError(error);
      setState((current) => {
        switch (failure.kind) {
          case 'unknown':
            return { ...current, phase: { kind: 'unknown', attempt, lookupFailed: false } };
          case 'refused':
            return { ...current, phase: { kind: 'refused', refusal: failure.refusal }, issues: failure.refusal.issues };
          case 'gone':
          case 'forbidden':
            return { ...current, phase: { kind: 'terminal', reason: failure.kind } };
          default:
            // 401: nothing was saved; the session boundary shows the login.
            return { ...current, phase: { kind: 'editing' } };
        }
      });
      setFocusAlert({});
    } finally {
      busy.current = false;
    }
  }

  async function onSave() {
    if (!api || saveBlocked !== null || busy.current) return;
    let attempt: SaveAttempt;
    try {
      attempt = newSaveAttempt(draft);
    } catch {
      return;
    }
    await send(attempt);
  }

  /** Asks the server for the outcome of the frozen attempt; never sends the save itself. */
  async function lookup(attempt: SaveAttempt) {
    if (!api || busy.current) return;
    busy.current = true;
    setState((current) => ({ ...current, phase: { kind: 'checking', attempt } }));
    try {
      const answer = await api.saveResult(attempt.planId, attempt.employeeId, attempt.key, attempt.body);
      if (answer.state === 'COMPLETED') {
        committed(answer.result);
        return;
      }
      setState((current) => ({
        ...current,
        phase: answer.state === 'IN_PROGRESS'
          ? { kind: 'running', attempt }
          : answer.state === 'NOT_COMPLETED' ? { kind: 'not-completed', attempt } : { kind: 'unresolved' },
      }));
    } catch (error) {
      const failure = classifyLookupError(error);
      setState((current) => ({
        ...current,
        phase: failure === 'in-progress'
          ? { kind: 'running', attempt }
          : failure === 'gone' || failure === 'forbidden'
            ? { kind: 'terminal', reason: failure }
            : { kind: 'unknown', attempt, lookupFailed: true },
      }));
    } finally {
      busy.current = false;
    }
    setFocusAlert({});
  }

  const block = draftBlock(draft, calendar);
  const saveBlocked = !api
    ? PREVIEW_BLOCK
    : phase.kind === 'saving'
      ? 'Der Monat wird gespeichert …'
      : phase.kind === 'checking'
        ? 'Das Ergebnis wird abgefragt …'
        : phase.kind === 'unknown'
          ? 'Fragen Sie zuerst das Ergebnis des letzten Speicherns ab.'
          : phase.kind === 'running'
            ? 'Das letzte Speichern wird noch verarbeitet. Fragen Sie das Ergebnis erneut ab.'
            : phase.kind === 'not-completed'
              ? 'Entscheiden Sie zuerst, wie es mit dem nicht abgeschlossenen Speichern weitergeht.'
              : phase.kind === 'unresolved'
                ? 'Laden Sie zuerst den aktuellen Stand.'
                : phase.kind === 'terminal'
                  ? 'Dieser Monat kann hier nicht gespeichert werden.'
                  : phase.kind === 'verifying'
                    ? reloadFailed ? 'Laden Sie den aktuellen Stand erneut.' : 'Der aktuelle Stand wird geladen …'
                    : reloading
                      ? 'Der aktuelle Stand wird geladen …'
                      : phase.kind === 'refused' && phase.refusal.needsReload
                        ? 'Laden Sie zuerst den aktuellen Stand.'
                        : block === 'NO_CHANGES'
                          ? 'Es gibt keine ungespeicherten Änderungen.'
                          : block === 'CONFLICTS'
                            ? 'Entscheiden Sie zuerst über die inzwischen geänderten Dienste.'
                            : block === 'CORRECTIONS'
                              ? `Korrigieren Sie zuerst ${plural(fixes.length, 'Tag', 'Tage')} unter „Korrektur nötig“.`
                              : null;
  const reloadDisabled = reloading || ['saving', 'checking', 'unknown', 'running', 'terminal'].includes(phase.kind);

  return (
    <div className="month-planner">
      {!api && (
        <aside className="preview-notice month-planner__preview" aria-label="Hinweis zur Vorschau">
          <p>
            <strong>Vorschau:</strong> Monat einer Person planen – noch ohne Speichern. Ihre Auswahl bleibt nur in
            dieser Ansicht und wird beim Verlassen verworfen. Einzelne Dienste ändern Sie weiterhin in der Ansicht
            „Alle Personen“.
          </p>
        </aside>
      )}
      <PersonFacts person={person} month={month} context={context} />
      <p className="employees-card__hint">{calendarHint(calendar, state.base, month)}</p>

      {/* Always mounted, so screen readers announce new messages. */}
      <div role="status" aria-live="polite">
        {state.message && <p className="employees__notice">{state.message}</p>}
      </div>
      <SaveAlert
        phase={phase}
        issues={issues}
        reloading={reloading}
        alertRef={alertRef}
        onFocusDate={focusDate}
        onLookup={(attempt) => void lookup(attempt)}
        onResend={(attempt) => void send(attempt)}
        onReload={reload}
      />

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
                Diese Tage verstoßen gegen „ein Dienst pro Tag“{calendar.status !== 'unknown' ? ' oder die Betriebstage des Projekts' : ''}.
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
            othersOf={othersOf}
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
        <button type="button" className="employees-button" disabled={reloadDisabled} onClick={reload}>
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
        {shownPlan.status === 'PUBLISHED' && (
          <p className="month-planner__save-note">
            Der Plan ist veröffentlicht: Gespeicherte Änderungen gelten sofort, ohne erneutes Veröffentlichen.
          </p>
        )}
      </div>
    </div>
  );
}

type SaveAlertProps = {
  phase: Phase;
  issues: readonly DayIssue[];
  reloading: boolean;
  alertRef: RefObject<HTMLHeadingElement | null>;
  onFocusDate: (date: DateOnly) => void;
  onLookup: (attempt: SaveAttempt) => void;
  onResend: (attempt: SaveAttempt) => void;
  onReload: () => void;
};

function Problem({ title, alertRef, children }: { title: string; alertRef: RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  return (
    <div className="planning-editor__problem" role="alert">
      <h4 ref={alertRef} tabIndex={-1}>{title}</h4>
      {children}
    </div>
  );
}

const RECONCILE = 'Aktuellen Stand laden und Auswahl prüfen';

/** The one alert of a save: refusal, unknown outcome and its lookup, or a terminal state. */
function SaveAlert({ phase, issues, reloading, alertRef, onFocusDate, onLookup, onResend, onReload }: SaveAlertProps) {
  switch (phase.kind) {
    case 'refused': {
      const { refusal } = phase;
      return (
        <Problem title={REFUSAL_TITLE[refusal.stage]} alertRef={alertRef}>
          <p>{refusalText(refusal)}</p>
          {issues.length > 0 && (
            <ul>
              {issues.map((issue) => (
                <li key={`${issue.date}|${issue.kind}`}>
                  <button type="button" className="month-planner__link" onClick={() => onFocusDate(issue.date)}>
                    {formatDate(issue.date)}, {SHIFT_TYPE_LABELS[issue.kind]}
                  </button>
                  : {DAY_ISSUE_TEXT[issue.reason]}
                </li>
              ))}
            </ul>
          )}
          {refusal.correlationId && <p className="employee-form__hint">Referenz: {refusal.correlationId}</p>}
        </Problem>
      );
    }
    case 'unknown':
    case 'checking':
      return (
        <Problem title="Ergebnis unbekannt" alertRef={alertRef}>
          <p>
            Die Antwort des Servers ist nicht angekommen. Ob der Monat gespeichert wurde, ist unklar; Ihre Auswahl
            bleibt erhalten. Fragen Sie zuerst das Ergebnis ab – es wird dabei nichts erneut gespeichert.
          </p>
          {phase.kind === 'unknown' && phase.lookupFailed && (
            <p>Die Abfrage ist fehlgeschlagen. Versuchen Sie es erneut.</p>
          )}
          <button
            type="button"
            className="employees-button employees-button--primary"
            disabled={phase.kind === 'checking'}
            onClick={() => onLookup(phase.attempt)}
          >
            {phase.kind === 'checking' ? 'Ergebnis wird abgefragt …' : 'Ergebnis abfragen'}
          </button>
        </Problem>
      );
    case 'running':
      return (
        <Problem title="Speichern läuft noch" alertRef={alertRef}>
          <p>Der Server verarbeitet das Speichern noch. Fragen Sie das Ergebnis in einem Moment erneut ab.</p>
          <button type="button" className="employees-button employees-button--primary" onClick={() => onLookup(phase.attempt)}>
            Ergebnis erneut abfragen
          </button>
        </Problem>
      );
    case 'not-completed':
      return (
        <Problem title="Monat nicht gespeichert" alertRef={alertRef}>
          <p>
            Der Server bestätigt: Das letzte Speichern wurde nicht abgeschlossen, es wurde nichts gespeichert. Sie
            können dieselbe Auswahl unverändert erneut speichern – der Server prüft sie dann vollständig neu – oder
            zuerst den aktuellen Stand laden und Ihre Auswahl prüfen.
          </p>
          <div className="employee-form__actions">
            <button type="button" className="employees-button employees-button--primary" onClick={() => onResend(phase.attempt)}>
              Unverändert erneut speichern
            </button>
            <button type="button" className="employees-button" disabled={reloading} onClick={onReload}>{RECONCILE}</button>
          </div>
        </Problem>
      );
    case 'unresolved':
      return (
        <Problem title="Ergebnis nicht feststellbar" alertRef={alertRef}>
          <p>
            Ob der Monat gespeichert wurde, lässt sich nicht mehr feststellen. Ihre Auswahl ist erhalten. Laden Sie
            den aktuellen Stand und prüfen Sie Ihre Auswahl, bevor Sie erneut speichern.
          </p>
          <button type="button" className="employees-button employees-button--primary" disabled={reloading} onClick={onReload}>
            {RECONCILE}
          </button>
        </Problem>
      );
    case 'terminal':
      return (
        <Problem title={phase.reason === 'gone' ? 'Monat nicht mehr verfügbar' : 'Aktion nicht erlaubt'} alertRef={alertRef}>
          <p>
            {phase.reason === 'gone'
              ? 'Der Monatsplan oder die Person ist nicht mehr verfügbar. Es wurde nichts gespeichert.'
              : 'Sie dürfen diesen Monat nicht speichern. Es wurde nichts gespeichert. Laden Sie die Seite neu.'}
          </p>
        </Problem>
      );
    default:
      return null;
  }
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

/** Text of existing work kept on a date the calendar does not open, or null. */
function keptText(draft: EmployeeMonthDraft, date: DateOnly, calendar: ProjectCalendar): string | null {
  if (!keptOnBlockedDay(draft, date, calendar)) return null;
  const blocked = calendarBlock(calendar, date);
  return blocked === null ? null : KEPT_ON_BLOCKED_DAY_TEXT[blocked];
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
                const kept = keptText(draft, date, context.calendar);
                const closed = isClosed(context.calendar, date);
                const restriction = mode === null ? null : paintRestriction(context, draft, date, mode);
                const unavailable = SLOT_KINDS.some((kind) => slots[kind].unavailable);
                const lead = after !== null && after !== 'BOTH'
                  ? after.role === 'SHIFT_LEAD'
                  : after === 'BOTH' && SLOT_KINDS.some((kind) => slots[kind].role === 'SHIFT_LEAD');
                const name = `${spokenDate(date)}: ${after === 'BOTH' ? 'Tagdienst und Nachtdienst, Korrektur nötig' : dayText(after)}`;
                const description = [
                  status !== 'unchanged' ? `Geändert, bisher ${dayText(before)}, noch nicht gespeichert` : null,
                  withoutDuty(slots, after) ? NEW_DUTY_TEXT : null,
                  unavailable ? 'Hinweis: nicht verfügbar' : null,
                  closed ? 'Projekt an diesem Tag nicht in Betrieb' : null,
                  kept,
                  fix ? `Korrektur nötig: ${CORRECTION_TEXT[fix]}` : null,
                  restriction && mode ? `${PAINT_MODE_LABELS[mode]} nicht möglich: ${RESTRICTION_TEXT[restriction]}` : null,
                  conflict ? conflictText(conflict, before) : null,
                  ...found.map((issue) => `Nicht gespeichert: ${SHIFT_TYPE_LABELS[issue.kind]}: ${DAY_ISSUE_TEXT[issue.reason]}`),
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
  othersOf: (slot: SlotBase) => readonly OtherMember[] | null;
  onRole: (date: DateOnly, role: DutyRole) => void;
  onSet: (date: DateOnly, plan: DayPlan) => void;
  onRevert: (date: DateOnly) => void;
  onResolve: (date: DateOnly, keep: boolean) => void;
};

const byName = new Intl.Collator('de-DE', { sensitivity: 'base' });

/** Other members of one slot, context only: they are never part of a change. */
function othersText(kind: SlotBase['kind'], slot: SlotBase, others: readonly OtherMember[] | null, nameOf: (employeeId: string) => string): string {
  const label = SHIFT_TYPE_LABELS[kind];
  if (slot.dutyId === null) return `Noch kein ${label} angelegt.`;
  if (others === null) return `${label}: weitere eingeplante Personen bleiben unverändert.`;
  if (others.length === 0) return `${label}: keine weiteren Personen eingeplant.`;
  const names = [...others]
    .sort((a, b) => byName.compare(nameOf(a.employeeId), nameOf(b.employeeId)))
    .map((other) => `${nameOf(other.employeeId)}${other.dutyRole === 'SHIFT_LEAD' ? ` (${DUTY_ROLE_LABELS.SHIFT_LEAD})` : ''}`);
  return `${label}, weitere Personen (bleiben unverändert): ${names.join(', ')}`;
}

/**
 * The active date: wanted state, role, correction of stored data with both
 * shifts, other members of both duties (unchanged), conflicts and findings.
 */
function DayDetails({ date, draft, context, issues, locked, plannerId, nameOf, othersOf, onRole, onSet, onRevert, onResolve }: DayDetailsProps) {
  const slots = daySlots(draft.base, date);
  const before = storedDay(draft.base, date);
  const after = wanted(draft, date);
  const status = dayStatus(before, after);
  const conflict = draft.conflicts.get(date) ?? null;
  const fix = correctionOf(draft, date, context.calendar);
  const kept = keptText(draft, date, context.calendar);
  return (
    <section className="month-planner__day" aria-labelledby={`${plannerId}-day`}>
      <h4 id={`${plannerId}-day`}>Ausgewählter Tag: {spokenDate(date)}</h4>
      <p><strong>Geplant:</strong> {dayStateText(slots, before, after)}</p>
      {isClosed(context.calendar, date) && <p className="planning-day__hint">Das Projekt ist an diesem Tag nicht in Betrieb.</p>}
      {kept && <p className="planning-day__hint">{kept}</p>}
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
      {SLOT_KINDS.map((kind) => (
        <p key={kind} className="month-planner__others">{othersText(kind, slots[kind], othersOf(slots[kind]), nameOf)}</p>
      ))}
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
        <p key={`${issue.kind}|${issue.reason}`} className="planning-day__hint">
          <StatusBadge tone="attention">Nicht gespeichert</StatusBadge>{' '}
          {SHIFT_TYPE_LABELS[issue.kind]}: {DAY_ISSUE_TEXT[issue.reason]}
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
