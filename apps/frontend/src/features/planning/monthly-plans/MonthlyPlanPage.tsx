import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useLocation, type BlockerFunction } from 'react-router';
import { PageFrame } from '../../../app/PageFrame';
import { APP_ROUTES } from '../../../app/routes';
import { isSessionRedirectNavigation } from '../../../app/session-redirect';
import { ApiError } from '../../../shared/api/api-error';
import type { ReadSource } from '../../../shared/data/data-source';
import { MAX_PAGE_SIZE, loadAllPages } from '../../../shared/data/load-all-pages';
import { useReadSource } from '../../../shared/data/use-read-source';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { formatDate, formatMonthLabel, type MonthKey } from '../../../shared/time/month';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { fullName, type Employee } from '../../employees/employee-types';
import type { EmployeesApi } from '../../employees/employees-api';
import type { EditState } from '../../projects/edit-state';
import type { ProjectAssignmentsApi } from '../../projects/project-assignments-api';
import { PROJECT_STATUS, type Project } from '../../projects/project-types';
import type { ProjectsApi } from '../../projects/projects-api';
import type { ShiftConfigurationApi } from '../../projects/shift-configuration-api';
import { DutyCreateForm } from './DutyCreateForm';
import { dutyTimeView, formatInstant } from './duty-time';
import { DUTY_ROLE_LABELS, PLAN_CREATED_STATE, PLAN_STATUS, type Duty, type MonthlyPlan } from './monthly-plan-types';
import { sortDuties, type MonthlyPlansApi } from './monthly-plans-api';

export type PlanPageApis = {
  plans: MonthlyPlansApi;
  projects: ProjectsApi;
  employees: EmployeesApi;
  assignments: ProjectAssignmentsApi;
  shiftConfigurations: ShiftConfigurationApi;
};

const PROJECTS_PATH = APP_ROUTES.find((route) => route.id === 'projects')!.path;

/** Plan header data: the plan, its project and every employee of the company (for member names). */
type PlanContext = { plan: MonthlyPlan; project: Project; employees: Employee[] };

async function loadContext(apis: PlanPageApis, planId: string, signal: AbortSignal): Promise<PlanContext> {
  const plan = await apis.plans.get(planId, signal);
  const [project, employees] = await Promise.all([
    apis.projects.get(plan.projectId, signal),
    // All statuses: a stored member may have been deactivated since.
    loadAllPages((page) => apis.employees.list({ page, pageSize: MAX_PAGE_SIZE }, signal)),
  ]);
  // The plan's own project, or the answers are inconsistent (a contract defect).
  if (project.id.toLowerCase() !== plan.projectId.toLowerCase()) throw new ApiError('invalid-response', null, null, null);
  return { plan, project, employees };
}

function planMonth(plan: MonthlyPlan): MonthKey {
  return plan.monthStart.slice(0, 7);
}

type PageProps = { planId: string; basePath: string; apis: PlanPageApis; timeZone: string };

/**
 * UX A10 plan page for the create/read slice: plan status, the stored duties
 * with members, resolved times and neutral availability hints, and a form for
 * a new duty. Publish, duty edit and removal do not exist yet (SP-12/SP-13).
 */
