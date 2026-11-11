import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
 * context and the offer page from one server snapshot. Writes start only from an
 * explicit, confirmed action (SP-20 selection, SP-21 REJECT / APPROVE without
 * replacement) and never change the displayed data optimistically.
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
    <PageFrame title="Vorgang prüfen" lead="Offene Vorgänge prüfen. Eine Absage kann abgelehnt oder ohne Ersatz genehmigt werden, oder ein geeignetes Angebot wird ausgewählt; jede Entscheidung wird serverseitig geprüft.">
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

      <DecisionPanel
        queue={queue}
        needId={needId}
        context={context}
        decision={decision}
        onDecision={onDecision}
        onRefresh={onRefresh}
      />

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

/**
 * Administrative actions on one case: SP-20 offer selection and SP-21 REJECT / APPROVE without replacement.
 * One state for both, so at most one write is in flight per case and an uncertain write blocks every other action.
 * Versions and the Idempotency-Key are captured when the administrator opens the confirmation and are sent
 * unchanged, also on an explicit retry. The server re-checks every precondition under its locks.
 */
type Intent =
  | { kind: 'select'; offer: AdminOffer; needVersion: number }
  | { kind: 'reject'; requestId: string }
  | { kind: 'approve'; requestId: string; needVersion: number; dutyVersion: number };
type IntentKind = Intent['kind'];

type Decision =
  | { phase: 'idle' }
  | { phase: 'confirm' | 'pending' | 'retry'; intent: Intent; key: string }
  | { phase: 'done' | 'refused'; kind: IntentKind; message: string };

/** A write is in flight or its outcome is unknown: no other action may start. */
function isLocked(decision: Decision): boolean {
  return decision.phase === 'pending' || decision.phase === 'retry';
}

/** German text per refusal code (the closed catalogue; anything else gets the generic text). */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  CANCELLATION_ALREADY_RESOLVED: 'Dieser Vorgang ist bereits entschieden.',
  REPLACEMENT_NEED_NOT_OPEN: 'Dieser Ersatzbedarf ist nicht mehr offen.',
  PLAN_CONCURRENT_MODIFICATION: 'Der Vorgang wurde inzwischen geändert.',
  REPLACEMENT_OFFER_NOT_SELECTABLE: 'Dieses Angebot kann nicht mehr ausgewählt werden.',
  REPLACEMENT_CANDIDATE_INELIGIBLE: 'Die Person ist für diesen Dienst nicht mehr geeignet.',
  REPLACEMENT_CANDIDATE_UNAVAILABLE: 'Die Person ist in diesem Zeitraum nicht verfügbar.',
  CANCELLATION_PLAN_CHANGED: 'Der Dienst oder der Plan wurde inzwischen geändert.',
  CANCELLATION_ASSIGNMENT_NOT_ACTIVE: 'Die ursprüngliche Zuordnung ist nicht mehr aktiv.',
  RESOURCE_EDIT_LOCKED: 'Der Dienst wird gerade im Plan bearbeitet. Versuchen Sie es in einer Minute erneut.',
  ACTION_FORBIDDEN: 'Für diese Aktion fehlt die Berechtigung.',
};

function refusalText(error: ApiError, kind: IntentKind): string {
  return REFUSAL_TEXT[error.code ?? ''] ?? (kind === 'select' ? 'Die Auswahl wurde nicht angenommen.' : 'Die Entscheidung wurde nicht angenommen.');
}

const DONE_TEXT: Record<'select' | 'REJECT' | 'APPROVE', string> = {
  select: 'Ersatz ausgewählt. Der Vorgang ist abgeschlossen.',
  REJECT: 'Absage abgelehnt. Die ursprüngliche Zuordnung bleibt aktiv; der Ersatzbedarf ist geschlossen.',
  APPROVE: 'Absage ohne Ersatz genehmigt. Die ursprüngliche Zuordnung wurde entfernt; der Ersatzbedarf bleibt unbesetzt sichtbar.',
};

