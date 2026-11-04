import { useId, useMemo } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import type { IdentityContext } from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';
import { useReadSource } from '../../../shared/data/use-read-source';
import {
  parsePlanMonth,
  planMonthLabel,
  stepPlanMonth,
} from '../../../shared/time/civil-time';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../shared/ui/ViewStates';
import {
  createPlanningStatisticsSource,
  type PlanningStatisticsResponse,
} from './my-statistics-api';
import '../my-month-plan/MyMonthPlanPage.css';
import './MyStatisticsPage.css';

const MY_STATISTICS_PATH = '/meine-statistik';
const myStatisticsPath = (month: string) => `${MY_STATISTICS_PATH}/${month}`;

type Props = {
  api: SessionApi;
  identity: IdentityContext;
  requestSessionRevalidation: () => void;
};

export function MyStatisticsPage(props: Props) {
  const { month: parameter } = useParams();
  const month = parameter === undefined ? '' : parsePlanMonth(parameter);
  if (month === null)
    return (
      <div role="alert">
        <h2>Ungültiger Monat</h2>
        <p>Bitte wählen Sie einen gültigen Monat.</p>
        <Link to={MY_STATISTICS_PATH}>Zur aktuellen Statistik</Link>
      </div>
    );
  return <ValidStatistics {...props} month={month} />;
}

function ValidStatistics({
  api,
  identity,
  requestSessionRevalidation,
  month,
}: Props & { month: string }) {
  const source = useMemo(
    () =>
      createPlanningStatisticsSource(api, identity, requestSessionRevalidation),
    [api, identity, requestSessionRevalidation],
  );
  const { state, retry } = useReadSource(source, month);
  const headingId = useId();
  const navigate = useNavigate();
  if (!month) {
    if (state.status === 'ready')
      return (
        <Navigate
          to={myStatisticsPath(
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
    <div className="my-plan my-statistics">
      <section className="my-plan__month" aria-labelledby={headingId}>
        <div className="my-plan__monthbar">
          <h2 id={headingId} aria-live="polite">
            {monthLabel}
          </h2>
          {previous ? (
            <Link
              className="my-plan__step my-plan__step--previous"
              to={myStatisticsPath(previous)}
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
              to={myStatisticsPath(next)}
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
                if (selected) void navigate(myStatisticsPath(selected));
              }}
            />
          </label>
          <button type="button" onClick={retry}>
            Aktualisieren
          </button>
        </div>
        {state.status === 'loading' ? (
          <LoadingState label="Statistik wird geladen …" />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : (
          <>
            {state.data.response ? (
              <StatisticsContent response={state.data.response} />
            ) : (
              <ErrorState
                error={new Error('Invalid statistics response')}
                onRetry={retry}
              />
            )}
          </>
        )}
      </section>
      <p className="my-plan__note">
        Angezeigt werden Ihre geplanten Dienste laut veröffentlichtem
        Monatsplan, keine erfassten Arbeitszeiten.
      </p>
    </div>
  );
}

function StatisticsContent({
  response,
}: {
  response: PlanningStatisticsResponse;
}) {
  return (
    <div aria-live="polite" aria-atomic="true">
      <dl className="statistics-cards" aria-label="Planungsstatistik">
        {(
          [
            ['Geplante Arbeitstage', response.plannedWorkdays],
            ['Tagdienste', response.dayShiftCount],
            ['Nachtdienste', response.nightShiftCount],
          ] as const
        ).map(([label, count]) => (
          <div className="statistics-card" key={label}>
            <dt>{label}</dt>
            <dd>{count.toLocaleString('de-DE')}</dd>
          </div>
        ))}
      </dl>
      {response.plannedWorkdays === 0 && (
        <EmptyState
          title="Keine eigenen Dienste"
          description="Für diesen Monat liegen keine eigenen veröffentlichten Dienste vor."
        />
      )}
    </div>
  );
}
