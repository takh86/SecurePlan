import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useBlocker, useLocation, type BlockerFunction } from 'react-router';
import { PageFrame } from '../../../app/PageFrame';
import { APP_ROUTES } from '../../../app/routes';
import { isSessionRedirectNavigation } from '../../../app/session-redirect';
import { ApiError } from '../../../shared/api/api-error';
import type { ReadSource } from '../../../shared/data/data-source';
import { MAX_PAGE_SIZE, loadAllPages } from '../../../shared/data/load-all-pages';
import { useReadSource } from '../../../shared/data/use-read-source';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { formatDate, formatMonthLabel, type DateOnly, type MonthKey } from '../../../shared/time/month';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { fullName, type Employee } from '../../employees/employee-types';
import type { EmployeesApi } from '../../employees/employees-api';
import type { EditState } from '../../projects/edit-state';
import type { ProjectAssignment, ProjectAssignmentsApi } from '../../projects/project-assignments-api';
import { PROJECT_STATUS, type Project } from '../../projects/project-types';
import type { ProjectsApi } from '../../projects/projects-api';
import type { ShiftConfigurationApi, ShiftKind } from '../../projects/shift-configuration-api';
import { DutyCreateForm } from './DutyCreateForm';
import { DutyEditor } from './DutyEditor';
import { formatInstant } from './duty-time';
import { NO_EMPLOYEE_PLAN_VIEW, PLAN_CREATED_STATE, PLAN_STATUS, type Duty, type MonthlyPlan } from './monthly-plan-types';
import { sortDuties, type MonthlyPlansApi } from './monthly-plans-api';
import { PlanningDayDetails } from './PlanningDayDetails';
import { PlanningMatrix, type MatrixSelection } from './PlanningMatrix';
import { UNKNOWN_PERSON, buildMatrixRows, dutiesOn, filterRows, matrixDays } from './planning-matrix';

export type PlanPageApis = {
  plans: MonthlyPlansApi;
  projects: ProjectsApi;
  employees: EmployeesApi;
  assignments: ProjectAssignmentsApi;
  shiftConfigurations: ShiftConfigurationApi;
};

/**
 * SP-13 integration point: the plan's publish action (First Publish dialog,
 * see `InitialPublish`). Rendered in the plan status section.
 */
export type PublishSlotProps = {
  plan: MonthlyPlan;
  project: Project;
  /** The duties on screen (last read plus answers of own writes); null while no current read is available. */
  duties: readonly Duty[] | null;
  /** True while the focus panel holds unsaved input or a write is in flight. */
  hasUnsavedChanges: boolean;
  /** Call with the server's answer after a successful publication; the page shows the new status. */
  onPlanChanged: (plan: MonthlyPlan) => void;
  /** Re-reads plan, project and duties; the current view stays on screen until the new reads replace it. */
  onReload: () => void;
};
export type PublishSlot = (props: PublishSlotProps) => ReactNode;

const PROJECTS_PATH = APP_ROUTES.find((route) => route.id === 'projects')!.path;

/** Plan header data: the plan, its project, every employee (member names) and the month's assignments (matrix rows). */
type PlanContext = { plan: MonthlyPlan; project: Project; employees: Employee[]; assignments: ProjectAssignment[] };

async function loadContext(apis: PlanPageApis, planId: string, signal: AbortSignal): Promise<PlanContext> {
  const plan = await apis.plans.get(planId, signal);
  const [project, employees, assignments] = await Promise.all([
    apis.projects.get(plan.projectId, signal),
    // All statuses: a stored member may have been deactivated since.
    loadAllPages((page) => apis.employees.list({ page, pageSize: MAX_PAGE_SIZE }, signal)),
    apis.assignments.listMonth(planMonth(plan), signal),
  ]);
  // The plan's own project, or the answers are inconsistent (a contract defect).
  if (project.id.toLowerCase() !== plan.projectId.toLowerCase()) throw new ApiError('invalid-response', null, null, null);
  return { plan, project, employees, assignments };
}