/** Runs one confirmed intent with its captured key and versions, and maps the answer to the next state. */
function caseAction(queue: WorkQueueApi, needId: string, onDecision: (next: Decision) => void, onRefresh: () => void) {
  return async function run(intent: Intent, key: string) {
    onDecision({ phase: 'pending', intent, key });
    try {
      let message: string;
      if (intent.kind === 'select') {
        await queue.select(needId, { offerId: intent.offer.id, expectedVersion: intent.needVersion, idempotencyKey: key });
        message = DONE_TEXT.select;
      } else {
        // Only a strictly validated receipt for exactly this command counts as success.
        const receipt = await queue.decide(
          { requestId: intent.requestId, needId },
          intent.kind === 'reject'
            ? { decision: 'REJECT', idempotencyKey: key }
            : { decision: 'APPROVE', expectedNeedVersion: intent.needVersion, expectedDutyVersion: intent.dutyVersion, idempotencyKey: key },
        );
        message = DONE_TEXT[receipt.decision];
      }
      onDecision({ phase: 'done', kind: intent.kind, message });
      onRefresh();
    } catch (error) {
      const http = error instanceof ApiError && error.kind === 'http' && error.code !== 'IDEMPOTENCY_REQUEST_IN_PROGRESS' ? error : null;
      if (http && (http.status === 409 || http.status === 404)) {
        // Terminal for this intent: the stale confirmation closes and the server state is reloaded.
        const reason = http.status === 404 ? 'Dieser Vorgang ist nicht mehr sichtbar.' : refusalText(http, intent.kind);
        onDecision({ phase: 'refused', kind: intent.kind, message: `${reason} Die Daten wurden neu geladen.` });
        onRefresh();
      } else if (http && http.status !== null && http.status >= 400 && http.status < 500) {
        // Refused before any business write (400/401/403/...). No reload loop; 401 is handled by the session.
        onDecision({
          phase: 'refused',
          kind: intent.kind,
          message: `${refusalText(http, intent.kind)} Laden Sie den Vorgang neu, bevor Sie es erneut versuchen.`,
        });
      } else {
        // Unknown outcome (network, 5xx, still in progress or an unreadable answer): keep intent, key and versions,
        // so that only an explicit retry of the very same command is possible.
        onDecision({ phase: 'retry', intent, key });
      }
    }
  };
}

function Messages({ decision, kinds }: { decision: Decision; kinds: readonly IntentKind[] }) {
  if ((decision.phase === 'done' || decision.phase === 'refused') && kinds.includes(decision.kind))
    return decision.phase === 'done' ? (
      <p className="work-queue__notice" role="status">
        {decision.message}
      </p>
    ) : (
      <p className="work-queue__error-text" role="alert">
        {decision.message}
      </p>
    );
  if (decision.phase === 'retry' && kinds.includes(decision.intent.kind))
    return (
      <p className="work-queue__error-text" role="alert">
        Das Ergebnis ist nicht bestätigt. Senden Sie denselben Auftrag erneut; er wird nicht doppelt ausgeführt. Andere Aktionen
        sind bis dahin gesperrt.
      </p>
    );
  return null;
}

