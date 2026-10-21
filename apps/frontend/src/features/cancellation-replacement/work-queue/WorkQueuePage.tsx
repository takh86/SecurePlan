import { useId, useState } from 'react';
import { useReadSource } from '../../../shared/data/use-read-source';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { formatDate } from '../../../shared/time/month';
import { PreviewNotice } from '../../../shared/ui/PreviewNotice';
import { ShiftTime } from '../../../shared/ui/ShiftTime';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { defaultWorkQueueSource } from './work-queue-preview-source';
import type { WorkQueueCase, WorkQueueSegment, WorkQueueSource } from './work-queue-types';
import './WorkQueuePage.css';

const SEGMENTS: ReadonlyArray<{ value: WorkQueueSegment; label: string }> = [
  { value: 'all', label: 'Alle' },
  { value: 'with-offers', label: 'Ersatzangebote liegen vor' },
  { value: 'without-offers', label: 'Noch kein Ersatzangebot' },
];

function hasOffers(item: WorkQueueCase): boolean {
  return item.replacementOfferCount > 0;
}

function inSegment(segment: WorkQueueSegment, item: WorkQueueCase): boolean {
  if (segment === 'with-offers') return hasOffers(item);
  if (segment === 'without-offers') return !hasOffers(item);
  return true;
}

function offerCountLabel(count: number): string {
  return count === 1 ? '1 Ersatzangebot' : `${count} Ersatzangebote`;
}

/**
 * Admin landing view: open cancellation/replacement cases, exceptions first.
 * Read-only. Decision actions need an approved API contract and backend support.
 */
export function WorkQueuePage({ source = defaultWorkQueueSource }: { source?: WorkQueueSource }) {
  const { state, retry } = useReadSource(source, null);
  const example = source.kind === 'preview';

  return (
    <div className="work-queue">
      {example && <PreviewNotice />}
      {state.status === 'loading' ? (
        <LoadingState label="Offene Vorgänge werden geladen …" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <EmptyState
          title="Keine offenen Vorgänge"
          description="Aktuell gibt es keine offenen Absage- oder Ersatzvorgänge."
        />
      ) : (
        <WorkQueueOverview cases={state.data} example={example} />
      )}
      <p className="work-queue__note">
        Entscheidungen über Absagen und die Auswahl eines Ersatzes sind in dieser Ansicht noch nicht
        möglich. Die Bearbeitung einzelner Vorgänge folgt in einer späteren Ausbaustufe.
      </p>
    </div>
  );
}

function WorkQueueOverview({ cases, example }: { cases: WorkQueueCase[]; example: boolean }) {
  const [segment, setSegment] = useState<WorkQueueSegment>('all');
  const filterName = useId();
  const listTitleId = useId();

  const withOffers = cases.filter(hasOffers).length;
  const counts: Record<WorkQueueSegment, number> = {
    all: cases.length,
    'with-offers': withOffers,
    'without-offers': cases.length - withOffers,
  };
  const visible = cases
    .filter((item) => inSegment(segment, item))
    .sort((a, b) => a.shift.date.localeCompare(b.shift.date) || a.shift.start.localeCompare(b.shift.start));

  return (
    <>
      <section className="work-queue__summary" aria-label="Zusammenfassung">
        <dl>
          <div>
            <dt>Offene Vorgänge</dt>
            <dd>{counts.all}</dd>
          </div>
          <div>
            <dt>Mit Ersatzangebot</dt>
            <dd>{counts['with-offers']}</dd>
          </div>
          <div>
            <dt>Ohne Ersatzangebot</dt>
            <dd>{counts['without-offers']}</dd>
          </div>
        </dl>
      </section>

      <section className="work-queue__cases" aria-labelledby={listTitleId}>
        <h2 id={listTitleId}>Vorgänge nach Dienstbeginn</h2>
        <fieldset className="work-queue__filter">
          <legend>Vorgänge filtern</legend>
          {SEGMENTS.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={filterName}
                value={option.value}
                checked={segment === option.value}
                onChange={() => setSegment(option.value)}
              />
              {option.label} ({counts[option.value]})
            </label>
          ))}
        </fieldset>
        <p className="work-queue__count" aria-live="polite">
          {visible.length} von {cases.length} Vorgängen angezeigt
        </p>
        {visible.length === 0 ? (
          <EmptyState
            title="Keine Vorgänge in dieser Auswahl"
            description="Wählen Sie einen anderen Filter, um weitere Vorgänge zu sehen."
          />
        ) : (
          <ul className="work-queue__list">
            {visible.map((item) => (
              <li key={item.reference}>
                <WorkQueueCaseCard item={item} example={example} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function WorkQueueCaseCard({ item, example }: { item: WorkQueueCase; example: boolean }) {
  const titleId = useId();
  const offers = hasOffers(item);

  return (
    <article className="wq-case" aria-labelledby={titleId}>
      <div className="wq-case__header">
        <h3 id={titleId}>{item.employeeName}</h3>
        <StatusBadge tone={offers ? 'info' : 'attention'}>
          {offers ? 'Ersatzangebote liegen vor' : 'Noch kein Ersatzangebot'}
        </StatusBadge>
      </div>
      <dl className="wq-case__facts">
        <div>
          <dt>Dienst</dt>
          <dd>
            {formatDate(item.shift.date)} · {SHIFT_TYPE_LABELS[item.shift.type]}
            <br />
            <ShiftTime shift={item.shift} example={example} />
          </dd>
        </div>
        <div>
          <dt>Projekt</dt>
          <dd>{item.projectName}</dd>
        </div>
        <div>
          <dt>Absage eingegangen</dt>
          <dd>{formatDate(item.cancellationReceivedOn)}</dd>
        </div>
        <div>
          <dt>Ersatzangebote</dt>
          <dd>{offerCountLabel(item.replacementOfferCount)}</dd>
        </div>
        <div>
          <dt>Referenz</dt>
          <dd>{item.reference}</dd>
        </div>
      </dl>
    </article>
  );
}
