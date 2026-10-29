// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/projekte"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { employee, httpError, type RecordedRequest } from '../employees/employees.test-support';
import { renderProjects } from './projects-render.test-support';
import { PROJECT_ID, fakeCompany, project } from './projects.test-support';

afterEach(() => cleanup());

// #73 — removal of FUTURE month assignments (UX A09), mocked API, jsdom: not a browser E2E.
// Synthetic example records and versions, not business rules. "Today" is 15.12.2026 (test clock).
const hafen = project();
const mira = employee({ id: 'e0000000-0000-4000-8000-000000000001', employeeCode: 'A-001', firstName: 'Mira', lastName: 'Beispiel' });
const jonas = employee({ id: 'e0000000-0000-4000-8000-000000000002', employeeCode: 'A-002', firstName: 'Jonas', lastName: 'Albrecht' });
const DEC = '2026-12-01';
const JAN = '2027-01-01';
const MIRA_JAN_VERSION = 1793260800000301;
const JANUARY = `/projekte/${PROJECT_ID}/2027-01`;

function company() {
  return fakeCompany({
    projects: [hafen],
    employees: [jonas, mira],
    assignments: [
      { id: 'a-mira-jan', employeeId: mira.id, projectId: hafen.id, monthStart: JAN, version: MIRA_JAN_VERSION },
      { id: 'a-jonas-jan', employeeId: jonas.id, projectId: hafen.id, monthStart: JAN, version: 1793260800000302 },
      { id: 'a-mira-dec', employeeId: mira.id, projectId: hafen.id, monthStart: DEC, version: 1793260800000303 },
    ],
  });
}

const table = (month = 'Januar 2027') => screen.findByRole('table', { name: `Zugeordnet im ${month}` });
const removeButton = (name: string) => screen.getByRole('button', { name: `Zuordnung von ${name} entfernen` });
const confirmButton = () => screen.getByRole('button', { name: 'Zuordnung entfernen' });
const confirmation = () => screen.getByRole('group', { name: /entfernen\?$/ });
const deletes = (requests: RecordedRequest[]) => requests.filter((request) => request.method === 'DELETE');

async function openConfirmation(name = 'Mira Beispiel') {
  await table();
  const user = userEvent.setup();
  await user.click(removeButton(name));
  return user;
}

describe('#73 — offering "Entfernen" (R2-a: a hint only, the server decides)', () => {
  it('a future month offers it on every row; the current and a past month do not', async () => {
    renderProjects(JANUARY, company().handler);
    const rows = within(await table()).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).queryByRole('button', { name: /entfernen$/ }) !== null)).toEqual([true, true]);
    cleanup();

    for (const path of [`/projekte/${PROJECT_ID}`, `/projekte/${PROJECT_ID}/2026-11`]) {
      renderProjects(path, company().handler);
      await screen.findByLabelText(/^Mitarbeiter:in für .* zuordnen$/);
      expect(screen.queryByRole('button', { name: /entfernen$/ })).toBeNull();
      cleanup();
    }
  });

  it.each([
    ['2026-12-31T23:30:00Z', 'offered with the time-zone hint (Berlin already January, New York still December)', true, true],
    ['2026-11-30T09:59:59Z', 'offered without a hint (January is future in every zone)', true, false],
    ['2027-01-01T12:00:00Z', 'not offered (January has begun in every zone)', false, false],
  ] as const)('at %s January is %s', async (instant, _label, offered, hint) => {
    renderProjects(JANUARY, company().handler, () => new Date(instant));
    await table();
    expect(screen.queryByRole('button', { name: 'Zuordnung von Mira Beispiel entfernen' }) !== null).toBe(offered);
    if (!offered) return;
    await userEvent.setup().click(removeButton('Mira Beispiel'));
    expect(within(confirmation()).queryByText(/entscheidet die Zeitzone des Unternehmens/) !== null).toBe(hint);
  });
});