/**
 * SP-20 administrative selection: choose one eligible offer, confirm, then submit. A disabled button is only a
 * presentation; the server enforces concurrency. A refused answer reloads the case; an unknown outcome keeps
 * the same Idempotency-Key and need version, so a retry replays the decision instead of making a second one.
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
  const run = caseAction(queue, needId, onDecision, onRefresh);
  const { context, items, pagination } = page;
  const open = context.cancellation.status === 'OPEN' && context.need.status === 'OPEN';
  const eligible = items.filter((offer) => offer.status === 'OPEN' && offer.reviewEligibility === 'ELIGIBLE');
  const locked = isLocked(decision);
  const busy = decision.phase === 'pending';
  const active = 'intent' in decision && decision.intent.kind === 'select' ? { ...decision, intent: decision.intent } : null;
  const uncertain = active !== null && active.phase === 'retry';

  if (!open || (uncertain && !eligible.some((offer) => offer.id === active.intent.offer.id))) {
    // Not open any more, or the uncertain offer is not listed: show this session's outcome and, for an uncertain
    // write, only the retry of that same command.
    const outcome = (decision.phase === 'done' || decision.phase === 'refused') && decision.kind === 'select';
    if (!outcome && !uncertain) return null;
    return (
      <section className="work-queue__section" aria-labelledby={headingId}>
        <h2 id={headingId}>Ersatz auswählen</h2>
        <Messages decision={decision} kinds={['select']} />
        {uncertain && (
          <button type="button" className="work-queue__button" onClick={() => run(active.intent, active.key)}>
            Erneut bestätigen
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="work-queue__section" aria-labelledby={headingId} aria-busy={busy || undefined}>
      <h2 id={headingId}>Ersatz auswählen</h2>
      <Messages decision={decision} kinds={['select']} />
      {eligible.length === 0 ? (
        <p className="work-queue__sub">Auf dieser Seite gibt es kein aktuell geeignetes Angebot.</p>
      ) : (
        <ul className="work-queue__choices">
          {eligible.map((offer) => {
            const name = `${offer.employee.firstName} ${offer.employee.lastName}`;
            const chosen = active !== null && active.intent.offer.id === offer.id ? active : null;
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
                    {chosen.phase === 'retry' ? (
                      <button type="button" className="work-queue__button" onClick={() => run(chosen.intent, chosen.key)}>
                        Erneut bestätigen
                      </button>
                    ) : (
                      <button type="button" className="work-queue__button" disabled={busy} onClick={() => run(chosen.intent, chosen.key)}>
                        Ersatz bestätigen
                      </button>
                    )}{' '}
                    <button type="button" className="work-queue__button" disabled={locked} onClick={() => onDecision({ phase: 'idle' })}>
                      Abbrechen
                    </button>
                    {chosen.phase === 'pending' && <p role="status">Auswahl wird gespeichert …</p>}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="work-queue__button"
                    disabled={locked}
                    onClick={() =>
                      onDecision({
                        phase: 'confirm',
                        intent: { kind: 'select', offer, needVersion: context.need.concurrencyVersion },
                        key: globalThis.crypto.randomUUID(),
                      })
                    }
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

/** Whether a REJECT or an APPROVE without replacement may be offered: an open, consistent, current case only. */
function isDecidable(context: CaseContext): boolean {
  return (
    context.cancellation.status === 'OPEN' &&
    context.need.status === 'OPEN' &&
    context.consistency === 'CONSISTENT' &&
    context.originalAssignmentActive &&
    !context.dutyRemoved
  );
}

const DECISION_COPY = {
  reject: {
    open: 'Ablehnen',
    title: 'Absage ablehnen?',
    confirm: 'Ablehnung bestätigen',
    pending: 'Ablehnung wird gespeichert …',
    effect:
      'Die Absage wird abgelehnt. Die ursprüngliche Zuordnung bleibt aktiv; die Person bleibt im Dienst eingetragen. Der Ersatzbedarf wird geschlossen.',
  },
  approve: {
    open: 'Ohne Ersatz genehmigen',
    title: 'Absage ohne Ersatz genehmigen?',
    confirm: 'Genehmigung ohne Ersatz bestätigen',
    pending: 'Genehmigung wird gespeichert …',
    effect:
      'Die Absage wird genehmigt, ohne einen Ersatz auszuwählen. Die ursprüngliche Zuordnung wird entfernt. Der Dienst bleibt veröffentlicht, und der Ersatzbedarf bleibt als „Unbesetzt“ in der Arbeitsübersicht sichtbar.',
  },
} as const;

type DecisionKind = keyof typeof DECISION_COPY;

/**
 * SP-21: REJECT or APPROVE without replacement for an open case. Both finalize every open offer as
 * „Nicht ausgewählt“; neither selects a replacement. Confirmation is required; Escape or „Abbrechen“ closes it
 * without any request and returns focus to the button that opened it.
 */