function planMonth(plan: MonthlyPlan): MonthKey {
  return plan.monthStart.slice(0, 7);
}

/**
 * The newer of two states of the same plan. CR-03: the status only ever moves
 * UNPUBLISHED -> PUBLISHED (no unpublish, no re-publish), so a PUBLISHED state
 * is never replaced by an older UNPUBLISHED answer that arrives later.
 */
function newerPlan(update: MonthlyPlan | null, read: MonthlyPlan | null): MonthlyPlan | null {
  if (update === null || read === null) return update ?? read;
  return read.status === 'PUBLISHED' && update.status !== 'PUBLISHED' ? read : update;
}

/** What the focus panel shows (UX A10 "Focus Editor"). */
type PanelState =
  | { mode: 'day'; date: DateOnly; employeeId: string | null }
  | { mode: 'edit'; dutyId: string; employeeId: string | null }
  | { mode: 'create'; date: DateOnly | null; kind: ShiftKind | null; employeeId: string | null };

function dutyLabel(duty: Pick<Duty, 'shiftKind' | 'dutyDate'>): string {
  return `${SHIFT_TYPE_LABELS[duty.shiftKind]} am ${formatDate(duty.dutyDate)}`;
}

const PUBLISHED_EFFECT = 'Der Plan ist veröffentlicht: Die Änderung gilt sofort, ohne erneutes Veröffentlichen.';

type PageProps = { planId: string; basePath: string; apis: PlanPageApis; timeZone: string; publishSlot: PublishSlot };

/**
 * UX A10 plan page: plan status, the employee-by-day matrix of the plan's
 * duties and a focus panel for one cell, one day, one duty (SP-12 editor with
 * edit lease) or a new duty. Each save is one atomic server write; the server
 * re-validates everything. The first publication (SP-13) is the `PublishSlot`
 * in the status section; under CR-03 edits of a PUBLISHED plan apply at once.
 */
