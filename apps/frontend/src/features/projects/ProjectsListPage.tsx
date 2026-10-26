import { useId, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import type { AppRoute } from '../../app/routes';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import { PROJECT_STATUS, type ProjectListQuery, type ProjectPage, type ProjectStatus } from './project-types';
import { parseProjectListQuery, projectListSearch, type ProjectsApi } from './projects-api';

const STATUS_FILTERS: ReadonlyArray<{ value: ProjectStatus | ''; label: string }> = [
  { value: '', label: 'Alle' },
  { value: 'ACTIVE', label: 'Aktiv' },
  { value: 'INACTIVE', label: 'Inaktiv' },
];

export function ProjectsListPage({ route, projects }: { route: AppRoute; projects: ProjectsApi }) {
  const [params, setParams] = useSearchParams();
  const query = parseProjectListQuery(params);
  const key = projectListSearch(query); // primitive, so useReadSource reloads only on a real change
  const source = useMemo<ReadSource<string, ProjectPage>>(
    () => ({
      kind: 'api',
      load: (search, signal) => projects.list(parseProjectListQuery(new URLSearchParams(search)), signal),
    }),
    [projects],
  );
  const { state, retry } = useReadSource(source, key);

  function navigate(next: ProjectListQuery) {
    setParams(new URLSearchParams(projectListSearch(next)));
  }

  return (
    <PageFrame title={route.title} lead={route.lead}>
      <div className="employees">
        <div className="employees__toolbar">
          <StatusFilter value={query.status ?? ''} onChange={(status) => navigate({ status, page: undefined })} />
          <Link className="employees-button employees-button--primary" to={`${route.path}/neu`}>
            Projekt anlegen
          </Link>
        </div>

        {state.status === 'loading' ? (
          <LoadingState label="Projekte werden geladen …" />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : state.data.pagination.totalItems === 0 && !query.status ? (
          <EmptyState
            title="Noch keine Projekte"
            description="Legen Sie das erste Projekt an. Danach können Sie Mitarbeitende monatsweise zuordnen."
          />
        ) : state.data.pagination.totalItems === 0 ? (
          <div className="employees__no-results">
            <EmptyState title="Keine Treffer" description="Für diesen Filter gibt es keine Projekte." />
            <button type="button" className="employees-button" onClick={() => navigate({})}>
              Filter zurücksetzen
            </button>
          </div>
        ) : state.data.items.length === 0 ? (
          <div className="employees__no-results">
            <EmptyState title="Diese Seite ist leer" description="Die angeforderte Seite enthält keine Einträge." />
            <button type="button" className="employees-button" onClick={() => navigate({ ...query, page: undefined })}>
              Zur ersten Seite
            </button>
          </div>
        ) : (
          <ProjectTable page={state.data} basePath={route.path} onPage={(page) => navigate({ ...query, page })} />
        )}
      </div>
    </PageFrame>
  );
}

function StatusFilter({ value, onChange }: { value: ProjectStatus | ''; onChange: (status: ProjectStatus | undefined) => void }) {
  const name = useId();
  return (
    <fieldset className="employees__filter">
      <legend>Status</legend>
      {STATUS_FILTERS.map((option) => (
        <label key={option.label}>
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value || undefined)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function ProjectTable({ page, basePath, onPage }: { page: ProjectPage; basePath: string; onPage: (page: number) => void }) {
  const { pagination } = page;
  const captionId = useId();
  return (
    <>
      <p className="employees__count" aria-live="polite">
        {pagination.totalItems === 1 ? '1 Projekt' : `${pagination.totalItems} Projekte`}
        {pagination.totalPages > 1 && ` · Seite ${pagination.page} von ${pagination.totalPages}`}
      </p>
      <div className="employees-table__wrap">
        <table className="employees-table" aria-labelledby={captionId}>
          <caption id={captionId}>Projekte</caption>
          <thead>
            <tr>
              <th scope="col">Projekt</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((project) => (
              <tr key={project.id}>
                <th scope="row">
                  <Link to={`${basePath}/${project.id}`}>{project.name}</Link>
                </th>
                <td data-label="Status">
                  <StatusBadge tone={PROJECT_STATUS[project.status].tone}>{PROJECT_STATUS[project.status].label}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagination.totalPages > 1 && (
        <nav className="employees__pagination" aria-label="Seiten">
          <button
            type="button"
            className="employees-button"
            disabled={pagination.page <= 1}
            onClick={() => onPage(pagination.page - 1)}
          >
            Vorherige Seite
          </button>
          <span>Seite {pagination.page} von {pagination.totalPages}</span>
          <button
            type="button"
            className="employees-button"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => onPage(pagination.page + 1)}
          >
            Nächste Seite
          </button>
        </nav>
      )}
    </>
  );
}