function DecisionPanel({
  queue,
  needId,
  context,
  decision,
  onDecision,
  onRefresh,
}: {
  queue: WorkQueueApi;
  needId: string;
  context: CaseContext;
  decision: Decision;
  onDecision: (next: Decision) => void;
  onRefresh: () => void;
}) {
  const headingId = useId();
  const confirmHeadingId = useId();
  const run = caseAction(queue, needId, onDecision, onRefresh);
  const openers = useRef<Partial<Record<DecisionKind, HTMLButtonElement | null>>>({});
  const confirmHeading = useRef<HTMLHeadingElement | null>(null);
  const returnFocus = useRef<DecisionKind | null>(null);
  const active =
    'intent' in decision && decision.intent.kind !== 'select' ? { phase: decision.phase, key: decision.key, intent: decision.intent } : null;
  const locked = isLocked(decision);
  const busy = decision.phase === 'pending';
  const decidable = isDecidable(context);
  const confirmingKind = active?.phase === 'confirm' ? active.intent.kind : null;

  useEffect(() => {
    if (confirmingKind) confirmHeading.current?.focus();
  }, [confirmingKind]);
  const hasActive = active !== null;
  useEffect(() => {
    // After Cancel, the opener is rendered again: give it the focus back.
    if (!hasActive && returnFocus.current) {
      openers.current[returnFocus.current]?.focus();
      returnFocus.current = null;
    }
  }, [hasActive]);

  function start(kind: DecisionKind) {
    const requestId = context.cancellation.id;
    onDecision({
      phase: 'confirm',
      // Captured now from the server read; never reused across intents and never guessed.
      intent:
        kind === 'reject'
          ? { kind, requestId }
          : { kind, requestId, needVersion: context.need.concurrencyVersion, dutyVersion: context.need.dutyConcurrencyVersion },
      key: globalThis.crypto.randomUUID(),
    });
  }

  function cancel(kind: DecisionKind) {
    returnFocus.current = kind;
    onDecision({ phase: 'idle' });
  }

  const outcome = (decision.phase === 'done' || decision.phase === 'refused') && decision.kind !== 'select';
  const uncertain = active?.phase === 'retry';
  if (!decidable && !outcome && !uncertain) return null;

  return (
    <section className="work-queue__section" aria-labelledby={headingId} aria-busy={busy || undefined}>
      <h2 id={headingId}>Absage ohne Ersatz entscheiden</h2>
      <Messages decision={decision} kinds={['reject', 'approve']} />
      {decidable && (
        <p className="work-queue__legend">
          Beide Entscheidungen setzen alle offenen Ersatzangebote auf „Nicht ausgewählt“, auch wenn geeignete Angebote vorliegen. Um
          einen Ersatz zu übernehmen, wählen Sie stattdessen ein Angebot unter „Ersatz auswählen“.
        </p>
      )}
      {decidable && !active && (
        <div className="work-queue__controls">
          {(['reject', 'approve'] as const).map((kind) => (
            <button
              key={kind}
              ref={(element) => {
                openers.current[kind] = element;
              }}
              type="button"
              className="work-queue__button"
              disabled={locked}
              onClick={() => start(kind)}
            >
              {DECISION_COPY[kind].open}
            </button>
          ))}
        </div>
      )}
      {active && (decidable || uncertain) && (
        <div
          role="group"
          aria-labelledby={confirmHeadingId}
          className="work-queue__confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && active.phase === 'confirm') {
              event.preventDefault();
              cancel(active.intent.kind);
            }
          }}
        >
          <h3 id={confirmHeadingId} ref={confirmHeading} tabIndex={-1}>
            {DECISION_COPY[active.intent.kind].title}
          </h3>
          <p>{DECISION_COPY[active.intent.kind].effect}</p>
          <p>
            Offene Angebote, die auf „Nicht ausgewählt“ gesetzt werden: {context.need.openOfferCount}
            {context.eligibleOpenOfferCount > 0 && ` (davon aktuell geeignet: ${context.eligibleOpenOfferCount})`}
          </p>
          {active.phase === 'retry' ? (
            <button type="button" className="work-queue__button" onClick={() => run(active.intent, active.key)}>
              Erneut bestätigen
            </button>
          ) : (
            <button type="button" className="work-queue__button" disabled={busy} onClick={() => run(active.intent, active.key)}>
              {DECISION_COPY[active.intent.kind].confirm}
            </button>
          )}{' '}
          <button type="button" className="work-queue__button" disabled={locked} onClick={() => cancel(active.intent.kind)}>
            Abbrechen
          </button>
          {busy && <p role="status">{DECISION_COPY[active.intent.kind].pending}</p>}
        </div>
      )}
    </section>
  );
}
