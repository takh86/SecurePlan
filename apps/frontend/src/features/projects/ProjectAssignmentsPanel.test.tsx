// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/projekte"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { employee, httpError } from '../employees/employees.test-support';
import { renderProjects } from './projects-render.test-support';
import { PROJECT_ID, fakeCompany, project } from './projects.test-support';

afterEach(() => cleanup());

// Synthetic example records, not business rules. "Today" is 15.12.2026 (test clock).
const hafen = project();
const messe = project({ id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Demo-Objekt Messe' });
const mira = employee({ id: 'e0000000-0000-4000-8000-000000000001', employeeCode: 'A-001', firstName: 'Mira', lastName: 'Beispiel' });
const jonas = employee({ id: 'e0000000-0000-4000-8000-000000000002', employeeCode: 'A-002', firstName: 'Jonas', lastName: 'Albrecht' });
const lena = employee({
  id: 'e0000000-0000-4000-8000-000000000003', employeeCode: 'A-003', firstName: 'Lena', lastName: 'Muster',
  status: 'INACTIVE', accountStatus: 'DEACTIVATED',
});
const tom = employee({ id: 'e0000000-0000-4000-8000-000000000004', employeeCode: 'A-004', firstName: 'Tom', lastName: 'Probe' });
const DEC = '2026-12-01';
const PATH = `/projekte/${PROJECT_ID}`;

function company() {
  return fakeCompany({
    projects: [hafen, messe],
    employees: [jonas, mira, lena, tom],
    assignments: [
      { id: 'a-lena', employeeId: lena.id, projectId: hafen.id, monthStart: DEC },
      { id: 'a-tom', employeeId: tom.id, projectId: messe.id, monthStart: DEC },
    ],
  });
}

async function panelReady() {
  return screen.findByLabelText('Mitarbeiter:in für Dezember 2026 zuordnen');
}

function optionTexts(select: HTMLElement) {
  return within(select).getAllByRole('option').map((option) => [option.textContent, (option as HTMLOptionElement).disabled]);
}

describe('SP-09 — month assignment (UX A09, real API source)', () => {
  it('shows the persisted assignments of the month and a pool that names other projects instead of offering them', async () => {
    const { requests } = renderProjects(PATH, company().handler);
    const select = await panelReady();
    expect(screen.getByRole('heading', { level: 3, name: 'Dezember 2026' })).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Zugeordnet im Dezember 2026' });
    const rows = within(table).getAllByRole('row').slice(1);
    // An assignment of a now inactive person stays visible as history.
    expect(rows.map((row) => row.textContent)).toEqual(['Lena MusterA-003Deaktiviert']);

    expect(optionTexts(select)).toEqual([
      ['Bitte auswählen', false],
      ['Jonas Albrecht (A-002)', false],
      ['Mira Beispiel (A-001)', false],
      ['Tom Probe (A-004) – bereits Demo-Objekt Messe zugeordnet', true],
    ]);
    expect(requests.map((request) => request.path)).toEqual(expect.arrayContaining([
      `/api/v1/projects/${PROJECT_ID}`,
      '/api/v1/project-assignments?monthStart=2026-12-01&pageSize=100',
      '/api/v1/employees?pageSize=100',
      '/api/v1/projects?pageSize=100',
    ]));
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('assigns a person; the view shows the state read back from the API and it survives a reload', async () => {
    const server = company();
    const first = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await user.selectOptions(await panelReady(), mira.id);
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));

    expect(await screen.findByText('Mira Beispiel ist dem Projekt Demo-Objekt Hafen für Dezember 2026 zugeordnet.')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Zugeordnet im Dezember 2026' });
    await waitFor(() => expect(within(table).getByText('Mira Beispiel')).toBeTruthy());
    // The client sends exactly the three business dimensions; no tenant or role.
    expect(first.requests.filter((request) => request.method === 'POST')).toEqual([{
      path: '/api/v1/project-assignments',
      method: 'POST',
      body: { employeeId: mira.id, projectId: PROJECT_ID, monthStart: DEC },
    }]);
    // After the write the month was read again (persisted state, not a local guess).
    const postIndex = first.requests.findIndex((request) => request.method === 'POST');
    expect(first.requests.slice(postIndex + 1).map((request) => request.path))
      .toContain('/api/v1/project-assignments?monthStart=2026-12-01&pageSize=100');

    // Reload: a fresh mount reads the same persisted assignment.
    cleanup();
    renderProjects(PATH, server.handler);
    const reloaded = await screen.findByRole('table', { name: 'Zugeordnet im Dezember 2026' });
    expect(within(reloaded).getByText('Mira Beispiel')).toBeTruthy();
    expect(optionTexts(await panelReady()).map(([text]) => text)).not.toContain('Mira Beispiel (A-001)');
  });

  it('a server conflict is explained, nothing is changed silently, and the reloaded view names the other project', async () => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await user.selectOptions(await panelReady(), jonas.id);
    // Meanwhile another admin assigned Jonas to Messe for December.
    server.fail((request) => {
      if (request.method !== 'POST') return undefined;
      server.state.assignments.push({ id: 'a-race', employeeId: jonas.id, projectId: messe.id, monthStart: DEC });
      return httpError(409, 'PROJECT_ASSIGNMENT_CONFLICT');
    });
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Bereits einem anderen Projekt zugeordnet');
    expect(alert.textContent).toContain('Je Kalendermonat ist nur ein Projekt möglich');
    const select = await panelReady();
    await waitFor(() => expect(optionTexts(select)).toContainEqual(['Jonas Albrecht (A-002) – bereits Demo-Objekt Messe zugeordnet', true]));
    expect(within(screen.getByRole('table', { name: 'Zugeordnet im Dezember 2026' })).queryByText('Jonas Albrecht')).toBeNull();
    expect(server.state.assignments.filter((item) => item.employeeId === jonas.id)).toHaveLength(1);
  });

  it.each([
    ['PROJECT_ASSIGNMENT_ALREADY_EXISTS', 409, 'Zuordnung besteht bereits'],
    ['EMPLOYEE_INACTIVE', 409, 'Bereits deaktiviert'],
    ['PROJECT_INACTIVE', 409, 'Projekt ist inaktiv'],
    ['RESOURCE_NOT_FOUND', 404, 'Nicht gefunden'],
  ] as const)('shows the approved %s error safely', async (code, status, title) => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await user.selectOptions(await panelReady(), mira.id);
    server.fail((request) => (request.method === 'POST' ? httpError(status, code) : undefined));
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain('req-sp07-1');
  });

  it('a network failure keeps the form usable and writes nothing', async () => {
    const server = company();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await user.selectOptions(await panelReady(), mira.id);
    server.fail((request) => (request.method === 'POST' ? new ApiError('network', null, null, null) : undefined));
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Verbindung fehlgeschlagen');
    expect(server.state.assignments).toHaveLength(2);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect((await panelReady() as HTMLSelectElement).disabled).toBe(false);
  });

  it('validates the selection on the client before any request', async () => {
    const { requests } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await panelReady();
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(screen.getByText('Bitte wählen Sie eine Person aus.')).toBeTruthy();
    const select = await panelReady();
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(select);
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('works with the keyboard only', async () => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    const select = await panelReady();
    select.focus();
    await user.selectOptions(select, jonas.id);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zuordnen' }));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Jonas Albrecht ist dem Projekt Demo-Objekt Hafen für Dezember 2026 zugeordnet.')).toBeTruthy();
    expect(server.state.assignments.some((item) => item.employeeId === jonas.id && item.projectId === hafen.id)).toBe(true);
  });
});