export function MonthlyPlanPage({ planId, basePath, apis, timeZone, publishSlot }: PageProps) {
  const location = useLocation();
  const contextSource = useMemo<ReadSource<string, PlanContext>>(
    () => ({ kind: 'api', load: (id, signal) => loadContext(apis, id, signal) }),
    [apis],
  );
  const dutiesSource = useMemo<ReadSource<string, Duty[]>>(
    () => ({ kind: 'api', load: (id, signal) => apis.plans.listDuties(id, signal) }),
    [apis],
  );
  const context = useReadSource(contextSource, planId);
  const duties = useReadSource(dutiesSource, planId);
  /**
   * The last duty read plus the server answers of writes since then, by
   * lower-case duty id (null = removed). A re-read keeps this view (and an open
   * panel with its input) on screen until the new read replaces it.
   */
  const [view, setView] = useState<{ loaded: Duty[]; changes: Record<string, Duty | null> } | null>(null);
  const loaded = duties.state.status === 'ready' ? duties.state.data : null;
  // A new read replaces the view during render (React's "adjust state on change" pattern).
  if (loaded !== null && view?.loaded !== loaded) setView({ loaded, changes: {} });
  /** A newer plan state than the page's read (status after a publication or a fresh read). */
  const [planUpdate, setPlanUpdate] = useState<MonthlyPlan | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    (location.state as { notice?: unknown } | null)?.notice === PLAN_CREATED_STATE.notice
      ? 'Der Monatsplan wurde erstellt. Er ist unveröffentlicht; legen Sie jetzt die Dienste an.'
      : null,
  );
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [focusNotice, setFocusNotice] = useState<object | null>(null);
  const [editState, setEditState] = useState<EditState>('clean');
  const [panel, setPanel] = useState<PanelState | null>(null);
  /** A panel switch held back by unsaved input: the panel asks first. */
  const [pendingPanel, setPendingPanel] = useState<{ next: PanelState | null } | null>(null);
  const [panelFocus, setPanelFocus] = useState<object | null>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const searchId = useId();

  /**
   * The page's only navigation blocker. Any SPA navigation away (links,
   * sidebar, Back/Forward) waits for a decision while panel input is unsaved
   * or a write is unconfirmed. Only the session boundary's marked redirect
   * after sign-out or session loss passes (UX, not an authorization control).
   */
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation, historyAction }) =>
      editState !== 'clean' &&
      !isSessionRedirectNavigation(historyAction, nextLocation) &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [editState],
  );
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (focusNotice) noticeRef.current?.focus();
  }, [focusNotice]);
  useEffect(() => {
    if (panelFocus) panelHeading.current?.focus();
  }, [panelFocus]);

  /**
   * The last plan context read. A re-read (after a publish conflict) keeps it,
   * and with it the matrix and an open panel, on screen until the new read
   * replaces it; only the first read shows the page-wide loading state.
   */
  const contextRead = context.state.status === 'ready' ? context.state.data : null;
  const [shownContext, setShownContext] = useState<PlanContext | null>(null);
  if (contextRead !== null && shownContext !== contextRead) setShownContext(contextRead);
  const ready = contextRead ?? shownContext;
  const plan = newerPlan(planUpdate, ready?.plan ?? null);
  const allDuties = useMemo(() => {
    if (view === null) return null;
    const kept = view.loaded.filter((duty) => !(duty.id.toLowerCase() in view.changes));
    const local = Object.values(view.changes).filter((duty): duty is Duty => duty !== null);
    return sortDuties([...kept, ...local]);
  }, [view]);

  const month = plan ? planMonth(plan) : null;
  const title = ready && month ? `${ready.project.name} – ${formatMonthLabel(month)}` : 'Monatsplan';

  const names = useMemo(
    () => new Map((ready?.employees ?? []).map((employee) => [employee.id.toLowerCase(), fullName(employee)])),
    [ready],
  );
  const nameOf = useCallback((employeeId: string) => names.get(employeeId.toLowerCase()) ?? UNKNOWN_PERSON, [names]);

  const rows = useMemo(
    () => (ready && plan && allDuties ? buildMatrixRows(ready.employees, ready.assignments, allDuties, ready.project.id, plan.monthStart) : []),
    [ready, plan, allDuties],
  );

  /** The panel as currently shown (also read by writes that settle after the admin moved on). */
  const panelRef = useRef<PanelState | null>(null);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  function announce(text: string, focus = true) {
    setNotice(text);
    if (focus) setFocusNotice({});
  }

  /**
   * A write settled. Its panel closes and the notice takes focus, unless the
   * admin has already switched to other content ("Trotzdem wechseln"): then the
   * result is only announced, so nothing they are working on is closed.
   */
  function settle(own: (current: PanelState) => boolean, text: string) {
    const current = panelRef.current;
    const mine = current !== null && own(current);
    if (mine) setPanel(null);
    announce(text, mine);
  }

  /** Records a server answer in the view (null = removed). */
  const record = useCallback((dutyId: string, duty: Duty | null) => {
    setView((current) => current && { ...current, changes: { ...current.changes, [dutyId.toLowerCase()]: duty } });
  }, []);

  /** Re-reads the duties; the new read replaces the view including local answers. */
  function reloadDuties() {
    duties.retry();
  }

  /** Re-reads plan, project, staff and duties (SP-13 conflicts); the current view stays until replaced. */
  function reloadAll() {
    context.retry();
    duties.retry();
  }

  function showPanel(next: PanelState | null) {
    setPendingPanel(null);
    setPanel(next);
    if (next) {
      setPanelFocus({});
    } else if (returnFocus.current?.isConnected) {
      returnFocus.current.focus();
    }
  }

  /** Opens another panel content; unsaved input or a running write is never dropped silently. */
  function requestPanel(next: PanelState | null, trigger?: HTMLElement) {
    if (trigger) returnFocus.current = trigger;
    if (editState !== 'clean') {
      setPendingPanel({ next });
      return;
    }
    showPanel(next);
  }

  const onFresh = useCallback((duty: Duty) => record(duty.id, duty), [record]);
  const onPlanFresh = useCallback((fresh: MonthlyPlan) => setPlanUpdate(fresh), []);

  const isEditorOf = (duty: Duty) => (current: PanelState) =>
    current.mode === 'edit' && current.dutyId.toLowerCase() === duty.id.toLowerCase();

  function created(duty: Duty) {
    record(duty.id, duty);
    settle((current) => current.mode === 'create', `Der ${SHIFT_TYPE_LABELS[duty.shiftKind]} am ${formatDate(duty.dutyDate)} wurde angelegt.`);
  }

  function saved(duty: Duty, verified: boolean) {
    record(duty.id, duty);
    settle(isEditorOf(duty), [
      `Die Änderungen am ${dutyLabel(duty)} wurden gespeichert.`,
      verified ? 'Das hat das erneute Laden des aktuellen Stands bestätigt.' : null,
      plan?.status === 'PUBLISHED' ? PUBLISHED_EFFECT : null,
    ].filter(Boolean).join(' '));
  }

  function removed(duty: Duty, verified: boolean) {
    record(duty.id, null);
    settle(isEditorOf(duty), [
      verified ? `Der ${dutyLabel(duty)} ist nicht mehr vorhanden; das Löschen ist damit abgeschlossen.` : `Der ${dutyLabel(duty)} wurde gelöscht.`,
      plan?.status === 'PUBLISHED' ? 'Der Plan ist veröffentlicht: Die Löschung gilt sofort.' : null,
    ].filter(Boolean).join(' '));
  }

  function gone() {
    setPanel(null);
    reloadDuties();
    announce('Der Dienst ist nicht mehr vorhanden. Die Dienste wurden neu geladen.');
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    // A select handles Escape itself (closing its list).
    if (event.key === 'Escape' && !pendingPanel && !event.defaultPrevented && !(event.target instanceof HTMLSelectElement)) {
      event.stopPropagation();
      requestPanel(null);
    }
  }

  const selection: MatrixSelection | null = panel?.mode === 'day' ? { date: panel.date, employeeId: panel.employeeId } : null;
  const editingDutyId = panel?.mode === 'edit' ? panel.dutyId : null;
  const panelMode = panel?.mode ?? null;

  return (
    <PageFrame title={title} lead="Monatsplan">
      <div className="employees planning-page">
        <Link className="employees__back" to={month ? `${basePath}?month=${month}` : basePath}>Zurück zur Übersicht</Link>
        {blocker.state === 'blocked' && (
          <UnsavedPrompt
            mode={panelMode}
            editState={editState}
            onLeave={() => blocker.proceed()}
            onStay={() => blocker.reset()}
          />
        )}
        {/* Always mounted, so screen readers announce new messages. */}
        <div role="status" aria-live="polite">
          {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
        </div>
        {ready && plan && month ? (
          <>
            {context.state.status === 'loading' && <LoadingState label="Planstatus wird neu geladen …" />}
            {context.state.status === 'error' && <ErrorState error={context.state.error} onRetry={context.retry} />}
            <PlanStatusSection
              plan={plan}
              project={ready.project}
              month={month}
              timeZone={timeZone}
              publishSlot={publishSlot}
              duties={duties.state.status === 'ready' ? allDuties : null}
              hasUnsavedChanges={editState !== 'clean'}
              onPlanChanged={setPlanUpdate}
              onReload={reloadAll}
            />
            <section className="employees-card planning-board" aria-labelledby="planning-duties-title">
              <h2 id="planning-duties-title">Dienste</h2>
              {allDuties === null ? (
                duties.state.status === 'error'
                  ? <ErrorState error={duties.state.error} onRetry={reloadDuties} />
                  : <LoadingState label="Dienste werden geladen …" />
              ) : (
                <>
                  {duties.state.status === 'loading' && <LoadingState label="Dienste werden neu geladen …" />}
                  {duties.state.status === 'error' && <ErrorState error={duties.state.error} onRetry={reloadDuties} />}
                  <div className="planning-toolbar">
                    <div className="employees__search">
                      <label htmlFor={searchId}>Person suchen</label>
                      <input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
                    </div>
                    <label className="planning-toolbar__toggle">
                      <input type="checkbox" checked={onlyConflicts} onChange={(event) => setOnlyConflicts(event.target.checked)} />
                      Nur Personen mit Hinweisen
                    </label>
                    {ready.project.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="employees-button employees-button--primary"
                        onClick={(event) => requestPanel({ mode: 'create', date: null, kind: null, employeeId: null }, event.currentTarget)}
                      >
                        Dienst hinzufügen
                      </button>
                    ) : (
                      <p className="employee-form__hint">
                        Das Projekt ist inaktiv. Für inaktive Projekte können keine Dienste angelegt werden; die
                        bestehenden Dienste bleiben sichtbar.
                      </p>
                    )}
                  </div>
                  {allDuties.length === 0 && (
                    <EmptyState title="Noch keine Dienste" description={`Für ${formatMonthLabel(month)} sind in diesem Plan noch keine Dienste angelegt.`} />
                  )}
                  {!rows.some((row) => row.assigned) && (
                    <p className="employees-card__hint">
                      Diesem Projekt ist im {formatMonthLabel(month)} noch niemand zugeordnet.{' '}
                      <Link to={`${PROJECTS_PATH}/${encodeURIComponent(ready.project.id)}/${month}`}>Mitarbeitende im Projekt zuordnen</Link>
                    </p>
                  )}
                  <ConflictSummary duties={allDuties} nameOf={nameOf} />
                  <PlanningWorkspace
                    month={month}
                    rows={filterRows(rows, query, onlyConflicts)}
                    totalRows={rows.length}
                    duties={allDuties}
                    selection={selection}
                    editingDutyId={editingDutyId}
                    onSelect={(next, trigger) => requestPanel({ mode: 'day', ...next }, trigger)}
                    timeZone={timeZone}
                    panel={panel && (
                      <section className="planning-panel" aria-labelledby="planning-panel-title" onKeyDown={onPanelKeyDown}>
                        <h3 id="planning-panel-title" ref={panelHeading} tabIndex={-1}>
                          {panelTitle(panel, allDuties, rows, nameOf)}
                        </h3>
                        {pendingPanel && (
                          <UnsavedPrompt
                            mode={panel.mode}
                            editState={editState}
                            onLeave={() => showPanel(pendingPanel.next)}
                            onStay={() => setPendingPanel(null)}
                          />
                        )}
                        {panel.mode === 'day' ? (
                          <PlanningDayDetails
                            row={panel.employeeId ? rows.find((row) => row.key === panel.employeeId!.toLowerCase()) ?? null : null}
                            date={panel.date}
                            day={dutiesOn(allDuties, panel.date)}
                            monthLabel={formatMonthLabel(month)}
                            projectActive={ready.project.status === 'ACTIVE'}
                            timeZone={timeZone}
                            nameOf={nameOf}
                            onEdit={(duty) => requestPanel({ mode: 'edit', dutyId: duty.id, employeeId: panel.employeeId })}
                            onCreate={(kind) => requestPanel({ mode: 'create', date: panel.date, kind, employeeId: panel.employeeId })}
                            onClose={() => requestPanel(null)}
                          />
                        ) : panel.mode === 'edit' ? (
                          <EditPanel
                            panel={panel}
                            plan={plan}
                            ready={ready}
                            duties={allDuties}
                            apis={apis}
                            timeZone={timeZone}
                            onFresh={onFresh}
                            onPlanFresh={onPlanFresh}
                            onSaved={saved}
                            onRemoved={removed}
                            onGone={gone}
                            onClose={() => requestPanel(null)}
                            onEditStateChange={setEditState}
                          />
                        ) : (
                          <>
                            <DutyCreateForm
                              key={`${panel.date ?? ''}|${panel.kind ?? ''}|${panel.employeeId ?? ''}`}
                              plan={plan}
                              project={ready.project}
                              employees={ready.employees}
                              assignments={ready.assignments}
                              existingDuties={allDuties}
                              apis={apis}
                              prefill={panel}
                              onCreated={created}
                              onReloadDuties={reloadDuties}
                              onEditStateChange={setEditState}
                            />
                            <div className="employee-form__actions">
                              <button type="button" className="employees-button" onClick={() => requestPanel(null)}>Schließen</button>
                            </div>
                          </>
                        )}
                      </section>
                    )}
                  />
                </>
              )}
            </section>
          </>
        ) : context.state.status === 'error' ? (
          <ErrorState error={context.state.error} onRetry={context.retry} />
        ) : (
          <LoadingState label="Monatsplan wird geladen …" />
        )}
      </div>
    </PageFrame>
  );
}

