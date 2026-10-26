import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import type { AppRoute } from '../../app/routes';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import {
  ACCOUNT_STATUS,
  EMPLOYEE_STATUS,
  SHIFT_ELIGIBILITY_LABELS,
  fullName,
  type EmployeeListQuery,
  type EmployeePage,
  type EmployeeStatus,
} from './employee-types';
import { listQuerySearch as toSearch, parseListQuery, type EmployeesApi } from './employees-api';

const STATUS_FILTERS: ReadonlyArray<{ value: EmployeeStatus | ''; label: string }> = [
  { value: '', label: 'Alle' },
  { value: 'ACTIVE', label: 'Aktiv' },
  { value: 'INACTIVE', label: 'Deaktiviert' },
];

export function EmployeesListPage({ route, employees }: { route: AppRoute; employees: EmployeesApi }) {
  const [params, setParams] = useSearchParams();
  const query = parseListQuery(params);
  const key = toSearch(query); // primitive, so useReadSource reloads only on a real change
  const source = useMemo<ReadSource<string, EmployeePage>>(
    () => ({
      kind: 'api',
      load: (search, signal) => employees.list(parseListQuery(new URLSearchParams(search)), signal),
    }),
    [employees],
  );
  const { state, retry } = useReadSource(source, key);
  const filtered = Boolean(query.q || query.status);

  function navigate(next: EmployeeListQuery) {
    setParams(new URLSearchParams(toSearch(next)));
  }

  return (
    <PageFrame title={route.title} lead={route.lead}>
      <div className="employees">
        <div className="employees__toolbar">
          <SearchForm key={query.q ?? ''} initial={query.q ?? ''} onSearch={(q) => navigate({ ...query, q, page: undefined })} />
          <Link className="employees-button employees-button--primary" to={`${route.path}/neu`}>
            Mitarbeiter:in anlegen
          </Link>
        </div>
        <StatusFilter value={query.status ?? ''} onChange={(status) => navigate({ ...query, status, page: undefined })} />

        {state.status === 'loading' ? (
          <LoadingState label="Mitarbeitende werden geladen …" />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : state.data.pagination.totalItems === 0 && !filtered ? (
          <EmptyState
            title="Noch keine Mitarbeitenden"
            description="Legen Sie die erste Person an. Sie erhält danach eine Einladung zur Aktivierung ihres Kontos."
          />
        ) : state.data.pagination.totalItems === 0 ? (
          <div className="employees__no-results">
            <EmptyState title="Keine Treffer" description="Für diese Suche oder diesen Filter gibt es keine Mitarbeitenden." />
            <button type="button" className="employees-button" onClick={() => navigate({})}>
              Suche und Filter zurücksetzen
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
          <EmployeeTable page={state.data} basePath={route.path} onPage={(page) => navigate({ ...query, page })} />
        )}
      </div>
    </PageFrame>
  );
}

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (q: string | undefined) => void }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = draft.trim();
    if (q.length === 1 || q.length > 100) {
      setError(q.length === 1 ? 'Bitte mindestens 2 Zeichen eingeben.' : 'Bitte höchstens 100 Zeichen eingeben.');
      return;
    }
    setError(null);
    onSearch(q || undefined);
  }

  return (
    <form className="employees__search" role="search" noValidate onSubmit={submit}>
      <label htmlFor={inputId}>Suche nach Name oder Mitarbeiter-ID</label>
      <div className="employees__search-row">
        <input
          id={inputId}
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
        />
        <button type="submit" className="employees-button">Suchen</button>
      </div>
      {error && <p id={`${inputId}-error`} className="employee-form__error">{error}</p>}
    </form>
  );
}

function StatusFilter({ value, onChange }: { value: EmployeeStatus | ''; onChange: (status: EmployeeStatus | undefined) => void }) {
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

function EmployeeTable({ page, basePath, onPage }: { page: EmployeePage; basePath: string; onPage: (page: number) => void }) {
  const { pagination } = page;
  const captionId = useId();
  return (
    <>
      <p className="employees__count" aria-live="polite">
        {pagination.totalItems === 1 ? '1 Mitarbeiter:in' : `${pagination.totalItems} Mitarbeitende`}
        {pagination.totalPages > 1 && ` · Seite ${pagination.page} von ${pagination.totalPages}`}
      </p>
      <div className="employees-table__wrap">
        <table className="employees-table" aria-labelledby={captionId}>
          <caption id={captionId}>Mitarbeitende</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Mitarbeiter-ID</th>
              <th scope="col">Schicht-Eignung</th>
              <th scope="col">Status</th>
              <th scope="col">Konto</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((employee) => (
              <tr key={employee.id}>
                <th scope="row">
                  <Link to={`${basePath}/${employee.id}`}>{fullName(employee)}</Link>
                </th>
                <td data-label="Mitarbeiter-ID">{employee.employeeCode}</td>
                <td data-label="Schicht-Eignung">{SHIFT_ELIGIBILITY_LABELS[employee.shiftEligibility]}</td>
                <td data-label="Status">
                  <StatusBadge tone={EMPLOYEE_STATUS[employee.status].tone}>{EMPLOYEE_STATUS[employee.status].label}</StatusBadge>
                </td>
                <td data-label="Konto">
                  <StatusBadge tone={ACCOUNT_STATUS[employee.accountStatus].tone}>
                    {ACCOUNT_STATUS[employee.accountStatus].label}
                  </StatusBadge>
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
