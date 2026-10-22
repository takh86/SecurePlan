// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mitarbeitende"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { deferred, employee, page } from './employees.test-support';
import { renderEmployees } from './employees-render.test-support';

afterEach(() => cleanup());

const mira = employee();
const jonas = employee({
  id: '0b9e3c55-6d3e-4a8e-9a77-5b3f6e1c2d44',
  employeeCode: 'A-002',
  firstName: 'Jonas',
  lastName: 'Albrecht',
  shiftEligibility: 'NIGHT',
  status: 'INACTIVE',
  accountStatus: 'DEACTIVATED',
});

describe('SP-07 — employee list (real API source)', () => {
  it('shows a loading state, then a labelled table with status as text and icon', async () => {
    const response = deferred<unknown>();
    const { requests } = renderEmployees('/mitarbeitende', () => response.promise);
    expect(screen.getByRole('heading', { level: 1, name: 'Mitarbeitende' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Mitarbeitende werden geladen');

    response.resolve(page([jonas, mira]));
    const table = await screen.findByRole('table', { name: 'Mitarbeitende' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Jonas AlbrechtA-002NachtDeaktiviertKonto gesperrt',
      'Mira BeispielA-001Tag und NachtAktivAktivierung ausstehend',
    ]);
    const link = within(rows[1]).getByRole('link', { name: 'Mira Beispiel' });
    expect(link.getAttribute('href')).toBe(`/mitarbeitende/${mira.id}`);
    expect(within(rows[0]).getByText('Deaktiviert').closest('.status-badge')?.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('2 Mitarbeitende')).toBeTruthy();
    expect(requests).toEqual([{ path: '/api/v1/employees', method: 'GET', body: undefined }]);
    // The list itself offers no destructive action.
    expect(screen.queryByRole('button', { name: /deaktivieren/i })).toBeNull();
  });

  it('distinguishes an empty company from a search without results', async () => {
    renderEmployees('/mitarbeitende', () => page([]));
    expect(await screen.findByText('Noch keine Mitarbeitenden')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mitarbeiter:in anlegen' }).getAttribute('href')).toBe('/mitarbeitende/neu');
    cleanup();

    const { requests, location } = renderEmployees('/mitarbeitende?q=zz&status=INACTIVE', (request) =>
      request.path === '/api/v1/employees' ? page([mira]) : page([]));
    expect(await screen.findByText('Keine Treffer')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Suche und Filter zurücksetzen' }));
    expect(await screen.findByRole('link', { name: 'Mira Beispiel' })).toBeTruthy();
    expect(location()).toBe('/mitarbeitende');
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/employees?q=zz&status=INACTIVE',
      '/api/v1/employees',
    ]);
  });

  it('searches with at least 2 characters and keeps the query in the URL', async () => {
    const user = userEvent.setup();
    const { requests, location } = renderEmployees('/mitarbeitende', () => page([mira]));
    await screen.findByRole('table');
    const search = screen.getByRole('searchbox', { name: 'Suche nach Name oder Mitarbeiter-ID' });

    await user.type(search, 'M');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(screen.getByText('Bitte mindestens 2 Zeichen eingeben.')).toBeTruthy();
    expect(search.getAttribute('aria-invalid')).toBe('true');
    expect(requests).toHaveLength(1);

    await user.type(search, 'ü ');
    await user.click(screen.getByRole('button', { name: 'Suchen' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].path).toBe('/api/v1/employees?q=M%C3%BC');
    expect(location()).toBe('/mitarbeitende?q=M%C3%BC');
  });

  it('filters by status and pages through results', async () => {
    const user = userEvent.setup();
    const { requests, location } = renderEmployees('/mitarbeitende', (request) =>
      page([mira], { page: request.path.includes('page=2') ? 2 : 1, totalItems: 30, totalPages: 2 }));
    await screen.findByRole('table');

    await user.click(screen.getByRole('radio', { name: 'Deaktiviert' }));
    await waitFor(() => expect(location()).toBe('/mitarbeitende?status=INACTIVE'));
    await screen.findByRole('table');
    expect(screen.getByText('30 Mitarbeitende · Seite 1 von 2')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Vorherige Seite' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Nächste Seite' }));
    await waitFor(() => expect(location()).toBe('/mitarbeitende?status=INACTIVE&page=2'));
    expect(await screen.findByText('30 Mitarbeitende · Seite 2 von 2')).toBeTruthy();
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/employees',
      '/api/v1/employees?status=INACTIVE',
      '/api/v1/employees?status=INACTIVE&page=2',
    ]);
  });

  it('ignores invalid URL parameters instead of sending them to the API', async () => {
    const { requests } = renderEmployees('/mitarbeitende?q=a&status=DEACTIVATED&page=-1&companyId=x', () => page([]));
    await screen.findByText('Noch keine Mitarbeitenden');
    expect(requests[0].path).toBe('/api/v1/employees');
  });

  it('shows a safe error with retry and recovers', async () => {
    let calls = 0;
    renderEmployees('/mitarbeitende', () => {
      calls += 1;
      if (calls === 1) throw new ApiError('network', null, null, null);
      return page([mira]);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Verbindung fehlgeschlagen');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('link', { name: 'Mira Beispiel' })).toBeTruthy();
  });
});