function panelTitle(panel: PanelState, duties: readonly Duty[], rows: readonly { key: string; name: string }[], nameOf: (id: string) => string): string {
  if (panel.mode === 'create') return 'Dienst hinzufügen';
  if (panel.mode === 'edit') {
    const duty = duties.find((item) => item.id.toLowerCase() === panel.dutyId.toLowerCase());
    return duty ? `${dutyLabel(duty)} bearbeiten` : 'Dienst bearbeiten';
  }
  if (panel.employeeId === null) return `Dienste am ${formatDate(panel.date)}`;
  const row = rows.find((item) => item.key === panel.employeeId!.toLowerCase());
  return `${row?.name ?? nameOf(panel.employeeId)} · ${formatDate(panel.date)}`;
}

type EditPanelProps = {
  panel: Extract<PanelState, { mode: 'edit' }>;
  plan: MonthlyPlan;
  ready: PlanContext;
  duties: readonly Duty[];
  apis: PlanPageApis;
  timeZone: string;
  onFresh: (duty: Duty) => void;
  onPlanFresh: (plan: MonthlyPlan) => void;
  onSaved: (duty: Duty, verified: boolean) => void;
  onRemoved: (duty: Duty, verified: boolean) => void;
  onGone: () => void;
  onClose: () => void;
  onEditStateChange: (state: EditState) => void;
};

