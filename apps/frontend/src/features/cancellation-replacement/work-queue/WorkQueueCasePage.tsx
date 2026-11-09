import { useId, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { PageFrame } from '../../../app/PageFrame';
import type { AppRoute } from '../../../app/routes';
import { ApiError } from '../../../shared/api/api-error';
import type { ReadSource } from '../../../shared/data/data-source';
import { useReadSource } from '../../../shared/data/use-read-source';
import { planDateLabel, planMonthLabel } from '../../../shared/time/civil-time';
import { ApiErrorAlert } from '../../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { dutyTimeText, formatUtc } from './work-queue-format';
import { isCaseId, offersSearch, parseOffersQuery, type WorkQueueApi } from './work-queue-api';
import {
  CANCELLATION_LABELS,
  ELIGIBILITY_LABELS,
  NEED_LABELS,
  OFFER_LABELS,
  SHIFT_LABELS,
  type AdminOffer,
  type CaseContext,
  type OfferStatus,
  type OffersPage,
  type OffersQuery,
  type Pagination,
} from './work-queue-types';
import './WorkQueue.css';

type Props = {
  route: AppRoute;
  queue: WorkQueueApi;
  needId: string;
};

type CaseRequest = { query: OffersQuery; revision: number };

const OFFER_FILTER_OPTIONS: ReadonlyArray<{ value: OfferStatus | null; label: string }> = [
  { value: null, label: 'Alle Angebote' },
  ...(Object.keys(OFFER_LABELS) as OfferStatus[]).map((value) => ({ value, label: OFFER_LABELS[value].label })),
];

/** Only in-app return targets from the list are used; anything else falls back to the queue root. */
function backTarget(state: unknown, basePath: string): string {
  const back = state && typeof state === 'object' && 'back' in state ? (state as { back: unknown }).back : undefined;
  return typeof back === 'string' && (back === basePath || back.startsWith(`${basePath}?`)) ? back : basePath;
}

/** Whether the case is still pending work (same rule as the queue; the server decides which rows are listed). */
function isPendingCase(context: CaseContext): boolean {
  const { cancellation, need } = context;
  return (
    (cancellation.status === 'OPEN' && need.status === 'OPEN') ||
    (cancellation.status === 'APPROVED' && need.status === 'OPEN_UNFILLED')
  );
}

/**
 * Case view `/arbeitsuebersicht/:needId`. One offers request returns the case
 * context and the offer page from one server snapshot. Read-only: no action here
 * changes a cancellation, a need or an offer.
 */
export function WorkQueueCasePage({ route, queue, needId }: Props) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const [decision, setDecision] = useState<Decision>({ phase: 'idle' });
  const search = offersSearch(parseOffersQuery(params));
  const query = useMemo(() => parseOffersQuery(new URLSearchParams(search)), [search]);
  const request = useMemo<CaseRequest>(() => ({ query, revision }), [query, revision]);
  const back = backTarget(location.state, route.path);

  const source = useMemo<ReadSource<CaseRequest, OffersPage>>(
    () => ({
      kind: 'api',
      load: (current, signal) => queue.offers(needId, current.query, signal),
    }),
    [queue, needId],
  );
  const { state, retry } = useReadSource(source, request);

  function navigateTo(next: OffersQuery) {
    setParams(new URLSearchParams(offersSearch(next)));
  }

  return (
    <PageFrame title="Vorgang prüfen" lead="Offene Vorgänge prüfen. Ein geeignetes Angebot kann hier ausgewählt werden; die Auswahl wird serverseitig geprüft.">
      <div className="work-queue work-queue--case">
        <p className="work-queue__back">
          <Link to={back}>Zur Arbeitsübersicht</Link>
        </p>
        {!isCaseId(needId) ? (
          <CaseUnavailable />
        ) : state.status === 'loading' ? (
          <LoadingState label="Vorgang wird geladen …" />
        ) : state.status === 'error' ? (
          state.error instanceof ApiError && state.error.status === 404 ? (
            <CaseUnavailable error={state.error} />
          ) : (
            <div className="work-queue__error">
              <ErrorState error={state.error} onRetry={retry} />
            </div>
          )
        ) : (
          <CaseDetails
            data={state.data}
            query={query}
            queue={queue}
            needId={needId}
            decision={decision}
            onDecision={setDecision}
            onChange={navigateTo}
            onRefresh={() => setRevision((current) => current + 1)}
          />
        )}
      </div>
    </PageFrame>
  );
}