describe('SP-09 — months', () => {
  it('steps across the year boundary; each month is read on its own and focus stays on the month link', async () => {
    const { requests, location } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await panelReady();

    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    await user.click(next);
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(await screen.findByRole('heading', { level: 3, name: 'Januar 2027' })).toBeTruthy();
    expect(await screen.findByText('Für Januar 2027 sind diesem Projekt noch keine Mitarbeitenden zugeordnet.')).toBeTruthy();
    expect(document.activeElement?.textContent).toContain('Nächster Monat');
    expect(requests.map((request) => request.path)).toContain('/api/v1/project-assignments?monthStart=2027-01-01&pageSize=100');

    await user.click(screen.getByRole('link', { name: 'Vorheriger Monat: Dezember 2026' }));
    await user.click(await screen.findByRole('link', { name: 'Vorheriger Monat: November 2026' }));
    expect(location()).toBe(`${PATH}/2026-11`);
    expect(await screen.findByRole('heading', { level: 3, name: 'November 2026' })).toBeTruthy();
    expect(requests.map((request) => request.path)).toContain('/api/v1/project-assignments?monthStart=2026-11-01&pageSize=100');
  });

  it('an invalid month in the URL falls back to the current month', async () => {
    const { location } = renderProjects(`${PATH}/2026-13`, company().handler);
    await waitFor(() => expect(location()).toBe(PATH));
    expect(await screen.findByRole('heading', { level: 3, name: 'Dezember 2026' })).toBeTruthy();
  });

  it('an inactive project shows its assignments but offers no new assignment', async () => {
    const server = company();
    server.state.projects[0] = { ...hafen, status: 'INACTIVE' };
    renderProjects(PATH, server.handler);
    expect(await screen.findByRole('table', { name: 'Zugeordnet im Dezember 2026' })).toBeTruthy();
    expect(screen.getByText('Das Projekt ist inaktiv. Neue Zuordnungen sind nicht möglich; bestehende bleiben erhalten.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Zuordnen' })).toBeNull();
  });

  it('a failed month load is shown safely and can be retried', async () => {
    const server = company();
    server.fail((request) => (request.path.startsWith('/api/v1/project-assignments') ? new ApiError('network', null, null, null) : undefined));
    renderProjects(PATH, server.handler);
    expect((await screen.findByRole('alert')).textContent).toContain('Verbindung fehlgeschlagen');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await panelReady()).toBeTruthy();
  });
});