function EditPanel({ panel, plan, ready, duties, apis, timeZone, ...handlers }: EditPanelProps) {
  const duty = duties.find((item) => item.id.toLowerCase() === panel.dutyId.toLowerCase());
  if (!duty) {
    return (
      <>
        <p>Dieser Dienst ist in der geladenen Ansicht nicht mehr vorhanden.</p>
        <div className="employee-form__actions">
          <button type="button" className="employees-button" onClick={handlers.onClose}>Schließen</button>
        </div>
      </>
    );
  }
  return (
    <DutyEditor
      // One editor (and one lease) per duty; a newer server state of the same duty keeps it mounted.
      key={duty.id.toLowerCase()}
      plan={plan}
      project={ready.project}
      snapshot={duty}
      focusEmployeeId={panel.employeeId}
      employees={ready.employees}
      assignments={ready.assignments}
      duties={duties}
      apis={apis}
      timeZone={timeZone}
      {...handlers}
    />
  );
}

type WorkspaceProps = {
  month: MonthKey;
  rows: ReturnType<typeof filterRows>;
  totalRows: number;
  duties: readonly Duty[];
  selection: MatrixSelection | null;
  editingDutyId: string | null;
  onSelect: (selection: MatrixSelection, trigger: HTMLElement) => void;
  timeZone: string;
  panel: ReactNode;
};