export function MonthlyPlanPage({ planId, basePath, apis, timeZone }: PageProps) {
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
  // Duties created here since the last read; the server answer is authoritative and shown as is.
  const [added, setAdded] = useState<Duty[]>([]);
  const [notice, setNotice] = useState<string | null>(() =>
    (location.state as { notice?: unknown } | null)?.notice === PLAN_CREATED_STATE.notice
      ? 'Der Monatsplan wurde erstellt. Er ist unveröffentlicht; legen Sie jetzt die Dienste an.'
      : null,
  );
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [focusNotice, setFocusNotice] = useState<object | null>(null);
  const [editState, setEditState] = useState<EditState>('clean');

  /**
   * The page's only navigation blocker. Any SPA navigation away (links,
   * sidebar, Back/Forward) waits for a decision while the new duty is unsaved
   * or its save is unconfirmed. Only the session boundary's marked redirect
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

  const ready = context.state.status === 'ready' ? context.state.data : null;
  const loadedDuties = duties.state.status === 'ready' ? duties.state.data : null;
  const allDuties = useMemo(() => {
    if (loadedDuties === null) return null;
    const known = new Set(loadedDuties.map((duty) => duty.id.toLowerCase()));
    return sortDuties([...loadedDuties, ...added.filter((duty) => !known.has(duty.id.toLowerCase()))]);
  }, [loadedDuties, added]);

  const month = ready ? planMonth(ready.plan) : null;
  const title = ready && month ? `${ready.project.name} – ${formatMonthLabel(month)}` : 'Monatsplan';

  function reloadDuties() {
    setAdded([]);
    duties.retry();
  }

  function created(duty: Duty) {
    setAdded((current) => [...current, duty]);
    setNotice(`Der ${SHIFT_TYPE_LABELS[duty.shiftKind]} am ${formatDate(duty.dutyDate)} wurde angelegt.`);
    setFocusNotice({});
  }

  return (
    <PageFrame title={title} lead="Monatsplan">
      <div className="employees">
        <Link className="employees__back" to={month ? `${basePath}?month=${month}` : basePath}>Zurück zur Übersicht</Link>
        {blocker.state === 'blocked' && (
          <UnsavedDutyPrompt editState={editState} onLeave={() => blocker.proceed()} onStay={() => blocker.reset()} />
        )}
        {/* Always mounted, so screen readers announce new messages. */}
        <div role="status" aria-live="polite">
          {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
        </div>
        {ready && month ? (
          <>
            <PlanStatusSection plan={ready.plan} project={ready.project} month={month} timeZone={timeZone} />
            <DutiesSection
              month={month}
              duties={allDuties}
              readState={duties.state}
              onRetry={reloadDuties}
              employees={ready.employees}
              timeZone={timeZone}
            />
            <section className="employees-card" aria-labelledby="planning-add-duty-title">
              <h2 id="planning-add-duty-title">Dienst hinzufügen</h2>
              {ready.project.status === 'ACTIVE' ? (
                <DutyCreateForm
                  plan={ready.plan}
                  project={ready.project}
                  employees={ready.employees}
                  existingDuties={allDuties}
                  apis={apis}
                  onCreated={created}
                  onReloadDuties={reloadDuties}
                  onEditStateChange={setEditState}
                />
              ) : (
                <p>
                  Das Projekt ist inaktiv. Für inaktive Projekte können keine Dienste angelegt werden; die bestehenden
                  Dienste bleiben sichtbar.
                </p>
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

function PlanStatusSection({ plan, project, month, timeZone }: { plan: MonthlyPlan; project: Project; month: MonthKey; timeZone: string }) {
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
        <p>
          Dieser Monatsplan ist noch nicht veröffentlicht; Mitarbeitende sehen ihn nicht. Das Veröffentlichen ist in
          dieser Ausbaustufe noch nicht verfügbar.
        </p>
      ) : (
        <p>
          Veröffentlicht am {plan.publishedAt ? formatInstant(plan.publishedAt, timeZone) : '–'}. Mitarbeitende sehen
          den aktuellen Stand dieses Plans.
        </p>
      )}
      <Link to={`${PROJECTS_PATH}/${encodeURIComponent(project.id)}/${month}`}>
        Schichtzeiten und Mitarbeiterzuordnung von {project.name} im {formatMonthLabel(month)}
      </Link>
    </section>
  );
}

type DutiesSectionProps = {
  month: MonthKey;
  duties: Duty[] | null;
  readState: { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready' };
  onRetry: () => void;
  employees: Employee[];
  timeZone: string;
};

function DutiesSection({ month, duties, readState, onRetry, employees, timeZone }: DutiesSectionProps) {
  const captionId = useId();
  const names = useMemo(() => new Map(employees.map((employee) => [employee.id.toLowerCase(), fullName(employee)])), [employees]);
  const nameOf = (employeeId: string) => names.get(employeeId.toLowerCase()) ?? 'Unbekannte Person';
  const monthLabel = formatMonthLabel(month);
  return (
    <section className="employees-card" aria-labelledby="planning-duties-title">
      <h2 id="planning-duties-title">Dienste</h2>
      {readState.status === 'loading' || (readState.status === 'ready' && duties === null) ? (
        <LoadingState label="Dienste werden geladen …" />
      ) : readState.status === 'error' ? (
        <ErrorState error={readState.error} onRetry={onRetry} />
      ) : duties === null || duties.length === 0 ? (
        <EmptyState title="Noch keine Dienste" description={`Für ${monthLabel} sind in diesem Plan noch keine Dienste angelegt.`} />
      ) : (
        <>
          <ConflictSummary duties={duties} nameOf={nameOf} />
          <p className="employees__count">{duties.length === 1 ? '1 Dienst' : `${duties.length} Dienste`}</p>
          <div className="employees-table__wrap">
            <table className="employees-table planning-duties" aria-labelledby={captionId}>
              <caption id={captionId}>Dienste im {monthLabel}</caption>
              <thead>
                <tr>
                  <th scope="col">Datum</th>
                  <th scope="col">Dienst</th>
                  <th scope="col">Dienstzeit</th>
                  <th scope="col">Besetzung</th>
                </tr>
              </thead>
              <tbody>
                {duties.map((duty) => (
                  <DutyRow key={duty.id} duty={duty} nameOf={nameOf} timeZone={timeZone} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="employees-card__hint">
            Dienstzeiten werden in der Zeitzone dieses Geräts angezeigt ({timeZone}); die Zeitzonen-Abkürzung steht
            jeweils dabei.
          </p>
        </>
      )}
    </section>
  );
}

function DutyRow({ duty, nameOf, timeZone }: { duty: Duty; nameOf: (employeeId: string) => string; timeZone: string }) {
  const unavailable = new Set(duty.availabilityConflicts.map((conflict) => conflict.assignmentId.toLowerCase()));
  const time = dutyTimeView(duty, timeZone);
  return (
    <tr>
      <th scope="row">{formatDate(duty.dutyDate)}</th>
      <td data-label="Dienst">{SHIFT_TYPE_LABELS[duty.shiftKind]}</td>
      <td data-label="Dienstzeit">{time.text}</td>
      <td data-label="Besetzung">
        {duty.assignments.length === 0 ? (
          'Noch keine Besetzung'
        ) : (
          <ul className="planning-members">
            {duty.assignments.map((member) => (
              <li key={member.id}>
                {nameOf(member.employeeId)}
                {member.dutyRole === 'SHIFT_LEAD' && <span className="planning-members__role"> · {DUTY_ROLE_LABELS.SHIFT_LEAD}</span>}
                {member.source === 'REPLACEMENT' && <span className="planning-members__role"> · Ersatz</span>}
                {unavailable.has(member.id.toLowerCase()) && (
                  <> <StatusBadge tone="attention">Nicht verfügbar</StatusBadge></>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

/**
 * E-04 neutral summary of members who are unavailable on their duty date.
 * It never says why, and an absence never changes a stored duty.
 */
function ConflictSummary({ duties, nameOf }: { duties: Duty[]; nameOf: (employeeId: string) => string }) {
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

type PromptProps = { editState: EditState; onLeave: () => void; onStay: () => void };

/**
 * Inline confirmation (no browser dialog) for a navigation held back by the
 * blocker. Exactly one decision per held navigation: proceed() or reset().
 */
function UnsavedDutyPrompt({ editState, onLeave, onStay }: PromptProps) {
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

  const copy = editState === 'saving'
    ? {
        title: 'Speichern läuft noch',
        text: 'Der neue Dienst wird gerade gespeichert. Ein Wechsel bricht das Speichern nicht ab: Der Dienst kann trotzdem angelegt werden oder fehlschlagen, Sie sehen das Ergebnis aber nicht. Prüfen Sie die Dienste danach.',
        leave: 'Trotzdem wechseln',
        stay: 'Hier bleiben',
      }
    : editState === 'dirty'
      ? {
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
    // Guards against double clicks in the same tick: one navigation at most.
    if (decided.current) return;
    decided.current = true;
    setDeciding(true);
    const target = returnFocus.current;
    if (target?.isConnected && (stay || !target.closest('form'))) target.focus();
    else if (stay) document.querySelector<HTMLElement>('.planning-duty-form input')?.focus();
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
