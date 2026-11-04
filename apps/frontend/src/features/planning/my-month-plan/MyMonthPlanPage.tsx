import { useId, useMemo, useState } from 'react';
import { OwnCancellations } from './OwnCancellations';
import { CancellationAction } from './CancellationAction';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import type { IdentityContext } from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';
import { useReadSource } from '../../../shared/data/use-read-source';
import {
  parsePlanMonth,
  planDateLabel,
  planMonthLabel,
  stepPlanMonth,
  zonedDutyTime,
} from '../../../shared/time/civil-time';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../shared/ui/ViewStates';
import { MY_MONTH_PLAN_PATH, myMonthPlanPath } from './my-month-plan-paths';
import { createMyMonthPlanSource } from './my-month-plan-api';
import type { MyDuty, MyMonthlyPlansResponse } from './my-month-plan-types';
import './MyMonthPlanPage.css';

type Props = {
  api: SessionApi;
  identity: IdentityContext;
  requestSessionRevalidation: () => void;
};

export function MyMonthPlanPage(props: Props) {
  const { month: parameter } = useParams();
  const month = parameter === undefined ? '' : parsePlanMonth(parameter);
  if (month === null)
    return (
      <div role="alert">
        <h2>Ungültiger Monat</h2>
        <p>Bitte wählen Sie einen gültigen Monat.</p>
        <Link to={MY_MONTH_PLAN_PATH}>Zum aktuellen Monatsplan</Link>
      </div>
    );
  return (
    <ValidMonthPlan
      key={`${props.identity.companyId}:${props.identity.accountId}:${props.identity.role}`}
      {...props}
      month={month}
    />
  );
}

