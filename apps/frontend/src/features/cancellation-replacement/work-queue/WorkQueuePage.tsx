import { useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageFrame } from '../../../app/PageFrame';
import type { AppRoute } from '../../../app/routes';
import { ApiError } from '../../../shared/api/api-error';
import type { ReadSource } from '../../../shared/data/data-source';
import { loadAllPages } from '../../../shared/data/load-all-pages';
import { useReadSource, type ReadState } from '../../../shared/data/use-read-source';
import { parsePlanMonth, planDateLabel } from '../../../shared/time/civil-time';
import { ApiErrorAlert } from '../../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import type { ProjectsApi } from '../../projects/projects-api';
import { formatUtc, dutyTimeText } from './work-queue-format';
import { parseQueueQuery, queueSearch, revalidateOnForbidden, type WorkQueueApi } from './work-queue-api';
import {
  CANCELLATION_LABELS,
  CASE_TYPE_LABELS,
  NEED_LABELS,
  SHIFT_LABELS,
  type CaseType,
  type OfferPresence,
  type Pagination,
  type ProjectRef,
  type QueueItem,
  type QueuePage,
  type QueueQuery,
  type QueueSortBy,
  type SortOrder,
} from './work-queue-types';
import './WorkQueue.css';

type Props = {
  route: AppRoute;
  queue: WorkQueueApi;
  projects: ProjectsApi;
  requestSessionRevalidation: () => void;
};

type ListRequest = { query: QueueQuery; revision: number };

const DEFAULT_FILTERS: Pick<QueueQuery, 'type' | 'offerPresence' | 'projectId' | 'month' | 'page'> = {
  type: null,
  offerPresence: null,
  projectId: null,
  month: null,
  page: 1,
};

// Lookup tables map control values back to typed values; no free DOM value reaches the query.
const TYPE_OPTIONS: ReadonlyArray<{ value: CaseType | null; label: string }> = [
  { value: null, label: 'Alle Vorgangsarten' },
  { value: 'CANCELLATION_REQUEST', label: 'Absagen' },
  { value: 'REPLACEMENT_NEED', label: 'Ersatzbedarfe' },
];

const PRESENCE_OPTIONS: ReadonlyArray<{ value: OfferPresence | null; label: string }> = [
  { value: null, label: 'Alle offenen Vorgänge' },
  { value: 'WITH_ELIGIBLE', label: 'Mit aktuell geeigneten Angeboten' },
  { value: 'WITHOUT_ELIGIBLE', label: 'Ohne aktuell geeignete Angebote' },
];

const SORT_OPTIONS: ReadonlyArray<{ value: QueueSortBy; label: string }> = [
  { value: 'createdAt', label: 'Angelegt am' },
  { value: 'dutyDate', label: 'Dienstdatum' },
];

const ORDER_OPTIONS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: 'asc', label: 'Aufsteigend' },
  { value: 'desc', label: 'Absteigend' },
];

function hasFilter(query: QueueQuery): boolean {
  return query.type !== null || query.offerPresence !== null || query.projectId !== null || query.month !== null;
}

function countText(total: number): string {
  return total === 1 ? '1 Vorgang' : `${total} Vorgänge`;
}

/**
 * Admin landing `/arbeitsuebersicht`: open cancellation and replacement cases from
 * the server. Filters, sorting and pages are URL state and are applied by the
 * server; the list is never assembled or filtered in the browser.
 */
