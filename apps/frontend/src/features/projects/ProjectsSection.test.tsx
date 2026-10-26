// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/projekte"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { deferred, httpError } from '../employees/employees.test-support';
import { renderProjects } from './projects-render.test-support';
import { PROJECT_ID, fakeCompany, project, projectPage } from './projects.test-support';

afterEach(() => cleanup());

// Synthetic example records, not business rules.
const hafen = project();
const messe = project({ id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Demo-Objekt Messe', status: 'INACTIVE' });

describe('SP-08 — project list (real API source)', () => {
  it('shows a loading state, then a labelled table with status as text and icon', async () => {
    const response = deferred<unknown>();
    const { requests } = renderProjects('/projekte', () => response.promise);
    expect(screen.getByRole('heading', { level: 1, name: 'Projekte & Zuordnungen' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Projekte werden geladen');

    response.resolve(projectPage([hafen, messe]));
    const table = await screen.findByRole('table', { name: 'Projekte' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual(['Demo-Objekt HafenAktiv', 'Demo-Objekt MesseInaktiv']);
    expect(within(rows[0]).getByRole('link', { name: 'Demo-Objekt Hafen' }).getAttribute('href')).toBe(`/projekte/${PROJECT_ID}`);
    expect(within(rows[1]).getByText('Inaktiv').closest('.status-badge')?.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('2 Projekte')).toBeTruthy();
    expect(requests).toEqual([{ path: '/api/v1/projects', method: 'GET', body: undefined }]);
  });

  it('distinguishes an empty company from a filter without results and filters by status', async () => {
    renderProjects('/projekte', () => projectPage([]));
    expect(await screen.findByText('Noch keine Projekte')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projekt anlegen' }).getAttribute('href')).toBe('/projekte/neu');
    cleanup();

    const { requests, location } = renderProjects('/projekte?status=INACTIVE', (request) =>
      request.path === '/api/v1/projects' ? projectPage([hafen]) : projectPage([]));
    expect(await screen.findByText('Keine Treffer')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(await screen.findByRole('link', { name: 'Demo-Objekt Hafen' })).toBeTruthy();
    expect(location()).toBe('/projekte');
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Aktiv' }));
    await waitFor(() => expect(location()).toBe('/projekte?status=ACTIVE'));
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/projects?status=INACTIVE',
      '/api/v1/projects',
      '/api/v1/projects?status=ACTIVE',
    ]);
  });

  it('shows a safe, retryable error for a failed load', async () => {
    let calls = 0;
    renderProjects('/projekte', () => {
      calls += 1;
      if (calls === 1) throw new ApiError('network', null, null, null);
      return projectPage([hafen]);
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Verbindung fehlgeschlagen');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('link', { name: 'Demo-Objekt Hafen' })).toBeTruthy();
  });
});

describe('SP-08 — create project', () => {
  it('validates the name on the client before any request', async () => {
    const { requests } = renderProjects('/projekte/neu', () => hafen);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Projektname'), ' A ');
    await user.click(screen.getByRole('button', { name: 'Projekt anlegen' }));
    expect(screen.getByText('Der Projektname muss mindestens 2 Zeichen lang sein.')).toBeTruthy();
    expect(screen.getByLabelText('Projektname').getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Projektname')));
    expect(requests).toEqual([]);
  });

  it('sends only the trimmed name and opens the created project with a notice', async () => {
    const company = fakeCompany({ projects: [] });
    const { requests, location } = renderProjects('/projekte/neu', company.handler);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Projektname'), '  Demo-Objekt Hafen ');
    await user.click(screen.getByRole('button', { name: 'Projekt anlegen' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo-Objekt Hafen' })).toBeTruthy();
    expect(location()).toBe(`/projekte/${company.state.projects[0].id}`);
    expect(screen.getByText('Projekt wurde angelegt.')).toBeTruthy();
    expect(requests[0]).toEqual({ path: '/api/v1/projects', method: 'POST', body: { name: 'Demo-Objekt Hafen' } });
  });

  it('shows a duplicate name at the field and keeps the input', async () => {
    renderProjects('/projekte/neu', () => {
      throw httpError(409, 'PROJECT_NAME_ALREADY_EXISTS');
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Projektname'), 'Demo-Objekt Hafen');
    await user.click(screen.getByRole('button', { name: 'Projekt anlegen' }));
    expect(await screen.findByText('Dieser Projektname wird in Ihrem Unternehmen bereits verwendet.')).toBeTruthy();
    expect((screen.getByLabelText('Projektname') as HTMLInputElement).value).toBe('Demo-Objekt Hafen');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Projektname')));
  });

  it('shows other failures as a safe alert with reference id', async () => {
    renderProjects('/projekte/neu', () => {
      throw httpError(500, 'INTERNAL_ERROR');
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Projektname'), 'Demo-Objekt Hafen');
    await user.click(screen.getByRole('button', { name: 'Projekt anlegen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Ein Fehler ist aufgetreten');
    expect(alert.textContent).toContain('req-sp07-1');
  });
});

describe('SP-08 — project detail', () => {
  const PATH = `/projekte/${PROJECT_ID}`;

  it('renames the project; focus moves into the form and back to the notice', async () => {
    const { requests } = renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Namen bearbeiten' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Projektname')));
    await user.clear(screen.getByLabelText('Projektname'));
    await user.type(screen.getByLabelText('Projektname'), 'Demo-Objekt Hafen Süd');
    await user.click(screen.getByRole('button', { name: 'Namen speichern' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Demo-Objekt Hafen Süd' })).toBeTruthy();
    const notice = screen.getByText('Der Projektname wurde gespeichert.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([
      { path: `/api/v1/projects/${PROJECT_ID}`, method: 'PATCH', body: { name: 'Demo-Objekt Hafen Süd' } },
    ]);
  });

  it('sets the project inactive only after confirmation and can reactivate it', async () => {
    const { requests } = renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Projekt auf inaktiv setzen …' }));
    const confirm = screen.getByRole('group', { name: 'Demo-Objekt Hafen wirklich auf inaktiv setzen?' });
    expect(confirm.textContent).toContain('keine neuen Monatszuordnungen');
    expect(confirm.textContent).toContain('Historie bleiben unverändert erhalten');
    await user.click(within(confirm).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Projekt auf inaktiv setzen …' })));
    expect(requests.filter((request) => request.method === 'PATCH')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Projekt auf inaktiv setzen …' }));
    await user.click(screen.getByRole('button', { name: 'Auf inaktiv setzen' }));
    expect(await screen.findByText('Das Projekt ist jetzt inaktiv.')).toBeTruthy();
    expect(screen.getAllByText('Inaktiv').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Projekt reaktivieren' }));
    expect(await screen.findByText('Das Projekt ist wieder aktiv.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH').map((request) => request.body)).toEqual([
      { status: 'INACTIVE' },
      { status: 'ACTIVE' },
    ]);
  });

  it('answers unknown or foreign ids with the safe not-found text', async () => {
    renderProjects(PATH, () => {
      throw httpError(404, 'RESOURCE_NOT_FOUND');
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Nicht gefunden');
    expect(screen.getByRole('heading', { level: 1, name: 'Projektdetails' })).toBeTruthy();
  });
});
