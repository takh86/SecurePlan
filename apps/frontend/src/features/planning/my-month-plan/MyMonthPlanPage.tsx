import { useId } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useReadSource } from '../../../shared/data/use-read-source';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { systemClock, type Clock } from '../../../shared/time/clock';
import { addMonths, currentMonth, formatDate, formatMonthLabel, parseMonth } from '../../../shared/time/month';
import { PreviewNotice } from '../../../shared/ui/PreviewNotice';
import { ShiftTime } from '../../../shared/ui/ShiftTime';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { MY_MONTH_PLAN_PATH, myMonthPlanPath } from './my-month-plan-paths';
import { defaultMyMonthPlanSource } from './my-month-plan-preview-source';
import type { MyMonthPlan, MyMonthPlanSource, PlannedDuty } from './my-month-plan-types';
import './MyMonthPlanPage.css';

type MyMonthPlanPageProps = {
  source?: MyMonthPlanSource;
  clock?: Clock;
};

/**
 * Employee landing view: the signed-in employee's planned duties for one month.
 * The month comes from the optional `:month` route parameter (`YYYY-MM`).
 * Read-only; no cancellation request, statistics or save action.
 */
export function MyMonthPlanPage({ source = defaultMyMonthPlanSource, clock = systemClock }: MyMonthPlanPageProps) {
  const { month: monthParam } = useParams();
  const monthTitleId = useId();
  const requested = monthParam === undefined ? currentMonth(clock) : parseMonth(monthParam);
  const month = requested ?? currentMonth(clock);
  const { state, retry } = useReadSource(source, month);

  if (requested === null) return <Navigate to={MY_MONTH_PLAN_PATH} replace />;

  const example = source.kind === 'preview';
  const monthLabel = formatMonthLabel(month);
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);

  return (
    <div className="my-plan">
      {example && <PreviewNotice />}
      <section className="my-plan__month" aria-labelledby={monthTitleId}>
        <div className="my-plan__monthbar">
          <h2 id={monthTitleId} aria-live="polite">{monthLabel}</h2>
          <Link
            className="my-plan__step my-plan__step--previous"
            to={myMonthPlanPath(previous)}
            aria-label={`Vorheriger Monat: ${formatMonthLabel(previous)}`}
          >
            <span aria-hidden="true">‹</span>Vorheriger Monat
          </Link>
          <Link
            className="my-plan__step my-plan__step--next"
            to={myMonthPlanPath(next)}
            aria-label={`Nächster Monat: ${formatMonthLabel(next)}`}
          >
            Nächster Monat<span aria-hidden="true">›</span>
          </Link>
        </div>
        {state.status === 'loading' ? (
          <LoadingState label="Monatsplan wird geladen …" />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : (
          <MonthPlanContent plan={state.data} monthLabel={monthLabel} example={example} />
        )}
      </section>
      <p className="my-plan__note">
        Angezeigt werden Ihre geplanten Dienste laut veröffentlichtem Monatsplan, keine erfassten
        Arbeitszeiten.
      </p>
    </div>
  );
}

function MonthPlanContent({ plan, monthLabel, example }: { plan: MyMonthPlan | null; monthLabel: string; example: boolean }) {
  if (plan === null) {
    return (
      <EmptyState
        title="Kein veröffentlichter Plan"
        description={`Für ${monthLabel} liegt kein veröffentlichter Plan vor.`}
      />
    );
  }
  if (plan.duties.length === 0) {
    return (
      <EmptyState
        title="Keine Dienste geplant"
        description={`Für ${monthLabel} sind für Sie keine Dienste geplant.`}
      />
    );
  }
  const duties = [...plan.duties].sort((a, b) => a.shift.date.localeCompare(b.shift.date));
  return (
    <ul className="my-plan__duties">
      {duties.map((duty) => (
        <li key={duty.reference}>
          <DutyCard duty={duty} example={example} />
        </li>
      ))}
    </ul>
  );
}

function DutyCard({ duty, example }: { duty: PlannedDuty; example: boolean }) {
  const titleId = useId();
  return (
    <article className="duty-card" aria-labelledby={titleId}>
      <div className="duty-card__header">
        <h3 id={titleId}>{formatDate(duty.shift.date)}</h3>
        <StatusBadge tone={duty.status === 'PLANNED' ? 'neutral' : 'attention'}>
          {duty.status === 'PLANNED' ? 'Geplant' : 'Absage beantragt – Entscheidung offen'}
        </StatusBadge>
      </div>
      <p className="duty-card__type">{SHIFT_TYPE_LABELS[duty.shift.type]}</p>
      <p>
        <ShiftTime shift={duty.shift} example={example} />
      </p>
      <p className="duty-card__project">Projekt: {duty.projectName}</p>
    </article>
  );
}
