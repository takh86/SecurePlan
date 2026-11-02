import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { formatDate, formatMonthLabel, type DateOnly, type MonthKey } from '../../../shared/time/month';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import '../../../shared/ui/PreviewNotice.css';
import { EMPLOYEE_STATUS, SHIFT_ELIGIBILITY_LABELS } from '../../employees/employee-types';
import type { EditState } from '../../projects/edit-state';
import type { Project } from '../../projects/project-types';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import {
  DAY_ISSUE_TEXT,
  RESTRICTION_TEXT,
  SLOT_KINDS,
  changeRestriction,
  changeText,
  conflictText,
  desired,
  emptyDraft,
  issuesAfterEdit,
  keepChoice,
  monthBase,
  monthCommand,
  pendingChanges,
  rebase,
  revertSlot,
  setChoice,
  slotKey,
  slotOf,
  slotStateText,
  statusOf,
  toggledChoice,
  type Choice,
  type DayIssue,
  type EmployeeMonthDraft,
  type EmployeeMonthSave,
  type EmployeeMonthSaveOutcome,
  type PlannerContext,
  type RebaseReport,
  type SlotKey,
} from './employee-month-draft';
import { DUTY_ROLE_LABELS, DUTY_ROLES, type Duty, type DutyRole, type MonthlyPlan } from './monthly-plan-types';
import { dayHeader, spokenDate, type MatrixRow } from './planning-matrix';

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
  /** Findings of the last rejected save, by day (until the slot is edited). */
  issues: readonly DayIssue[];
  /** True while the last save was rejected and nothing was saved. */
  rejected: boolean;
  /** Polite status line after a re-read or save. */
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
  /** Re-reads the plan's duties (the draft is moved onto the new state). */
  onReload: () => void;
  reloading: boolean;
  onEditStateChange: (state: EditState) => void;
};

const SHORT: Record<ShiftKind, string> = { DAY: 'Tag', NIGHT: 'Nacht' };
const MARK: Record<'added' | 'removed' | 'role-changed', string> = { added: '+', removed: '−', 'role-changed': '~' };

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
      ? 'Ein weiterer Dienst dieser Person wurde inzwischen geändert.'
      : `${elsewhere} weitere Dienste dieser Person wurden inzwischen geändert.`);
  }
  parts.push(remaining === 0 ? 'Es gibt keine ungespeicherten Änderungen.' : `${plural(remaining, 'Änderung ist', 'Änderungen sind')} noch nicht gespeichert.`);
  return parts.join(' ');
}

/**
 * Issue #88 employee-month planning: every day of the plan month for ONE
 * person, DAY and NIGHT per day, with Mitarbeitende/Schichtleitung. The admin
 * collects all changes in a local draft, reviews them and saves once. Other
 * members of a duty are shown and never changed. Without `save` this is a
 * preview: "Monat speichern" stays unavailable and nothing is written.
 */