/** Matrix plus focus panel: side by side on wide screens, stacked below (5.7 §7.3). */
function PlanningWorkspace({ month, rows, totalRows, duties, selection, editingDutyId, onSelect, timeZone, panel }: WorkspaceProps) {
  const days = useMemo(() => matrixDays(month), [month]);
  return (
    <>
      <p className="employees__count">
        {totalRows === 1 ? '1 Person' : `${totalRows} Personen`}
        {rows.length !== totalRows && ` (${rows.length} angezeigt)`} · {duties.length === 1 ? '1 Dienst' : `${duties.length} Dienste`}
      </p>
      {totalRows > 0 && rows.length === 0 && <p className="employees__no-results">Keine Person entspricht der Auswahl.</p>}
      <div className={`planning-workspace${panel ? ' planning-workspace--with-panel' : ''}`}>
        <div className="planning-workspace__matrix">
          <PlanningMatrix
            caption={`Dienste im ${formatMonthLabel(month)} nach Person und Tag`}
            days={days}
            rows={rows}
            duties={duties}
            selected={selection}
            editingDutyId={editingDutyId}
            onSelect={onSelect}
          />
          <p className="employees-card__hint">
            Tag = Tagdienst, Nacht = Nachtdienst, SL = Schichtleitung, ! = Hinweis (nicht verfügbar), – = frei. Ein
            Nachtdienst steht am Tag seines Beginns. Zeile „Dienste am Tag“: T/N mit Anzahl eingeplanter Personen.
            Weitere Tage erreichen Sie durch waagerechtes Scrollen oder mit den Pfeiltasten im Raster.
            Dienstzeiten werden in der Zeitzone dieses Geräts angezeigt ({timeZone}); die Zeitzonen-Abkürzung steht jeweils dabei.
          </p>
        </div>
        {panel}
      </div>
    </>
  );
}

