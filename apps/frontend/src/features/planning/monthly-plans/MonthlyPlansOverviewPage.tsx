import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { PageFrame } from '../../../app/PageFrame';
import { APP_ROUTES, type AppRoute } from '../../../app/routes';
import { ApiError } from '../../../shared/api/api-error';
import type { ReadSource } from '../../../shared/data/data-source';
import { MAX_PAGE_SIZE, loadAllPages } from '../../../shared/data/load-all-pages';
import { useReadSource } from '../../../shared/data/use-read-source';
import type { Clock } from '../../../shared/time/clock';
import { addMonths, currentMonth, formatMonthLabel, parseMonth, type MonthKey } from '../../../shared/time/month';
import { ApiErrorAlert } from '../../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { PROJECT_STATUS, type Project } from '../../projects/project-types';
import type { ProjectsApi } from '../../projects/projects-api';
import { PLAN_CREATED_STATE, PLAN_STATUS, type MonthlyPlan } from './monthly-plan-types';
import type { MonthlyPlansApi } from './monthly-plans-api';
import { outcomeUnknown, planningErrorText } from './planning-errors';

export type OverviewApis = { plans: MonthlyPlansApi; projects: ProjectsApi };

const PROJECTS_PATH = APP_ROUTES.find((route) => route.id === 'projects')!.path;

type OverviewRow = { key: string; project: Project | null; plan: MonthlyPlan | null };

async function loadOverview(apis: OverviewApis, month: MonthKey, signal: AbortSignal): Promise<OverviewRow[]> {
  const [projects, plans] = await Promise.all([
    loadAllPages((page) => apis.projects.list({ page, pageSize: MAX_PAGE_SIZE }, signal)),
    apis.plans.listMonth(month, signal),
  ]);
  const byProject = new Map(plans.map((plan) => [plan.projectId.toLowerCase(), plan]));
  const rows: OverviewRow[] = projects.map((project) => {
    const plan = byProject.get(project.id.toLowerCase()) ?? null;
    byProject.delete(project.id.toLowerCase());
    return { key: project.id, project, plan };
  });
  // Both reads are separate snapshots: a plan whose project is not (or no longer) listed is still shown.
  for (const plan of byProject.values()) rows.push({ key: plan.id, project: null, plan });
  return rows;
}

/**
 * Month overview (UX A10 entry): every visible project with its plan for the
 * selected month. `?month=YYYY-MM`; absent means the clock's current month.
 */
export function MonthlyPlansOverviewPage({ route, apis, clock }: { route: AppRoute; apis: OverviewApis; clock: Clock }) {
  const [params] = useSearchParams();
  const raw = params.get('month');
  const month = raw === null ? currentMonth(clock) : parseMonth(raw);
  // An invalid month in the URL falls back to the current month.
  if (month === null) return <Navigate to={route.path} replace />;
  return (
    <PageFrame title={route.title} lead={route.lead}>
      <div className="employees">
        <MonthBar month={month} monthPath={(next) => `${route.path}?month=${next}`} />
        {/* Remounted per month: an open confirmation never carries over to another month. */}
        <MonthPlans key={month} basePath={route.path} apis={apis} month={month} />
      </div>
    </PageFrame>
  );
}

/** UX A09/A10 month navigation; stays mounted across month steps, so focus stays on the link. */
function MonthBar({ month, monthPath }: { month: MonthKey; monthPath: (month: MonthKey) => string }) {
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);
  return (
    <section className="employees-card" aria-labelledby="planning-month-title">
      <h2 id="planning-month-title">Monat</h2>
      <div className="assignments__monthbar">
        <h3 aria-live="polite">{formatMonthLabel(month)}</h3>
        <Link
          className="assignments__step assignments__step--previous"
          to={monthPath(previous)}
          aria-label={`Vorheriger Monat: ${formatMonthLabel(previous)}`}
        >
          <span aria-hidden="true">‹</span>Vorheriger Monat
        </Link>
        <Link
          className="assignments__step assignments__step--next"
          to={monthPath(next)}
          aria-label={`Nächster Monat: ${formatMonthLabel(next)}`}
        >
          Nächster Monat<span aria-hidden="true">›</span>
        </Link>
      </div>
    </section>
  );
}

function MonthPlans({ basePath, apis, month }: { basePath: string; apis: OverviewApis; month: MonthKey }) {
  const source = useMemo<ReadSource<MonthKey, OverviewRow[]>>(
    () => ({ kind: 'api', load: (selected, signal) => loadOverview(apis, selected, signal) }),
    [apis],
  );
  const { state, retry } = useReadSource(source, month);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);
  const monthLabel = formatMonthLabel(month);

  // After "Abbrechen" the (re-enabled) trigger button gets focus back.
  useEffect(() => {
    if (confirming === null && returnFocus.current) {
      returnFocus.current = false;
      if (trigger.current?.isConnected) trigger.current.focus();
    }
  }, [confirming]);

  function open(project: Project, button: HTMLElement) {
    trigger.current = button;
    setConfirming(project);
  }

  function close(focusTrigger: boolean) {
    returnFocus.current = focusTrigger;
    setConfirming(null);
  }

  return (
    <section className="employees-card planning-overview" aria-labelledby="planning-plans-title">
      <h2 id="planning-plans-title">Monatspläne {monthLabel}</h2>
      {confirming && (
        <CreatePlanConfirmation
          project={confirming}
          month={month}
          plans={apis.plans}
          planPath={(plan) => `${basePath}/${encodeURIComponent(plan.id)}`}
          onCancel={() => close(true)}
          onReload={() => {
            close(false);
            retry();
          }}
        />
      )}
      {state.status === 'loading' ? (
        <LoadingState label="Monatspläne werden geladen …" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <>
          <EmptyState
            title="Noch keine Projekte"
            description="Monatspläne gehören immer zu einem Projekt. Legen Sie zuerst ein Projekt an und ordnen Sie Mitarbeitende zu."
          />
          <Link className="employees-button" to={PROJECTS_PATH}>Zu den Projekten</Link>
        </>
      ) : (
        <PlansTable rows={state.data} basePath={basePath} monthLabel={monthLabel} onCreate={open} createDisabled={confirming !== null} />
      )}
    </section>
  );
}