describe('#73 — inline confirmation bound to the displayed row', () => {
  it('names person, project and month, says what does NOT happen, takes the focus and blocks other actions', async () => {
    const { requests } = renderProjects(JANUARY, company().handler);
    await openConfirmation();
    const group = confirmation();
    expect(within(group).getByRole('heading', { name: 'Zuordnung Mira Beispiel → Demo-Objekt Hafen, Januar 2027 entfernen?' })).toBeTruthy();
    expect(group.textContent).toContain('Es wird kein Ersatz angelegt; Dienste und Beschäftigungsdaten bleiben unverändert.');
    expect(group.textContent).toContain('Der Monat ist danach für eine neue Zuordnung frei.');
    expect(document.activeElement).toBe(within(group).getByRole('heading'));
    // One action at a time: every row action is disabled and the assign form is replaced.
    for (const button of within(await table()).getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Mitarbeiter:in für Januar 2027 zuordnen')).toBeNull();
    expect(deletes(requests)).toEqual([]);
  });

  it('"Abbrechen" sends nothing and returns the focus to the row\'s button', async () => {
    const { requests } = renderProjects(JANUARY, company().handler);
    const user = await openConfirmation('Jonas Albrecht');
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('group', { name: /entfernen\?$/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(removeButton('Jonas Albrecht')));
    expect(deletes(requests)).toEqual([]);
  });

  it('204: one DELETE with exactly the displayed version and no body; reloaded, the month is free again; focus on the message', async () => {
    const server = company();
    const { requests, location } = renderProjects(JANUARY, server.handler);
    const user = await openConfirmation();
    await user.click(confirmButton());

    const message = await screen.findByText(
      'Zuordnung entfernt: Mira Beispiel, Demo-Objekt Hafen, Januar 2027. Ein Ersatz wird nicht automatisch angelegt.',
    );
    expect(deletes(requests)).toEqual([
      { path: '/api/v1/project-assignments/a-mira-jan', method: 'DELETE', body: undefined, expectedVersion: MIRA_JAN_VERSION },
    ]);
    await waitFor(() => expect(document.activeElement?.contains(message)).toBe(true));
    await waitFor(async () => expect(within(await table()).queryByText('Mira Beispiel')).toBeNull());
    // The month is free: Mira can be assigned again deliberately (nothing was created automatically).
    const select = await screen.findByLabelText('Mitarbeiter:in für Januar 2027 zuordnen');
    expect(within(select).getByRole('option', { name: 'Mira Beispiel (A-001)' })).toBeTruthy();
    expect(server.state.assignments.map((item) => item.id)).toEqual(['a-jonas-jan', 'a-mira-dec']);
    // The version is an in-memory token only: never rendered, never in the URL.
    expect(document.body.innerHTML).not.toContain(String(MIRA_JAN_VERSION));
    expect(location()).toBe(JANUARY);
  });

  it('no double DELETE: while the request runs both buttons are disabled', async () => {
    const server = company();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { requests } = renderProjects(JANUARY, async (request) => {
      if (request.method === 'DELETE') await gate;
      return server.handler(request);
    });
    const user = await openConfirmation();
    await user.click(confirmButton());
    const pending = screen.getByRole('button', { name: 'Wird entfernt …' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Abbrechen' }) as HTMLButtonElement).disabled).toBe(true);
    await user.dblClick(pending);
    release();
    await screen.findByText(/^Zuordnung entfernt: Mira Beispiel/);
    expect(deletes(requests)).toHaveLength(1);
  });
});

describe('#73 — refusals: explained, reloaded, never retried', () => {
  it('409 PROJECT_ASSIGNMENT_CONFLICT (changed meanwhile): reloaded, closed; a new confirmation sends the NEW version', async () => {
    const server = company();
    const { requests } = renderProjects(JANUARY, server.handler);
    const user = await openConfirmation();
    // Meanwhile another admin corrected the row (A -> B -> A): same tuple, new version.
    server.fail((request) => {
      if (request.method !== 'DELETE') return undefined;
      server.state.assignments[0] = { ...server.state.assignments[0], version: MIRA_JAN_VERSION + 7 };
      return httpError(409, 'PROJECT_ASSIGNMENT_CONFLICT');
    });
    await user.click(confirmButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Zuordnung wurde geändert');
    expect(alert.textContent).toContain('bitte prüfen und bei Bedarf erneut entfernen');
    await waitFor(() => expect(screen.queryByRole('group', { name: /entfernen\?$/ })).toBeNull());
    await waitFor(async () => expect(within(await table()).getByText('Mira Beispiel')).toBeTruthy());
    expect(deletes(requests)).toHaveLength(1);

    // Only a deliberate new confirmation sends again, bound to the freshly loaded version.
    await user.click(removeButton('Mira Beispiel'));
    await user.click(confirmButton());
    await screen.findByText(/^Zuordnung entfernt: Mira Beispiel/);
    expect(deletes(requests).map((request) => request.expectedVersion)).toEqual([MIRA_JAN_VERSION, MIRA_JAN_VERSION + 7]);
  });

  it.each([
    ['404 already removed', () => httpError(404, 'RESOURCE_NOT_FOUND'), 'Zuordnung nicht mehr vorhanden', 'bereits entfernt'],
    ['409 month has begun / planning data', () => httpError(409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'), 'Entfernen nicht möglich', 'Zeitzone des Unternehmens'],
    ['400 missing or invalid Expected-Version', () => httpError(400, null), 'Anfrage unvollständig', 'Referenz-ID'],
    ['network failure (outcome unknown)', () => new ApiError('network', null, null, null), 'Ergebnis unbekannt', 'neu geladen'],
    ['403 (general text)', () => httpError(403, 'ACTION_FORBIDDEN'), 'Kein Zugriff', 'nicht berechtigt'],
  ] as const)('%s: own message, the month is read again, exactly one DELETE and no retry button', async (_label, failure, title, detail) => {
    const server = company();
    const { requests } = renderProjects(JANUARY, server.handler);
    const user = await openConfirmation();
    const reads = () => requests.filter((request) => request.method === 'GET' && request.path.startsWith('/api/v1/project-assignments?')).length;
    const readsBefore = reads();
    server.fail((request) => (request.method === 'DELETE' ? failure() : undefined));
    await user.click(confirmButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain(detail);
    expect(within(alert).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    await waitFor(() => expect(reads()).toBe(readsBefore + 1));
    await waitFor(() => expect(document.activeElement?.contains(alert)).toBe(true));
    expect(deletes(requests)).toHaveLength(1);
    expect(server.state.assignments.some((item) => item.id === 'a-mira-jan')).toBe(true);
  });
});