type StatusProps = PublishSlotProps & {
  month: MonthKey;
  timeZone: string;
  publishSlot: PublishSlot;
};

function PlanStatusSection({ month, timeZone, publishSlot, ...slotProps }: StatusProps) {
  const { plan, project } = slotProps;
  const status = PLAN_STATUS[plan.status];
  const projectStatus = PROJECT_STATUS[project.status];
  return (
    <section className="employees-card" aria-labelledby="planning-status-title">
      <h2 id="planning-status-title">Planstatus</h2>
      <dl className="employees-card__facts">
        <div><dt>Projekt</dt><dd>{project.name}</dd></div>
        <div><dt>Monat</dt><dd>{formatMonthLabel(month)}</dd></div>
        <div><dt>Status</dt><dd><StatusBadge tone={status.tone}>{status.label}</StatusBadge></dd></div>
        <div><dt>Projektstatus</dt><dd><StatusBadge tone={projectStatus.tone}>{projectStatus.label}</StatusBadge></dd></div>
      </dl>
      {plan.status === 'UNPUBLISHED' ? (
        <p>Dieser Monatsplan ist noch nicht veröffentlicht.</p>
      ) : (
        <p>
          Veröffentlicht am {plan.publishedAt ? formatInstant(plan.publishedAt, timeZone) : '–'}. Änderungen an
          Diensten gelten sofort, ohne erneutes Veröffentlichen. {NO_EMPLOYEE_PLAN_VIEW}
        </p>
      )}
      {/* SP-13 integration point (First Publish). */}
      <div className="planning-publish">{publishSlot(slotProps)}</div>
      <Link to={`${PROJECTS_PATH}/${encodeURIComponent(project.id)}/${month}`}>
        Schichtzeiten und Mitarbeiterzuordnung von {project.name} im {formatMonthLabel(month)}
      </Link>
    </section>
  );
}

/**
 * E-04 neutral summary of members who are unavailable on their duty date
 * (5.7: conflicts at the cell and in a reachable overview). It never says why,
 * and an absence never changes a stored duty.
 */
function ConflictSummary({ duties, nameOf }: { duties: readonly Duty[]; nameOf: (employeeId: string) => string }) {
  const titleId = useId();
  const items = duties.flatMap((duty) =>
    duty.availabilityConflicts.map((conflict) => ({
      key: conflict.assignmentId,
      text: `${formatDate(duty.dutyDate)}, ${SHIFT_TYPE_LABELS[duty.shiftKind]}: ${nameOf(conflict.employeeId)}`,
    })));
  if (items.length === 0) return null;
  return (
    <div className="planning-conflicts" role="group" aria-labelledby={titleId}>
      <h3 id={titleId}>
        <StatusBadge tone="attention">Hinweis</StatusBadge> Nicht verfügbare Personen
      </h3>
      <p>
        {items.length === 1
          ? 'Eine eingeplante Person ist am Diensttag nicht verfügbar.'
          : `${items.length} Einplanungen betreffen Personen, die am Diensttag nicht verfügbar sind.`}{' '}
        Bestehende Dienste werden dadurch nicht automatisch geändert.
      </p>
      <ul>
        {items.map((item) => <li key={item.key}>{item.text}</li>)}
      </ul>
    </div>
  );
}