function ValidMonthPlan({
  api,
  identity,
  requestSessionRevalidation,
  month,
}: Props & { month: string }) {
  const source = useMemo(
    () => createMyMonthPlanSource(api, identity, requestSessionRevalidation),
    [api, identity, requestSessionRevalidation],
  );
  const { state, retry } = useReadSource(source, month);
  const [notice, setNotice] = useState('');
  const [cancellationRevision, setCancellationRevision] = useState(0);
  const cancellation = {
    api,
    identity,
    revalidate: requestSessionRevalidation,
    onCreated: () => setCancellationRevision((v) => v + 1),
    onStale: () => {
      setNotice(
        'Der Dienst hat sich geändert. Der Monatsplan wird neu geladen. Bitte prüfen und bestätigen Sie den Dienst erneut.',
      );
      retry();
    },
  };
  const headingId = useId();
  const navigate = useNavigate();
  if (!month) {
    if (state.status === 'ready')
      return (
        <Navigate
          to={myMonthPlanPath(
            state.data.context.currentCompanyMonth.slice(0, 7),
          )}
          replace
        />
      );
    return state.status === 'error' ? (
      <ErrorState error={state.error} onRetry={retry} />
    ) : (
      <LoadingState label="Unternehmensmonat wird geladen …" />
    );
  }
  const previous = stepPlanMonth(month, -1),
    next = stepPlanMonth(month, 1);
  const monthLabel = planMonthLabel(month);
  return (
    <div className="my-plan">
      <section className="my-plan__month" aria-labelledby={headingId}>
        <div className="my-plan__monthbar">
          <h2 id={headingId} aria-live="polite">
            {monthLabel}
          </h2>
          {previous ? (
            <Link
              className="my-plan__step my-plan__step--previous"
              to={myMonthPlanPath(previous)}
              aria-label={`Vorheriger Monat: ${planMonthLabel(previous)}`}
            >
              ‹ Vorheriger Monat
            </Link>
          ) : (
            <button className="my-plan__step my-plan__step--previous" disabled>
              Vorheriger Monat
            </button>
          )}
          {next ? (
            <Link
              className="my-plan__step my-plan__step--next"
              to={myMonthPlanPath(next)}
              aria-label={`Nächster Monat: ${planMonthLabel(next)}`}
            >
              Nächster Monat ›
            </Link>
          ) : (
            <button className="my-plan__step my-plan__step--next" disabled>
              Nächster Monat
            </button>
          )}
        </div>
        <div className="my-plan__controls">
          <label>
            Monat auswählen{' '}
            <input
              type="month"
              min="0001-01"
              max="9999-12"
              value={month}
              onChange={(event) => {
                const selected = parsePlanMonth(event.target.value);
                if (selected) void navigate(myMonthPlanPath(selected));
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              retry();
              setCancellationRevision((v) => v + 1);
            }}
          >
            Aktualisieren
          </button>
        </div>
        {notice && <p role="alert">{notice}</p>}
        {state.status === 'loading' ? (
          <LoadingState label="Monatsplan wird geladen …" />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : (
          <>
            {state.data.response ? (
              <MonthPlanContent
                response={state.data.response}
                monthLabel={monthLabel}
                cancellation={cancellation}
              />
            ) : (
              <ErrorState
                error={new Error('Invalid plan response')}
                onRetry={retry}
              />
            )}
          </>
        )}
      </section>
      <OwnCancellations
        api={api}
        identity={identity}
        monthStart={`${month}-01`}
        revision={cancellationRevision}
        revalidate={requestSessionRevalidation}
      />
      <p className="my-plan__note">
        Angezeigt werden Ihre geplanten Dienste laut veröffentlichtem
        Monatsplan, keine erfassten Arbeitszeiten.
      </p>
    </div>
  );
}

function MonthPlanContent({
  response,
  monthLabel,
  cancellation,
}: {
  response: MyMonthlyPlansResponse;
  monthLabel: string;
  cancellation: Pick<
    Parameters<typeof CancellationAction>[0],
    'api' | 'identity' | 'onStale' | 'revalidate' | 'onCreated'
  >;
}) {
  if (response.items.length === 0)
    return (
      <EmptyState
        title="Kein veröffentlichter Plan"
        description={`Für ${monthLabel} liegt kein veröffentlichter Plan vor.`}
      />
    );
  const duties = response.items.flatMap((plan) =>
    plan.duties.map((duty) => ({ duty, project: plan.project.name })),
  );
  if (duties.length === 0)
    return (
      <EmptyState
        title="Keine Dienste geplant"
        description={`Für ${monthLabel} sind für Sie keine Dienste geplant.`}
      />
    );
  return (
    <ul className="my-plan__duties">
      {duties.map(({ duty, project }) => (
        <li key={duty.dutyId}>
          <DutyCard duty={duty} project={project} cancellation={cancellation} />
        </li>
      ))}
    </ul>
  );
}
function DutyCard({
  duty,
  project,
  cancellation,
}: {
  duty: MyDuty;
  project: string;
  cancellation: Pick<
    Parameters<typeof CancellationAction>[0],
    'api' | 'identity' | 'onStale' | 'revalidate' | 'onCreated'
  >;
}) {
  const titleId = useId();
  const start = zonedDutyTime(duty.startsAt, duty.timeZone),
    end = zonedDutyTime(duty.endsAt, duty.timeZone);
  return (
    <article className="duty-card" aria-labelledby={titleId}>
      <div className="duty-card__header">
        <h3 id={titleId}>{planDateLabel(duty.dutyDate)}</h3>
        <StatusBadge tone="neutral">Geplant</StatusBadge>
      </div>
      <p className="duty-card__type">
        {duty.shiftKind === 'DAY' ? 'Tagdienst' : 'Nachtdienst'}
      </p>
      <p>
        Dienstzeit: <time dateTime={duty.startsAt}>{start.time}</time>
        {start.date !== duty.dutyDate &&
          ` (${planDateLabel(start.date)})`} –{' '}
        <time dateTime={duty.endsAt}>{end.time}</time>
        {end.date !== duty.dutyDate && ` (${planDateLabel(end.date)})`}
      </p>
      <p>Zeitzone: {duty.timeZone}</p>
      <p className="duty-card__project">Projekt: {project}</p>
      <CancellationAction
        key={`${duty.assignmentId}:${duty.version}`}
        {...cancellation}
        duty={duty}
        project={project}
      />
    </article>
  );
}