function CaseUnavailable({ error }: { error?: ApiError }) {
  // Never reveals whether the case exists in another company; the server answers the same way.
  return (
    <div className="work-queue__error">
      <ApiErrorAlert
        error={error ?? new ApiError('http', 404, 'RESOURCE_NOT_FOUND', null)}
        text={{
          title: 'Vorgang nicht verfügbar',
          description:
            'Der Vorgang ist nicht mehr vorhanden oder für Ihr Unternehmen nicht sichtbar. Kehren Sie zur Übersicht zurück und laden Sie sie neu.',
        }}
      />
    </div>
  );
}

function CaseDetails({
  data,
  query,
  queue,
  needId,
  decision,
  onDecision,
  onChange,
  onRefresh,
}: {
  data: OffersPage;
  query: OffersQuery;
  queue: WorkQueueApi;
  needId: string;
  decision: Decision;
  onDecision: (next: Decision) => void;
  onChange: (next: OffersQuery) => void;
  onRefresh: () => void;
}) {
  const { context } = data;
  const { cancellation, need } = context;
  const employee = cancellation.employee;
  const statusId = useId();
  const employeeId = useId();
  const dutyId = useId();
  const offersId = useId();
  const filterId = useId();
  const pending = isPendingCase(context);
  const cancellationLabel = CANCELLATION_LABELS[cancellation.status];
  const needLabel = NEED_LABELS[need.status];

  return (
    <>
      {!pending && (
        <p className="work-queue__notice" role="note">
          Dieser Vorgang ist nicht mehr offen und wird nicht als ausstehende Arbeit geführt.
        </p>
      )}

      <section className="work-queue__section" aria-labelledby={statusId}>
        <h2 id={statusId}>Vorgangsstatus</h2>
        <dl className="work-queue__facts">
          <div>
            <dt>Absage</dt>
            <dd>
              <StatusBadge tone={cancellationLabel.tone}>{cancellationLabel.label}</StatusBadge>
            </dd>
          </div>
          <div>
            <dt>Ersatzbedarf</dt>
            <dd>
              <StatusBadge tone={needLabel.tone}>{needLabel.label}</StatusBadge>
            </dd>
          </div>
          <div>
            <dt>Absage eingegangen</dt>
            <dd>{formatUtc(cancellation.createdAt)}</dd>
          </div>
          <div>
            <dt>Absage entschieden</dt>
            <dd>{cancellation.decidedAt ? formatUtc(cancellation.decidedAt) : 'Noch nicht entschieden'}</dd>
          </div>
          <div>
            <dt>Ersatz erledigt</dt>
            <dd>{need.resolvedAt ? formatUtc(need.resolvedAt) : 'Nicht erledigt'}</dd>
          </div>
          <div>
            <dt>Ursprüngliche Zuordnung</dt>
            <dd>{context.originalAssignmentActive ? 'Aktiv' : 'Nicht mehr aktiv'}</dd>
          </div>
          <div>
            <dt>Dienst entfernt</dt>
            <dd>{context.dutyRemoved ? 'Ja' : 'Nein'}</dd>
          </div>
        </dl>
      </section>

      <section className="work-queue__section" aria-labelledby={employeeId}>
        <h2 id={employeeId}>Ursprünglich eingetragene Person</h2>
        <p className="work-queue__name">
          {employee.firstName} {employee.lastName}
        </p>
        <p className="work-queue__sub">Personalnummer {employee.employeeCode}</p>
      </section>

      <section className="work-queue__section" aria-labelledby={dutyId}>
        <h2 id={dutyId}>Betroffener Dienst</h2>
        <dl className="work-queue__facts">
          <div>
            <dt>Projekt</dt>
            <dd>{need.project.name}</dd>
          </div>
          <div>
            <dt>Dienstdatum</dt>
            <dd>{planDateLabel(need.duty.dutyDate)}</dd>
          </div>
          <div>
            <dt>Schicht</dt>
            <dd>{SHIFT_LABELS[need.duty.shiftKind]}</dd>
          </div>
          <div>
            <dt>Dienstzeit</dt>
            <dd>
              {dutyTimeText(need.duty, need.timeZone)}
              <span className="work-queue__sub">Zeitzone {need.timeZone}</span>
            </dd>
          </div>
          <div>
            <dt>Dienstmonat</dt>
            <dd>{planMonthLabel(context.monthStart.slice(0, 7))}</dd>
          </div>
        </dl>
      </section>

      <section className="work-queue__section" aria-labelledby={offersId}>
        <h2 id={offersId}>Ersatzangebote</h2>
        <dl className="work-queue__counts">
          <div>
            <dt>Offene Angebote</dt>
            <dd>{need.openOfferCount}</dd>
          </div>
          <div>
            <dt>Davon aktuell geeignet</dt>
            <dd>{context.eligibleOpenOfferCount}</dd>
          </div>
        </dl>
        <p className="work-queue__legend">
          Aktuell geeignet beschreibt nur, ob ein Angebot die aktuellen Kriterien für ein neues Angebot erfüllt. Es ist keine
          Auswahl und keine Zuweisung.
        </p>

        <div className="work-queue__controls">
          <label htmlFor={filterId}>
            Angebotsstatus
            <select
              id={filterId}
              value={query.status ?? ''}
              onChange={(event) => {
                const next = OFFER_FILTER_OPTIONS.find((option) => (option.value ?? '') === event.target.value);
                onChange({ status: next?.value ?? null, page: 1 });
              }}
            >
              {OFFER_FILTER_OPTIONS.map((option) => (
                <option key={option.label} value={option.value ?? ''}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="work-queue__button" onClick={onRefresh}>
            Ansicht aktualisieren
          </button>
        </div>

        <OfferList
          page={data}
          query={query}
          onPage={(page) => onChange({ ...query, page })}
          onAllStatuses={() => onChange({ status: null, page: 1 })}
        />
      </section>

      <SelectionPanel
        queue={queue}
        needId={needId}
        page={data}
        decision={decision}
        onDecision={onDecision}
        onRefresh={onRefresh}
      />

      <p className="work-queue__evaluated">Stand der Auswertung: {formatUtc(context.evaluatedAt)}</p>
    </>
  );
}

function OfferList({
  page,
  query,
  onPage,
  onAllStatuses,
}: {
  page: OffersPage;
  query: OffersQuery;
  onPage: (page: number) => void;
  onAllStatuses: () => void;
}) {
  const captionId = useId();
  if (page.items.length === 0) {
    // Three different situations; only the first means that no offer exists for this need.
    if (page.pagination.totalItems > 0) {
      // Offers exist, but the requested page is past the last one (the status filter is kept).
      return (
        <div className="work-queue__empty">
          <EmptyState
            title="Diese Seite ist leer"
            description="Die angeforderte Seite enthält keine Angebote mehr. Der gewählte Angebotsstatus bleibt erhalten."
          />
          <button type="button" className="work-queue__button" onClick={() => onPage(1)}>
            Zur ersten Seite
          </button>
        </div>
      );
    }
    if (query.status) {
      // A status filter without matches; offers of other statuses may still exist.
      return (
        <div className="work-queue__empty">
          <EmptyState
            title="Keine Angebote mit diesem Status"
            description="Für den gewählten Angebotsstatus gibt es keine Angebote. Angebote mit einem anderen Status können trotzdem vorhanden sein."
          />
          <button type="button" className="work-queue__button" onClick={onAllStatuses}>
            Alle Angebote anzeigen
          </button>
        </div>
      );
    }
    return (
      <EmptyState
        title="Noch keine Ersatzangebote"
        description="Für diesen Ersatzbedarf wurde bisher kein Angebot eingereicht."
      />
    );
  }
  return (
    <>
      <p className="work-queue__summary" aria-live="polite">
        {page.pagination.totalItems} Angebote in dieser Auswahl
      </p>
      <div className="work-queue__table-wrap">
        <table className="work-queue__table" aria-labelledby={captionId}>
          <caption id={captionId}>Eingereichte Ersatzangebote</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Angebotsstatus</th>
              <th scope="col">Eingereicht</th>
              <th scope="col">Entschieden</th>
              <th scope="col">Aktuelle Prüfung</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((offer) => (
              <OfferRow key={offer.id} offer={offer} />
            ))}
          </tbody>
        </table>
      </div>
      <OfferPager pagination={page.pagination} onPage={onPage} />
    </>
  );
}

function OfferRow({ offer }: { offer: AdminOffer }) {
  const status = OFFER_LABELS[offer.status];
  const eligibility = ELIGIBILITY_LABELS[offer.reviewEligibility];
  return (
    <tr>
      <th scope="row">
        <span className="work-queue__name">
          {offer.employee.firstName} {offer.employee.lastName}
        </span>
        <span className="work-queue__sub">Personalnummer {offer.employee.employeeCode}</span>
      </th>
      <td data-label="Angebotsstatus">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </td>
      <td data-label="Eingereicht">{formatUtc(offer.createdAt)}</td>
      <td data-label="Entschieden">{offer.decidedAt ? formatUtc(offer.decidedAt) : '–'}</td>
      <td data-label="Aktuelle Prüfung">
        <StatusBadge tone={eligibility.tone}>{eligibility.label}</StatusBadge>
      </td>
    </tr>
  );
}

function OfferPager({ pagination, onPage }: { pagination: Pagination; onPage: (page: number) => void }) {
  if (pagination.totalPages <= 1) return null;
  return (
    <nav className="work-queue__pager" aria-label="Angebotsseiten">
      <button type="button" className="work-queue__button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>
        Vorherige Seite
      </button>
      <span>
        Seite {pagination.page} von {pagination.totalPages}
      </span>
      <button
        type="button"
        className="work-queue__button"
        disabled={pagination.page >= pagination.totalPages}
        onClick={() => onPage(pagination.page + 1)}
      >
        Nächste Seite
      </button>
    </nav>
  );
}

/** SP-20: what the administrator may do next. Every rule is re-checked by the server under its locks. */
type Decision =
  | { phase: 'idle' }
  | { phase: 'confirm'; offer: AdminOffer; key: string }
  | { phase: 'pending'; offer: AdminOffer; key: string }
  | { phase: 'done' }
  | { phase: 'retry'; offer: AdminOffer; key: string }
  | { phase: 'refused'; message: string };

/** German text per refusal code (the closed catalogue; anything else gets the generic text). */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  CANCELLATION_ALREADY_RESOLVED: 'Dieser Vorgang ist bereits entschieden.',
  REPLACEMENT_NEED_NOT_OPEN: 'Dieser Ersatzbedarf ist nicht mehr offen.',
  PLAN_CONCURRENT_MODIFICATION: 'Der Vorgang wurde inzwischen geändert.',
  REPLACEMENT_OFFER_NOT_SELECTABLE: 'Dieses Angebot kann nicht mehr ausgewählt werden.',
  REPLACEMENT_CANDIDATE_INELIGIBLE: 'Die Person ist für diesen Dienst nicht mehr geeignet.',
  REPLACEMENT_CANDIDATE_UNAVAILABLE: 'Die Person ist in diesem Zeitraum nicht verfügbar.',
  CANCELLATION_PLAN_CHANGED: 'Der Dienst oder der Plan wurde inzwischen geändert.',
  RESOURCE_EDIT_LOCKED: 'Der Dienst wird gerade im Plan bearbeitet. Versuchen Sie es in einer Minute erneut.',
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'Diese Auswahl wird bereits verarbeitet.',
};

function refusalText(error: ApiError): string {
  return REFUSAL_TEXT[error.code ?? ''] ?? 'Die Auswahl wurde nicht angenommen.';
}

/**
 * SP-20 administrative decision: choose one eligible offer, confirm, then submit. A disabled button is only a
 * presentation; the server enforces concurrency. A refused answer reloads the case; an unknown outcome keeps
 * the same Idempotency-Key, so a retry replays the decision instead of making a second one.
 */
function SelectionPanel({
  queue,
  needId,
  page,
  decision,
  onDecision,
  onRefresh,
}: {
  queue: WorkQueueApi;
  needId: string;
  page: OffersPage;
  decision: Decision;
  onDecision: (next: Decision) => void;
  onRefresh: () => void;
}) {
  const headingId = useId();
  const { context, items, pagination } = page;
  const open = context.cancellation.status === 'OPEN' && context.need.status === 'OPEN';
  const eligible = items.filter((offer) => offer.status === 'OPEN' && offer.reviewEligibility === 'ELIGIBLE');
  const busy = decision.phase === 'pending';

  async function submit(offer: AdminOffer, key: string) {
    onDecision({ phase: 'pending', offer, key });
    try {
      await queue.select(needId, { offerId: offer.id, expectedVersion: context.need.concurrencyVersion, idempotencyKey: key });
      onDecision({ phase: 'done' });
      onRefresh();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
        onDecision({ phase: 'refused', message: `${error.status === 404 ? 'Dieser Vorgang ist nicht mehr sichtbar.' : refusalText(error)} Die Daten wurden neu geladen.` });
        onRefresh();
      } else if (error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500) {
        onDecision({ phase: 'refused', message: `${refusalText(error)} Laden Sie den Vorgang neu, bevor Sie erneut auswählen.` });
      } else {
        // Unknown outcome (lost answer or server error): keep the key so that a retry replays the same decision.
        onDecision({ phase: 'retry', offer, key });
      }
    }
  }

  const messages = (
    <>
      {decision.phase === 'done' && (
        <p className="work-queue__notice" role="status">
          Ersatz ausgewählt. Der Vorgang ist abgeschlossen.
        </p>
      )}
      {decision.phase === 'refused' && (
        <p className="work-queue__error-text" role="alert">
          {decision.message}
        </p>
      )}
    </>
  );

  if (!open) {
    // A case that is no longer open shows only the outcome of this session's decision, if any.
    const outcome = decision.phase === 'done' || decision.phase === 'refused';
    return outcome ? (
      <section className="work-queue__section" aria-labelledby={headingId}>
        <h2 id={headingId}>Ersatz auswählen</h2>
        {messages}
      </section>
    ) : null;
  }

  return (
    <section className="work-queue__section" aria-labelledby={headingId} aria-busy={busy || undefined}>
      <h2 id={headingId}>Ersatz auswählen</h2>
      {messages}
      {decision.phase === 'retry' && (
        <p className="work-queue__error-text" role="alert">
          Die Antwort des Servers fehlt. Die Auswahl kann gefahrlos erneut bestätigt werden; sie wird nicht doppelt angelegt.
        </p>
      )}
      {eligible.length === 0 ? (
        <p className="work-queue__sub">Auf dieser Seite gibt es kein aktuell geeignetes Angebot.</p>
      ) : (
        <ul className="work-queue__choices">
          {eligible.map((offer) => {
            const name = `${offer.employee.firstName} ${offer.employee.lastName}`;
            const chosen = (decision.phase === 'confirm' || decision.phase === 'pending' || decision.phase === 'retry') && decision.offer.id === offer.id;
            return (
              <li key={offer.id}>
                <p>
                  {name} <span className="work-queue__sub">Personalnummer {offer.employee.employeeCode}</span>
                </p>
                {chosen ? (
                  <div role="group" aria-label={`Auswahl bestätigen: ${name}`}>
                    <p>
                      Der Dienst wird auf {name} übertragen. Dieses Angebot wird angenommen; alle anderen offenen Angebote werden
                      abgelehnt.
                    </p>
                    {decision.phase === 'retry' ? (
                      <button type="button" className="work-queue__button" onClick={() => submit(offer, decision.key)}>
                        Erneut bestätigen
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="work-queue__button"
                        disabled={busy}
                        onClick={() => submit(offer, decision.key)}
                      >
                        Ersatz bestätigen
                      </button>
                    )}{' '}
                    <button
                      type="button"
                      className="work-queue__button"
                      disabled={busy}
                      onClick={() => onDecision({ phase: 'idle' })}
                    >
                      Abbrechen
                    </button>
                    {decision.phase === 'pending' && <p role="status">Auswahl wird gespeichert …</p>}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="work-queue__button"
                    disabled={busy}
                    onClick={() => onDecision({ phase: 'confirm', offer, key: globalThis.crypto.randomUUID() })}
                  >
                    Ersatz auswählen
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pagination.totalPages > 1 && (
        <p className="work-queue__sub">Angebote auf anderen Seiten werden hier nicht zur Auswahl angeboten.</p>
      )}
    </section>
  );
}