type PromptProps = { mode: PanelState['mode'] | null; editState: EditState; onLeave: () => void; onStay: () => void };

/**
 * Inline confirmation (no browser dialog) for a navigation or panel switch
 * held back by unsaved input. Exactly one decision per held action.
 */
function UnsavedPrompt({ mode, editState, onLeave, onStay }: PromptProps) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const decided = useRef(false);
  const [deciding, setDeciding] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Remember the control that triggered the navigation. Idempotent: StrictMode
    // runs this twice, and the second run must not capture the prompt heading.
    const previous = document.activeElement;
    if (
      returnFocus.current === null &&
      previous instanceof HTMLElement &&
      previous !== document.body &&
      !container.current?.contains(previous)
    ) {
      returnFocus.current = previous;
    }
    heading.current?.focus();
  }, []);

  const editing = mode === 'edit';
  const copy = editState === 'saving'
    ? {
        title: 'Speichern läuft noch',
        text: editing
          ? 'Die Änderung wird gerade übertragen. Ein Wechsel bricht sie nicht ab: Sie kann trotzdem wirksam werden oder fehlschlagen, Sie sehen das Ergebnis aber nicht. Prüfen Sie die Dienste danach.'
          : 'Der neue Dienst wird gerade gespeichert. Ein Wechsel bricht das Speichern nicht ab: Der Dienst kann trotzdem angelegt werden oder fehlschlagen, Sie sehen das Ergebnis aber nicht. Prüfen Sie die Dienste danach.',
        leave: 'Trotzdem wechseln',
        stay: 'Hier bleiben',
      }
    : editState === 'dirty'
      ? editing
        ? {
            title: 'Ungespeicherte Änderungen',
            text: 'Die Änderungen an diesem Dienst sind noch nicht gespeichert. Wenn Sie wechseln, werden sie verworfen und die Reservierung des Dienstes wird freigegeben.',
            leave: 'Änderungen verwerfen und wechseln',
            stay: 'Weiter bearbeiten',
          }
        : {
            title: 'Ungespeicherter Dienst',
            text: 'Die Eingaben für den neuen Dienst sind noch nicht gespeichert. Wenn Sie die Ansicht wechseln, werden sie verworfen.',
            leave: 'Eingaben verwerfen und wechseln',
            stay: 'Weiter bearbeiten',
          }
      : {
          title: 'Keine ungespeicherten Eingaben mehr',
          text: 'Es gibt keine ungespeicherten Eingaben mehr. Sie können die Ansicht jetzt wechseln.',
          leave: 'Jetzt wechseln',
          stay: 'Hier bleiben',
        };

  function decide(action: () => void, stay: boolean) {
    // Guards against double clicks in the same tick: one decision at most.
    if (decided.current) return;
    decided.current = true;
    setDeciding(true);
    const target = returnFocus.current;
    if (stay && target?.isConnected) target.focus();
    else if (stay) document.querySelector<HTMLElement>('.planning-panel input, .planning-panel select')?.focus();
    action();
  }

  return (
    <div ref={container} className="employees-card employees-confirm" role="group" aria-labelledby={titleId}>
      <h2 id={titleId} ref={heading} tabIndex={-1}>{copy.title}</h2>
      <p>{copy.text}</p>
      <div className="employee-form__actions">
        <button
          type="button"
          className="employees-button employees-button--danger"
          disabled={deciding}
          onClick={() => decide(onLeave, false)}
        >
          {copy.leave}
        </button>
        <button type="button" className="employees-button" disabled={deciding} onClick={() => decide(onStay, true)}>
          {copy.stay}
        </button>
      </div>
    </div>
  );
}