export function WorkQueuePage({ route, queue, projects, requestSessionRevalidation }: Props) {
  const [params, setParams] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const search = queueSearch(parseQueueQuery(params));
  const query = useMemo(() => parseQueueQuery(new URLSearchParams(search)), [search]);
  const request = useMemo<ListRequest>(() => ({ query, revision }), [query, revision]);

  const source = useMemo<ReadSource<ListRequest, QueuePage>>(
    () => ({
      kind: 'api',
      async load(current, signal) {
        try {
          return await queue.queue(current.query, signal);
        } catch (error) {
          if (!signal.aborted) revalidateOnForbidden(error, requestSessionRevalidation);
          throw error;
        }
      },
    }),
    [queue, requestSessionRevalidation],
  );
  const { state, retry } = useReadSource(source, request);

  const projectSource = useMemo<ReadSource<null, ProjectRef[]>>(
    () => ({
      kind: 'api',
      async load(_query, signal) {
        const items = await loadAllPages((page) => projects.list({ page, pageSize: 100 }, signal));
        return items
          .map((project) => ({ id: project.id, name: project.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      },
    }),
    [projects],
  );
  const projectState = useReadSource(projectSource, null);

  function navigateTo(next: QueueQuery) {
    setParams(new URLSearchParams(queueSearch(next)));
  }

  return (
    <PageFrame title={route.title} lead={route.lead}>
      <div className="work-queue">
        <QueueFilters
          query={query}
          projectsState={projectState.state}
          onChange={navigateTo}
          onRefresh={() => setRevision((current) => current + 1)}
        />
        <p className="work-queue__legend">
          Offene Angebote sind alle eingereichten Angebote, die noch offen sind. Aktuell geeignet ist davon nur der Teil,
          der die aktuellen Kriterien für ein neues Ersatzangebot erfüllt. Das ist keine Auswahl und keine Zuweisung.
        </p>
        {state.status === 'loading' ? (
          <LoadingState label="Offene Vorgänge werden geladen …" />
        ) : state.status === 'error' ? (
          <QueueError error={state.error} query={query} retry={retry} onResetProject={() => navigateTo({ ...query, projectId: null, page: 1 })} />
        ) : state.data.pagination.totalItems === 0 ? (
          hasFilter(query) ? (
            <EmptyState title="Keine Vorgänge für diese Auswahl" description="Entfernen Sie einen Filter oben, um weitere Vorgänge zu sehen." />
          ) : (
            <EmptyState
              title="Keine offenen Vorgänge"
              description="Aktuell gibt es keine offenen Absage- oder Ersatzvorgänge."
            />
          )
        ) : state.data.items.length === 0 ? (
          <div className="work-queue__empty">
            <EmptyState title="Diese Seite ist leer" description="Die angeforderte Seite enthält keine Vorgänge mehr." />
            <button type="button" className="work-queue__button" onClick={() => navigateTo({ ...query, page: 1 })}>
              Zur ersten Seite
            </button>
          </div>
        ) : (
          <QueueTable
            page={state.data}
            backPath={`${route.path}${search ? `?${search}` : ''}`}
            caseBasePath={route.path}
            onPage={(page) => navigateTo({ ...query, page })}
          />
        )}
      </div>
    </PageFrame>
  );
}

function QueueError({
  error,
  query,
  retry,
  onResetProject,
}: {
  error: Error;
  query: QueueQuery;
  retry: () => void;
  onResetProject: () => void;
}) {
  // The server answers an unknown or hidden project filter with 404 (no tenant detail is revealed).
  if (query.projectId !== null && error instanceof ApiError && error.status === 404) {
    return (
      <div className="work-queue__error">
        <ApiErrorAlert
          error={error}
          text={{
            title: 'Projekt nicht verfügbar',
            description: 'Das gewählte Projekt ist für Ihr Unternehmen nicht verfügbar. Wählen Sie ein anderes Projekt.',
          }}
        />
        <button type="button" className="work-queue__button" onClick={onResetProject}>
          Projektfilter entfernen
        </button>
      </div>
    );
  }
  return (
    <div className="work-queue__error">
      <ErrorState error={error} onRetry={retry} />
    </div>
  );
}

function QueueFilters({
  query,
  projectsState,
  onChange,
  onRefresh,
}: {
  query: QueueQuery;
  projectsState: ReadState<ProjectRef[]>;
  onChange: (next: QueueQuery) => void;
  onRefresh: () => void;
}) {
  const presenceName = useId();
  const typeId = useId();
  const projectId = useId();
  const monthId = useId();
  const sortId = useId();
  const orderId = useId();
  const loadedProjects = projectsState.status === 'ready' ? projectsState.data : [];
  // A project filter from the URL stays visible while the list loads or after it failed; the server still applies it.
  const projectOptions =
    query.projectId !== null && !loadedProjects.some((project) => project.id === query.projectId)
      ? [{ id: query.projectId, name: 'Ausgewähltes Projekt' }, ...loadedProjects]
      : loadedProjects;

  return (
    <section className="work-queue__filters" aria-label="Filter und Sortierung">
      <fieldset className="work-queue__presence">
        <legend>Ersatzangebote</legend>
        {PRESENCE_OPTIONS.map((option) => (
          <label key={option.label}>
            <input
              type="radio"
              name={presenceName}
              checked={query.offerPresence === option.value}
              onChange={() => onChange({ ...query, offerPresence: option.value, page: 1 })}
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <div className="work-queue__controls">
        <label htmlFor={typeId}>
          Vorgangsart
          <select
            id={typeId}
            value={query.type ?? ''}
            onChange={(event) => {
              const next = TYPE_OPTIONS.find((option) => (option.value ?? '') === event.target.value);
              onChange({ ...query, type: next?.value ?? null, page: 1 });
            }}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.label} value={option.value ?? ''}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor={projectId}>
          Projekt
          <select
            id={projectId}
            value={query.projectId ?? ''}
            disabled={projectsState.status === 'error'}
            onChange={(event) => {
              const next = projectOptions.find((project) => project.id === event.target.value);
              onChange({ ...query, projectId: next?.id ?? null, page: 1 });
            }}
          >
            <option value="">Alle Projekte</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {projectsState.status === 'error' && (
          <p className="work-queue__hint" role="status">
            Die Projektliste konnte nicht geladen werden. Der Projektfilter ist deshalb nicht verfügbar.
          </p>
        )}

        <label htmlFor={monthId}>
          Dienstmonat
          <input
            id={monthId}
            type="month"
            min="0001-01"
            max="9999-12"
            value={query.month ?? ''}
            onChange={(event) => onChange({ ...query, month: parsePlanMonth(event.target.value), page: 1 })}
          />
        </label>

        <label htmlFor={sortId}>
          Sortieren nach
          <select
            id={sortId}
            value={query.sortBy}
            onChange={(event) => {
              const next = SORT_OPTIONS.find((option) => option.value === event.target.value);
              onChange({ ...query, sortBy: next?.value ?? 'createdAt', page: 1 });
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor={orderId}>
          Reihenfolge
          <select
            id={orderId}
            value={query.sortOrder}
            onChange={(event) => {
              const next = ORDER_OPTIONS.find((option) => option.value === event.target.value);
              onChange({ ...query, sortOrder: next?.value ?? 'asc', page: 1 });
            }}
          >
            {ORDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="work-queue__actions">
        <button type="button" className="work-queue__button" onClick={onRefresh}>
          Liste aktualisieren
        </button>
        {hasFilter(query) && (
          <button type="button" className="work-queue__button" onClick={() => onChange({ ...query, ...DEFAULT_FILTERS })}>
            Filter zurücksetzen
          </button>
        )}
      </div>
    </section>
  );
}

function QueueTable({
  page,
  backPath,
  caseBasePath,
  onPage,
}: {
  page: QueuePage;
  backPath: string;
  caseBasePath: string;
  onPage: (page: number) => void;
}) {
  const captionId = useId();
  const { pagination } = page;
  return (
    <>
      <p className="work-queue__summary" aria-live="polite">
        {countText(pagination.totalItems)}
        {pagination.totalPages > 1 && ` · Seite ${pagination.page} von ${pagination.totalPages}`}
        <span className="work-queue__evaluated"> · Stand der Auswertung: {formatUtc(page.evaluatedAt)}</span>
      </p>
      <div className="work-queue__table-wrap">
        <table className="work-queue__table" aria-labelledby={captionId}>
          <caption id={captionId}>Offene Absagen und Ersatzbedarfe</caption>
          <thead>
            <tr>
              <th scope="col">Mitarbeitende</th>
              <th scope="col">Projekt</th>
              <th scope="col">Dienst</th>
              <th scope="col">Vorgang</th>
              <th scope="col">Absage</th>
              <th scope="col">Ersatzbedarf</th>
              <th scope="col">Offene Angebote</th>
              <th scope="col">Aktuell geeignet</th>
              <th scope="col">Angelegt</th>
              <th scope="col">
                <span className="visually-hidden">Aktion</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <QueueRow key={item.replacementNeedId} item={item} backPath={backPath} caseBasePath={caseBasePath} />
            ))}
          </tbody>
        </table>
      </div>
      <QueuePager pagination={pagination} onPage={onPage} />
    </>
  );
}

function QueueRow({ item, backPath, caseBasePath }: { item: QueueItem; backPath: string; caseBasePath: string }) {
  const employee = item.requestingEmployee;
  const name = `${employee.firstName} ${employee.lastName}`;
  const cancellation = CANCELLATION_LABELS[item.cancellationStatus];
  const need = NEED_LABELS[item.replacementNeedStatus];
  return (
    <tr>
      <th scope="row">
        <span className="work-queue__name">{name}</span>
        <span className="work-queue__sub">Personalnummer {employee.employeeCode}</span>
      </th>
      <td data-label="Projekt">{item.project.name}</td>
      <td data-label="Dienst">
        <span className="work-queue__name">{planDateLabel(item.duty.dutyDate)}</span>
        <span className="work-queue__sub">
          {SHIFT_LABELS[item.duty.shiftKind]} · {dutyTimeText(item.duty, item.timeZone)}
        </span>
        <span className="work-queue__sub">Zeitzone {item.timeZone}</span>
      </td>
      <td data-label="Vorgang">{CASE_TYPE_LABELS[item.type]}</td>
      <td data-label="Absage">
        <StatusBadge tone={cancellation.tone}>{cancellation.label}</StatusBadge>
      </td>
      <td data-label="Ersatzbedarf">
        <StatusBadge tone={need.tone}>{need.label}</StatusBadge>
      </td>
      <td data-label="Offene Angebote" className="work-queue__number">
        {item.openOfferCount}
      </td>
      <td data-label="Aktuell geeignet" className="work-queue__number">
        {item.eligibleOpenOfferCount}
      </td>
      <td data-label="Angelegt">{formatUtc(item.createdAt)}</td>
      <td className="work-queue__action">
        <Link to={`${caseBasePath}/${item.replacementNeedId}`} state={{ back: backPath }} aria-label={`Vorgang öffnen für ${name}`}>
          Vorgang öffnen
        </Link>
      </td>
    </tr>
  );
}

function QueuePager({ pagination, onPage }: { pagination: Pagination; onPage: (page: number) => void }) {
  if (pagination.totalPages <= 1) return null;
  return (
    <nav className="work-queue__pager" aria-label="Seiten">
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