export function EmployeeMonthPlanner({
  plan, project, month, person, duties, nameOf, save, newDuties = true, onReload, reloading, onEditStateChange,
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
  };
  const changes = useMemo(() => pendingChanges(draft), [draft]);
  const [active, setActive] = useState({ row: 0, col: 0 });
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
  const activeDate = days[Math.min(active.row, days.length - 1)];
  const locked = phase.kind === 'saving';

  function edit(key: SlotKey, choice: Choice) {
    if (locked) return;
    const slot = slotOf(draft, key);
    if (changeRestriction(context, slot, choice) !== null) return;
    setState((current) => ({
      ...current,
      draft: setChoice(current.draft, key, choice),
      issues: issuesAfterEdit(current.issues, slot.date, slot.kind),
      message: null,
    }));
  }

  function resolve(key: SlotKey, keep: boolean) {
    if (locked) return;
    setState((current) => ({ ...current, draft: keep ? keepChoice(current.draft, key) : revertSlot(current.draft, key), message: null }));
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

  function focusCell(row: number, col: number) {
    setActive({ row, col });
    grid.current?.querySelector<HTMLButtonElement>(`button[data-row="${row}"][data-col="${col}"]`)?.focus();
  }

  function focusSlot(date: DateOnly, kind: ShiftKind) {
    const row = days.indexOf(date);
    if (row >= 0) focusCell(row, SLOT_KINDS.indexOf(kind));
  }

  async function onSave() {
    if (!save || phase.kind !== 'editing') return;
    const command = monthCommand(draft, plan.id);
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
                  <button type="button" className="month-planner__link" onClick={() => focusSlot(issue.date, issue.kind ?? 'DAY')}>
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
        <div className="month-planner__grid">
          <MonthGrid
            caption={`Dienste von ${person.name} im ${formatMonthLabel(month)}`}
            draft={draft}
            context={context}
            issues={issues}
            active={active}
            locked={locked}
            gridRef={grid}
            onActive={setActive}
            onFocusCell={focusCell}
            onToggle={(key) => edit(key, toggledChoice(draft, key))}
          />
          <p className="employees-card__hint">
            Tag = Tagdienst, Nacht = Nachtdienst, SL = Schichtleitung, – = nicht eingeplant. Markierungen ungespeicherter
            Änderungen: + neu, − ausgetragen, ~ Funktion geändert; ! = Hinweis. Leertaste oder Eingabe schaltet einen
            Dienst um; Pfeiltasten, Bild auf/ab (Woche) und Strg+Pos1/Ende bewegen im Raster. „Nicht eingeplant“ ist
            keine Abwesenheit.
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
            onRole={(key, role) => edit(key, role)}
            onRevert={(key) => edit(key, slotOf(draft, key).role)}
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
                    <li key={change.key} className={change.conflict ? 'month-planner__change--conflict' : undefined}>
                      <button type="button" className="month-planner__link" onClick={() => focusSlot(change.slot.date, change.slot.kind)}>
                        {formatDate(change.slot.date)}
                      </button>
                      {' · '}{changeText(change)}
                      {change.conflict && (
                        <> <StatusBadge tone="attention">Prüfen</StatusBadge> {conflictText(change.conflict, change.slot)}</>
                      )}
                      {' '}
                      <button
                        type="button"
                        className="employees-button month-planner__small"
                        disabled={locked}
                        aria-label={`Zurücksetzen: ${formatDate(change.slot.date)}, ${SHIFT_TYPE_LABELS[change.slot.kind]}`}
                        onClick={() => edit(change.key, change.slot.role)}
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
          {draft.conflicts.size > 0 && ` · ${plural(draft.conflicts.size, 'Dienst', 'Dienste')} prüfen`}
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
  if (!context.projectActive) notes.push('Das Projekt ist inaktiv: Sie können die Person nur austragen.');
  if (employee === null) notes.push('Diese Person ist nicht mehr unter den Mitarbeitenden: Sie können sie nur austragen.');
  else if (!person.assigned) notes.push(`Im ${formatMonthLabel(month)} nicht diesem Projekt zugeordnet: Sie können die Person nur austragen.`);
  else if (employee.status !== 'ACTIVE') notes.push('Die Person ist deaktiviert: Sie können sie nur austragen.');
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

type GridProps = {
  caption: string;
  draft: EmployeeMonthDraft;
  context: PlannerContext;
  issues: readonly DayIssue[];
  active: { row: number; col: number };
  locked: boolean;
  gridRef: RefObject<HTMLTableElement | null>;
  onActive: (position: { row: number; col: number }) => void;
  onFocusCell: (row: number, col: number) => void;
  onToggle: (key: SlotKey) => void;
};

function slotIssues(issues: readonly DayIssue[], date: DateOnly, kind: ShiftKind): DayIssue[] {
  return issues.filter((issue) => issue.date === date && (issue.kind === null || issue.kind === kind));
}

/**
 * The month as an ARIA grid: one row per day, one toggle per DAY/NIGHT slot.
 * Roving tabindex (one tab stop); arrows, Page Up/Down (one week), Home/End and
 * Ctrl+Home/End move; Space/Enter toggle. A cell's name is slot and date; its
 * description carries the state, unsaved change, restriction and findings.
 */
function MonthGrid({ caption, draft, context, issues, active, locked, gridRef, onActive, onFocusCell, onToggle }: GridProps) {
  const captionId = useId();
  const describe = useId();
  const days = draft.base.days;
  const position = { row: Math.min(active.row, days.length - 1), col: Math.min(active.col, SLOT_KINDS.length - 1) };

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const target = event.target as HTMLElement;
    if (target.dataset.row === undefined) return;
    const row = Number(target.dataset.row);
    const col = Number(target.dataset.col);
    const last = days.length - 1;
    let next: { row: number; col: number } | null = null;
    switch (event.key) {
      case 'ArrowDown': next = { row: Math.min(last, row + 1), col }; break;
      case 'ArrowUp': next = { row: Math.max(0, row - 1), col }; break;
      case 'ArrowRight': next = { row, col: Math.min(SLOT_KINDS.length - 1, col + 1) }; break;
      case 'ArrowLeft': next = { row, col: Math.max(0, col - 1) }; break;
      case 'PageDown': next = { row: Math.min(last, row + 7), col }; break;
      case 'PageUp': next = { row: Math.max(0, row - 7), col }; break;
      case 'Home': next = event.ctrlKey ? { row: 0, col: 0 } : { row, col: 0 }; break;
      case 'End': next = event.ctrlKey ? { row: last, col: SLOT_KINDS.length - 1 } : { row, col: SLOT_KINDS.length - 1 }; break;
      default: return;
    }
    event.preventDefault();
    onFocusCell(next.row, next.col);
  }

  return (
    <>
      <p className="planning-matrix__title" aria-hidden="true">{caption}</p>
      <div className="month-grid__wrap">
        <table
          ref={gridRef}
          className="month-grid"
          role="grid"
          aria-labelledby={captionId}
          aria-rowcount={days.length + 1}
          aria-colcount={4}
          onKeyDown={onKeyDown}
        >
          <caption id={captionId} className="planning-matrix__sr">{caption}</caption>
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col">Datum</th>
              <th scope="col">Tagdienst</th>
              <th scope="col">Nachtdienst</th>
              <th scope="col">Hinweise</th>
            </tr>
          </thead>
          <tbody>
            {days.map((date, row) => {
              const header = dayHeader(date);
              const notes: string[] = [];
              return (
                <tr key={date} aria-rowindex={row + 2} className={header.weekend ? 'month-grid__weekend' : undefined}>
                  <th scope="row">
                    <span aria-hidden="true">{header.weekday} {header.day}.</span>
                    <span className="planning-matrix__sr">{spokenDate(date)}</span>
                  </th>
                  {SLOT_KINDS.map((kind, col) => {
                    const key = slotKey(date, kind);
                    const slot = slotOf(draft, key);
                    const after = desired(draft, key);
                    const status = statusOf(slot.role, after);
                    const conflict = draft.conflicts.get(key) ?? null;
                    const found = slotIssues(issues, date, kind);
                    const restriction = changeRestriction(context, slot, toggledChoice(draft, key));
                    const description = [
                      slotStateText(slot, after),
                      restriction ? `${after === null ? 'Einplanen' : 'Ändern'} nicht möglich: ${RESTRICTION_TEXT[restriction]}` : null,
                      conflict ? conflictText(conflict, slot) : null,
                      ...found.map((issue) => `Nicht gespeichert: ${DAY_ISSUE_TEXT[issue.reason]}`),
                    ].filter(Boolean).join('. ');
                    if (conflict) notes.push(`${SHORT[kind]}: inzwischen geändert`);
                    for (const issue of found) notes.push(`${SHORT[kind]}: ${DAY_ISSUE_TEXT[issue.reason]}`);
                    if (slot.unavailable) notes.push(`${SHORT[kind]}: ! nicht verfügbar`);
                    if (after !== null && slot.dutyId === null) notes.push(`${SHORT[kind]}: Dienst noch nicht angelegt`);
                    const isActive = position.row === row && position.col === col;
                    const classes = [
                      'month-grid__cell',
                      after !== null ? 'month-grid__cell--planned' : '',
                      status !== 'unchanged' ? `month-grid__cell--${status}` : '',
                      restriction && after === null ? 'month-grid__cell--restricted' : '',
                      conflict || found.length > 0 ? 'month-grid__cell--problem' : '',
                    ].filter(Boolean).join(' ');
                    return (
                      <td key={kind}>
                        <button
                          type="button"
                          className={classes}
                          data-row={row}
                          data-col={col}
                          tabIndex={isActive ? 0 : -1}
                          aria-pressed={after !== null}
                          aria-disabled={restriction !== null || locked ? true : undefined}
                          aria-label={`${SHIFT_TYPE_LABELS[kind]} am ${spokenDate(date)}`}
                          aria-describedby={`${describe}-${row}-${col}`}
                          onFocus={() => onActive({ row, col })}
                          onClick={() => onToggle(key)}
                        >
                          {after === null
                            ? status === 'removed' ? <s>{SHORT[kind]}</s> : '–'
                            : SHORT[kind]}
                          {after === 'SHIFT_LEAD' && <span className="planning-matrix__mark">SL</span>}
                          {status !== 'unchanged' && <span className="month-grid__mark" aria-hidden="true">{MARK[status]}</span>}
                          {slot.unavailable && <span className="planning-matrix__mark planning-matrix__mark--hint" aria-hidden="true">!</span>}
                        </button>
                        <span id={`${describe}-${row}-${col}`} className="planning-matrix__sr">{description}</span>
                      </td>
                    );
                  })}
                  <td className="month-grid__notes">{notes.join(' · ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  onRole: (key: SlotKey, role: DutyRole) => void;
  onRevert: (key: SlotKey) => void;
  onResolve: (key: SlotKey, keep: boolean) => void;
};

const byName = new Intl.Collator('de-DE', { sensitivity: 'base' });

/** The active day: both slots with role choice, other members (unchanged), conflicts and findings. */
function DayDetails({ date, draft, context, issues, locked, plannerId, nameOf, onRole, onRevert, onResolve }: DayDetailsProps) {
  return (
    <section className="month-planner__day" aria-labelledby={`${plannerId}-day`}>
      <h4 id={`${plannerId}-day`}>Ausgewählter Tag: {spokenDate(date)}</h4>
      {SLOT_KINDS.map((kind) => {
        const key = slotKey(date, kind);
        const slot = slotOf(draft, key);
        const after = desired(draft, key);
        const status = statusOf(slot.role, after);
        const conflict = draft.conflicts.get(key) ?? null;
        const others = [...slot.others].sort((a, b) => byName.compare(nameOf(a.employeeId), nameOf(b.employeeId)));
        return (
          <div key={kind} className="planning-day__slot">
            <p><strong>{SHIFT_TYPE_LABELS[kind]}</strong>: {slotStateText(slot, after)}</p>
            <p className="month-planner__others">
              {slot.dutyId === null
                ? `Noch kein ${SHIFT_TYPE_LABELS[kind]} angelegt.`
                : others.length === 0
                  ? 'Keine weiteren Personen eingeplant.'
                  : `Weitere Personen (bleiben unverändert): ${others
                    .map((other) => `${nameOf(other.employeeId)}${other.dutyRole === 'SHIFT_LEAD' ? ` (${DUTY_ROLE_LABELS.SHIFT_LEAD})` : ''}`)
                    .join(', ')}`}
            </p>
            {after !== null && (
              <fieldset className="month-planner__roles">
                <legend>Funktion im {SHIFT_TYPE_LABELS[kind]}</legend>
                {DUTY_ROLES.map((role) => {
                  const restricted = changeRestriction(context, slot, role);
                  return (
                    <label key={role}>
                      <input
                        type="radio"
                        name={`${plannerId}-${key}-role`}
                        checked={after === role}
                        disabled={locked || (restricted !== null && after !== role)}
                        onChange={() => onRole(key, role)}
                      />
                      {DUTY_ROLE_LABELS[role]}
                    </label>
                  );
                })}
              </fieldset>
            )}
            {conflict && (
              <div className="planning-editor__problem">
                <p>{conflictText(conflict, slot)}</p>
                <div className="employee-form__actions">
                  <button type="button" className="employees-button" disabled={locked} onClick={() => onResolve(key, true)}>Meine Auswahl behalten</button>
                  <button type="button" className="employees-button" disabled={locked} onClick={() => onResolve(key, false)}>Aktuellen Stand übernehmen</button>
                </div>
              </div>
            )}
            {slotIssues(issues, date, kind).map((issue) => (
              <p key={issue.reason} className="planning-day__hint">
                <StatusBadge tone="attention">Nicht gespeichert</StatusBadge> {DAY_ISSUE_TEXT[issue.reason]}
              </p>
            ))}
            {status !== 'unchanged' && !conflict && (
              <button type="button" className="employees-button month-planner__small" disabled={locked} onClick={() => onRevert(key)}>
                {SHIFT_TYPE_LABELS[kind]} zurücksetzen
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