type PlansTableProps = {
  rows: OverviewRow[];
  basePath: string;
  monthLabel: string;
  onCreate: (project: Project, button: HTMLElement) => void;
  createDisabled: boolean;
};

function PlansTable({ rows, basePath, monthLabel, onCreate, createDisabled }: PlansTableProps) {
  const captionId = useId();
  const projectCount = rows.filter((row) => row.project !== null).length;
  const planCount = rows.filter((row) => row.plan !== null).length;
  return (
    <>
      <p className="employees__count">
        {projectCount === 1 ? '1 Projekt' : `${projectCount} Projekte`}
        {' · '}
        {planCount === 1 ? '1 Monatsplan' : `${planCount} Monatspläne`} im {monthLabel}
      </p>
      <div className="employees-table__wrap">
        <table className="employees-table" aria-labelledby={captionId}>
          <caption id={captionId}>Projekte und Monatspläne im {monthLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Projekt</th>
              <th scope="col">Projektstatus</th>
              <th scope="col">Monatsplan</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, project, plan }) => {
              const name = project?.name ?? 'Projekt nicht in der Projektliste';
              return (
                <tr key={key}>
                  <th scope="row">{name}</th>
                  <td data-label="Projektstatus">
                    {project ? (
                      <StatusBadge tone={PROJECT_STATUS[project.status].tone}>{PROJECT_STATUS[project.status].label}</StatusBadge>
                    ) : '–'}
                  </td>
                  <td data-label="Monatsplan">
                    {plan ? (
                      <StatusBadge tone={PLAN_STATUS[plan.status].tone}>{PLAN_STATUS[plan.status].label}</StatusBadge>
                    ) : 'Kein Monatsplan'}
                  </td>
                  <td data-label="Aktion">
                    {plan ? (
                      <Link to={`${basePath}/${encodeURIComponent(plan.id)}`} aria-label={`Monatsplan ${name}, ${monthLabel} öffnen`}>
                        Monatsplan öffnen
                      </Link>
                    ) : project?.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="employees-button"
                        disabled={createDisabled}
                        aria-label={`Monatsplan für ${name}, ${monthLabel} erstellen …`}
                        onClick={(event) => onCreate(project, event.currentTarget)}
                      >
                        Monatsplan erstellen …
                      </button>
                    ) : (
                      'Projekt inaktiv – kein neuer Monatsplan möglich'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

type ConfirmationProps = {
  project: Project;
  month: MonthKey;
  plans: MonthlyPlansApi;
  planPath: (plan: MonthlyPlan) => string;
  onCancel: () => void;
  onReload: () => void;
};

/**
 * Explicit confirmation: a plan cannot be deleted in this slice (no removal
 * endpoint), so creation is never a single accidental click.
 */
function CreatePlanConfirmation({ project, month, plans, planPath, onCancel, onReload }: ConfirmationProps) {
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const monthLabel = formatMonthLabel(month);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function create() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const plan = await plans.create(project.id, month);
      void navigate(planPath(plan), { state: PLAN_CREATED_STATE });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Create failed'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  // The overview must be re-read before another attempt: the plan may exist after all.
  const needsReload = outcomeUnknown(error) || (error instanceof ApiError && error.code === 'MONTHLY_PLAN_ALREADY_EXISTS');

  return (
    <div className="employees-confirm planning-confirm" role="group" aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1}>
        Monatsplan für {project.name}, {monthLabel} erstellen?
      </h3>
      <ul>
        <li>Der Monatsplan wird unveröffentlicht angelegt. Mitarbeitende sehen ihn noch nicht.</li>
        <li>Anschließend legen Sie die Tag- und Nachtdienste des Monats an.</li>
        <li>Ein erstellter Monatsplan kann in dieser Ausbaustufe nicht gelöscht werden.</li>
      </ul>
      <ApiErrorAlert error={error} text={planningErrorText(error, 'create-plan')} />
      <div className="employee-form__actions">
        {needsReload ? (
          <button type="button" className="employees-button employees-button--primary" onClick={onReload}>
            Übersicht neu laden
          </button>
        ) : (
          <button
            type="button"
            className="employees-button employees-button--primary"
            disabled={pending}
            aria-busy={pending}
            onClick={() => { void create(); }}
          >
            {pending ? 'Monatsplan wird erstellt …' : 'Monatsplan erstellen'}
          </button>
        )}
        <button type="button" className="employees-button" disabled={pending} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
