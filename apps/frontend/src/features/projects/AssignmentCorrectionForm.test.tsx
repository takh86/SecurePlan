// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/projekte"}
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SESSION_REDIRECT_STATE } from '../../app/session-redirect';
import { ApiError, type KnownErrorCode } from '../../shared/api/api-error';
import { deferred, employee, httpError, type Handler, type RecordedRequest } from '../employees/employees.test-support';
import { renderProjects } from './projects-render.test-support';
import { PROJECT_ID, fakeCompany, project } from './projects.test-support';

afterEach(() => cleanup());

// Synthetic example records, not business rules. "Today" is 15.12.2026 (test clock).
const hafen = project();
const messe = project({ id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Demo-Objekt Messe' });
const lager = project({ id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a', name: 'Demo-Objekt Lager', status: 'INACTIVE' });
const mira = employee({ id: 'e0000000-0000-4000-8000-000000000001', employeeCode: 'A-001', firstName: 'Mira', lastName: 'Beispiel' });
const jonas = employee({ id: 'e0000000-0000-4000-8000-000000000002', employeeCode: 'A-002', firstName: 'Jonas', lastName: 'Albrecht' });
const lena = employee({
  id: 'e0000000-0000-4000-8000-000000000003', employeeCode: 'A-003', firstName: 'Lena', lastName: 'Muster',
  status: 'INACTIVE', accountStatus: 'DEACTIVATED',
});
const tom = employee({ id: 'e0000000-0000-4000-8000-000000000004', employeeCode: 'A-004', firstName: 'Tom', lastName: 'Probe' });
const DEC = '2026-12-01';
const JAN = '2027-01-01';
const PATH = `/projekte/${PROJECT_ID}`;
const MESSE_PATH = `/projekte/${messe.id}`;
const ASSIGNMENTS_URL = '/api/v1/project-assignments';
const DEC_LIST = `${ASSIGNMENTS_URL}?monthStart=2026-12-01&pageSize=100`;

function company() {
  return fakeCompany({
    projects: [hafen, messe, lager],
    employees: [jonas, mira, lena, tom],
    assignments: [
      { id: 'a-mira', employeeId: mira.id, projectId: hafen.id, monthStart: DEC },
      { id: 'a-lena', employeeId: lena.id, projectId: hafen.id, monthStart: DEC },
      { id: 'a-tom', employeeId: tom.id, projectId: messe.id, monthStart: DEC },
      { id: 'a-jonas-jan', employeeId: jonas.id, projectId: hafen.id, monthStart: JAN },
    ],
  });
}

type User = ReturnType<typeof userEvent.setup>;

const patches = (requests: RecordedRequest[]) => requests.filter((request) => request.method === 'PATCH');
const correctionForm = () => screen.getByRole('form', { name: /korrigieren$/ });
const employeeSelect = () => within(correctionForm()).getByLabelText('Mitarbeiter:in') as HTMLSelectElement;
const projectSelect = () => within(correctionForm()).getByLabelText('Projekt') as HTMLSelectElement;
const monthField = () => within(correctionForm()).getByLabelText('Monat') as HTMLInputElement;
const saveButton = () => within(correctionForm()).getByRole('button', { name: 'Korrektur speichern' });
const table = (monthLabel = 'Dezember 2026') => screen.findByRole('table', { name: `Zugeordnet im ${monthLabel}` });
const rowNames = (element: HTMLElement) =>
  within(element).getAllByRole('row').slice(1).map((row) => within(row).getByRole('rowheader').textContent);
const optionTexts = (select: HTMLSelectElement) => within(select).getAllByRole('option').map((option) => option.textContent);

/** Opens the correction of one row and waits until focus is in the form. */
async function openCorrection(user: User, name = 'Mira Beispiel') {
  await user.click(await screen.findByRole('button', { name: `Zuordnung von ${name} korrigieren` }));
  await waitFor(() => expect(document.activeElement).toBe(employeeSelect()));
}

async function setMonth(user: User, month: string) {
  await user.clear(monthField());
  if (month) await user.type(monthField(), month);
}

/** Delegates to the in-memory company, but holds back requests matching `hold` until released. */
function holding(server: ReturnType<typeof fakeCompany>, hold: (request: RecordedRequest) => boolean) {
  const gate = deferred<void>();
  const handler: Handler = (request) => (hold(request) ? gate.promise.then(() => server.handler(request)) : server.handler(request));
  return { handler, release: () => gate.resolve() };
}

describe('SP-09 correction — opening the form', () => {
  it('each existing row offers an accessible edit action; the form starts from the persisted values', async () => {
    renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    expect(rowNames(await table())).toEqual(['Mira Beispiel', 'Lena Muster']);
    await openCorrection(user);

    expect(within(correctionForm()).getByRole('heading', { level: 3, name: 'Zuordnung von Mira Beispiel korrigieren' })).toBeTruthy();
    expect(correctionForm().textContent).toContain('Gespeichert: Mira Beispiel, Demo-Objekt Hafen, Dezember 2026.');
    expect(employeeSelect().value).toBe(mira.id);
    expect(projectSelect().value).toBe(hafen.id);
    expect(monthField().value).toBe('2026-12');
    // Newly selectable are only ACTIVE people and projects (server rule); the inactive ones are not offered.
    expect(optionTexts(employeeSelect())).toEqual(['Jonas Albrecht (A-002)', 'Mira Beispiel (A-001) – aktuell', 'Tom Probe (A-004)']);
    expect(optionTexts(projectSelect())).toEqual(['Demo-Objekt Hafen – aktuell', 'Demo-Objekt Messe']);
    // One correction at a time; the create form waits until the correction is closed.
    const edit = screen.getByRole('button', { name: 'Zuordnung von Mira Beispiel korrigieren' });
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByRole('button', { name: 'Zuordnung von Lena Muster korrigieren' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Zuordnen' })).toBeNull();
    expect(screen.queryByText('Ungespeicherte Änderungen')).toBeNull();
  });

  it('a historical assignment of a now inactive person keeps that person as the current, labelled value', async () => {
    renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await openCorrection(user, 'Lena Muster');
    expect(employeeSelect().value).toBe(lena.id);
    expect(optionTexts(employeeSelect())).toContain('Lena Muster (A-003) – deaktiviert – aktuell');
  });

  it('"Abbrechen" discards the input without a request and returns focus to the row action', async () => {
    const { requests } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    expect(screen.getByText('Ungespeicherte Änderungen')).toBeTruthy();
    await user.click(within(correctionForm()).getByRole('button', { name: 'Abbrechen' }));

    expect(screen.queryByRole('form', { name: /korrigieren$/ })).toBeNull();
    const edit = screen.getByRole('button', { name: 'Zuordnung von Mira Beispiel korrigieren' });
    expect(document.activeElement).toBe(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Zuordnen' })).toBeTruthy();
    expect(patches(requests)).toEqual([]);

    await openCorrection(user);
    expect(employeeSelect().value).toBe(mira.id);
  });

  it('works with the keyboard only', async () => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    const edit = await screen.findByRole('button', { name: 'Zuordnung von Mira Beispiel korrigieren' });
    edit.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(employeeSelect()));
    await user.tab();
    expect(document.activeElement).toBe(projectSelect());
    await user.tab();
    expect(document.activeElement).toBe(monthField());
    await user.clear(monthField());
    await user.keyboard('2027-01{Enter}');
    expect(await screen.findByText(/Die Zuordnung wurde korrigiert/)).toBeTruthy();
    expect(server.state.assignments.find((item) => item.id === 'a-mira')?.monthStart).toBe(JAN);
  });
});

describe('SP-09 correction — saving (PATCH, persisted state)', () => {
  it('employee correction: sends only employeeId, then shows the state read back from the API; it survives a reload', async () => {
    const server = company();
    const first = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    await user.click(saveButton());

    const notice = await screen.findByText('Die Zuordnung wurde korrigiert: Jonas Albrecht ist dem Projekt Demo-Objekt Hafen für Dezember 2026 zugeordnet.');
    await waitFor(() => expect(document.activeElement?.contains(notice)).toBe(true));
    await waitFor(async () => expect(rowNames(await table())).toEqual(['Jonas Albrecht', 'Lena Muster']));
    expect(patches(first.requests)).toEqual([{ path: `${ASSIGNMENTS_URL}/a-mira`, method: 'PATCH', body: { employeeId: jonas.id } }]);
    // Persisted state, not a local guess: the month was read again after the write.
    const patchIndex = first.requests.findIndex((request) => request.method === 'PATCH');
    expect(first.requests.slice(patchIndex + 1).map((request) => request.path)).toContain(DEC_LIST);
    // History is kept: the record is corrected in place, nothing is deleted.
    expect(first.requests.every((request) => ['GET', 'PATCH'].includes(request.method))).toBe(true);
    expect(server.state.assignments.map((item) => item.id)).toEqual(['a-mira', 'a-lena', 'a-tom', 'a-jonas-jan']);

    cleanup();
    renderProjects(PATH, server.handler);
    expect(rowNames(await table())).toEqual(['Jonas Albrecht', 'Lena Muster']);
  });

  it('project correction: the row leaves this view only after the server answered and the month was read again', async () => {
    const server = company();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { requests } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(projectSelect(), messe.id);
    await user.click(saveButton());
    await screen.findByRole('button', { name: 'Wird gespeichert …' });
    // No optimistic movement while the request is pending.
    expect(rowNames(await table())).toEqual(['Mira Beispiel', 'Lena Muster']);

    held.release();
    expect(await screen.findByText(
      'Die Zuordnung wurde korrigiert: Mira Beispiel ist dem Projekt Demo-Objekt Messe für Dezember 2026 zugeordnet. Sie wird deshalb hier für Dezember 2026 nicht mehr angezeigt.',
    )).toBeTruthy();
    await waitFor(async () => expect(rowNames(await table())).toEqual(['Lena Muster']));
    expect(patches(requests).map((request) => request.body)).toEqual([{ projectId: messe.id }]);

    // The target project shows it from the API.
    cleanup();
    renderProjects(MESSE_PATH, server.handler);
    expect(rowNames(await table())).toEqual(['Mira Beispiel', 'Tom Probe']);
  });

  it('month correction over the year boundary (December 2026 -> January 2027) sends the first day of the month', async () => {
    const server = company();
    const { requests, location } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await setMonth(user, '2027-01');
    await user.click(saveButton());

    expect(await screen.findByText(
      'Die Zuordnung wurde korrigiert: Mira Beispiel ist dem Projekt Demo-Objekt Hafen für Januar 2027 zugeordnet. Sie wird deshalb hier für Dezember 2026 nicht mehr angezeigt.',
    )).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([{ monthStart: JAN }]);
    await waitFor(async () => expect(rowNames(await table())).toEqual(['Lena Muster']));

    // Saved: the month step is not held, and January shows the persisted assignment.
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(rowNames(await table('Januar 2027'))).toEqual(['Mira Beispiel', 'Jonas Albrecht']);
  });

  it('month correction back over the year boundary (January 2027 -> December 2026)', async () => {
    const server = company();
    const { requests } = renderProjects(`${PATH}/2027-01`, server.handler);
    const user = userEvent.setup();
    await openCorrection(user, 'Jonas Albrecht');
    expect(monthField().value).toBe('2027-01');
    await setMonth(user, '2026-12');
    await user.click(saveButton());

    expect(await screen.findByText(
      'Die Zuordnung wurde korrigiert: Jonas Albrecht ist dem Projekt Demo-Objekt Hafen für Dezember 2026 zugeordnet. Sie wird deshalb hier für Januar 2027 nicht mehr angezeigt.',
    )).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([{ monthStart: DEC }]);
    expect(await screen.findByText('Für Januar 2027 sind diesem Projekt noch keine Mitarbeitenden zugeordnet.')).toBeTruthy();
  });

  it('combined correction sends employee, project and month together', async () => {
    const server = company();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    await user.selectOptions(projectSelect(), messe.id);
    await setMonth(user, '2027-02');
    await user.click(saveButton());

    expect(await screen.findByText(
      'Die Zuordnung wurde korrigiert: Jonas Albrecht ist dem Projekt Demo-Objekt Messe für Februar 2027 zugeordnet. Sie wird deshalb hier für Dezember 2026 nicht mehr angezeigt.',
    )).toBeTruthy();
    expect(patches(requests).map((request) => request.body))
      .toEqual([{ employeeId: jonas.id, projectId: messe.id, monthStart: '2027-02-01' }]);
    expect(server.state.assignments.find((item) => item.id === 'a-mira'))
      .toEqual({ id: 'a-mira', employeeId: jonas.id, projectId: messe.id, monthStart: '2027-02-01' });
  });

  it('no-op: unchanged values send nothing and say so', async () => {
    const { requests } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await openCorrection(user);
    // Changed and changed back: nothing differs from the persisted assignment.
    await user.selectOptions(employeeSelect(), jonas.id);
    await user.selectOptions(employeeSelect(), mira.id);
    await setMonth(user, '2026-12');
    await user.click(saveButton());

    const notice = await screen.findByText('Es gab keine Änderungen zu speichern.');
    await waitFor(() => expect(document.activeElement?.contains(notice)).toBe(true));
    expect(screen.queryByRole('form', { name: /korrigieren$/ })).toBeNull();
    expect(patches(requests)).toEqual([]);
  });

  it('validates the month format on the client first: focus moves to the field, which is described by its error', async () => {
    const { requests } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await openCorrection(user);
    for (const month of ['2027-13', '2027-1', '']) {
      await setMonth(user, month);
      await user.click(saveButton());
      await waitFor(() => expect(document.activeElement).toBe(monthField()));
      expect(monthField().getAttribute('aria-invalid')).toBe('true');
      const errorId = monthField().getAttribute('aria-describedby')!.split(' ').find((id) => id.endsWith('-error'))!;
      expect(document.getElementById(errorId)?.textContent).toBe('Bitte geben Sie den Monat im Format JJJJ-MM an, z. B. 2027-01.');
    }
    expect(patches(requests)).toEqual([]);
    // Typing clears the error of that field.
    await user.type(monthField(), '2');
    expect(monthField().getAttribute('aria-invalid')).toBeNull();
  });

  it('a double submit sends exactly one PATCH; the form is disabled while saving', async () => {
    const server = company();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { requests } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    await user.click(saveButton());
    const pending = await screen.findByRole('button', { name: 'Wird gespeichert …' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(employeeSelect().disabled).toBe(true);
    expect(correctionForm().getAttribute('aria-busy')).toBe('true');
    fireEvent.submit(correctionForm());
    fireEvent.submit(correctionForm());
    expect(patches(requests)).toHaveLength(1);

    held.release();
    expect(await screen.findByText(/Die Zuordnung wurde korrigiert/)).toBeTruthy();
    expect(patches(requests)).toHaveLength(1);
  });
});

describe('SP-09 correction — failures keep the input', () => {
  it.each([
    ['PROJECT_ASSIGNMENT_CORRECTION_CONFLICT', 409, 'Korrektur nicht möglich'],
    // #64 case 1: a FUTURE correction now gets POST's code when employment evidence is missing.
    ['EMPLOYEE_NOT_EMPLOYED_FOR_MONTH', 409, 'Nicht beschäftigt in diesem Monat'],
    ['PROJECT_ASSIGNMENT_CONFLICT', 409, 'Bereits einem anderen Projekt zugeordnet'],
    ['PROJECT_ASSIGNMENT_ALREADY_EXISTS', 409, 'Zuordnung besteht bereits'],
    ['EMPLOYEE_INACTIVE', 409, 'Bereits deaktiviert'],
    ['PROJECT_INACTIVE', 409, 'Projekt ist inaktiv'],
    ['RESOURCE_NOT_FOUND', 404, 'Nicht gefunden'],
    ['ACTION_FORBIDDEN', 403, 'Kein Zugriff'],
  ] as const)('%s (%s) is explained safely; entered values stay and nothing changes', async (code, status, title) => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    await setMonth(user, '2027-01');
    server.fail((request) => (request.method === 'PATCH' ? httpError(status, code as KnownErrorCode) : undefined));
    await user.click(saveButton());

    const alert = await within(correctionForm()).findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain('req-sp07-1');
    await waitFor(() => expect(document.activeElement?.contains(alert)).toBe(true));
    expect(employeeSelect().value).toBe(jonas.id);
    expect(monthField().value).toBe('2027-01');
    expect(employeeSelect().disabled).toBe(false);
    expect(server.state.assignments.find((item) => item.id === 'a-mira')).toEqual({
      id: 'a-mira', employeeId: mira.id, projectId: hafen.id, monthStart: DEC,
    });
    // 404/409 may mean the stored state changed meanwhile; the user can retry or reload deliberately.
    expect(correctionForm().textContent?.includes('Der gespeicherte Stand kann sich inzwischen geändert haben.')).toBe(status !== 403);
    expect(within(correctionForm()).getByRole('button', { name: 'Verwerfen und neu laden' })).toBeTruthy();
  });

  it('the planning guard (fail closed) never reveals plan details and offers no automatic retry', async () => {
    const server = company();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await setMonth(user, '2027-01');
    server.fail((request) => (request.method === 'PATCH' ? httpError(409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT') : undefined));
    await user.click(saveButton());
    const alert = await within(correctionForm()).findByRole('alert');
    expect(alert.textContent).toContain('bestehende Planungsdaten eine Korrektur verhindern');
    expect(alert.textContent).toContain('Die Zuordnung wurde nicht geändert.');
    expect(within(alert).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patches(requests)).toHaveLength(1);
  });

  it('a real duplicate from the API: the person is already assigned elsewhere in that month', async () => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    // Tom belongs to Messe in December (fake company follows the API contract).
    await user.selectOptions(employeeSelect(), tom.id);
    await user.click(saveButton());
    expect((await within(correctionForm()).findByRole('alert')).textContent).toContain('Bereits einem anderen Projekt zugeordnet');
    expect(server.state.assignments.filter((item) => item.employeeId === tom.id)).toHaveLength(1);
  });

  it('a server validation error is shown at the field it belongs to', async () => {
    const server = company();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(projectSelect(), messe.id);
    server.fail((request) => (request.method === 'PATCH'
      ? httpError(400, 'VALIDATION_FAILED', [{ pointer: '#/projectId', code: 'INVALID_UUID' }])
      : undefined));
    await user.click(saveButton());
    expect((await within(correctionForm()).findByRole('alert')).textContent).toContain('Eingaben überprüfen');
    expect(projectSelect().getAttribute('aria-invalid')).toBe('true');
    expect(projectSelect().value).toBe(messe.id);
  });

  it('after a network failure the same values can be saved again', async () => {
    const server = company();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(projectSelect(), messe.id);
    server.fail((request) => (request.method === 'PATCH' ? new ApiError('network', null, null, null) : undefined));
    await user.click(saveButton());
    expect((await within(correctionForm()).findByRole('alert')).textContent).toContain('Verbindung fehlgeschlagen');

    await user.click(saveButton());
    expect(await screen.findByText(/Die Zuordnung wurde korrigiert: Mira Beispiel ist dem Projekt Demo-Objekt Messe/)).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([{ projectId: messe.id }, { projectId: messe.id }]);
  });

  it('"Verwerfen und neu laden" closes the correction and reads the current state from the API', async () => {
    const server = company();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    // Meanwhile another admin moved Mira to January; this correction answers 409.
    server.fail((request) => {
      if (request.method !== 'PATCH') return undefined;
      server.state.assignments[0] = { ...server.state.assignments[0], monthStart: JAN };
      return httpError(409, 'PROJECT_ASSIGNMENT_CONFLICT');
    });
    await user.click(saveButton());
    await within(correctionForm()).findByRole('alert');
    const before = requests.length;

    await user.click(within(correctionForm()).getByRole('button', { name: 'Verwerfen und neu laden' }));
    expect(await screen.findByText('Die Korrektur wurde verworfen. Der aktuelle Stand wird neu geladen.')).toBeTruthy();
    expect(requests.slice(before).map((request) => request.path)).toContain(DEC_LIST);
    await waitFor(async () => expect(rowNames(await table())).toEqual(['Lena Muster']));
    expect(screen.queryByRole('form', { name: /korrigieren$/ })).toBeNull();
    expect(patches(requests)).toHaveLength(1);
  });
});

describe('SP-09 correction — unsaved changes and navigation (the page\'s one data-router blocker)', () => {
  const prompt = (name = 'Ungespeicherte Zuordnungskorrektur') => screen.queryByRole('group', { name });

  async function dirtyCorrection(user: User, name = 'Mira Beispiel') {
    await openCorrection(user, name);
    await user.selectOptions(employeeSelect(), tom.id);
  }

  it('month links ask first; "Weiter bearbeiten" keeps everything; discarding is explicit and sends nothing', async () => {
    const { location, requests } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await dirtyCorrection(user);
    await setMonth(user, '2027-03');

    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    await user.click(next);
    expect(location()).toBe(PATH);
    const held = prompt()!;
    expect(held.textContent).toContain('Die Korrektur einer Zuordnung im Dezember 2026 ist noch nicht gespeichert.');
    await waitFor(() => expect(document.activeElement).toBe(within(held).getByRole('heading', { name: 'Ungespeicherte Zuordnungskorrektur' })));
    await user.click(within(held).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(prompt()).toBeNull();
    expect(document.activeElement).toBe(next);
    expect(employeeSelect().value).toBe(tom.id);
    expect(monthField().value).toBe('2027-03');

    await user.click(screen.getByRole('link', { name: 'Vorheriger Monat: November 2026' }));
    await user.click(within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    expect(location()).toBe(`${PATH}/2026-11`);
    expect(await screen.findByText('Für November 2026 sind diesem Projekt noch keine Mitarbeitenden zugeordnet.')).toBeTruthy();
    expect(patches(requests)).toEqual([]);
  });

  it('an untouched correction form never blocks', async () => {
    const { location } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(prompt()).toBeNull();
  });

  it('a switch to another project and the back link are held as well', async () => {
    const { router, location } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await dirtyCorrection(user);
    await act(async () => { await router.navigate(MESSE_PATH); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(PATH);
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));

    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await user.click(within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    expect(location()).toBe('/projekte');
  });

  it('Browser Back and Forward (POP) are held', async () => {
    const { router, location } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    // History: December -> January (clean step), then back to December.
    await user.click(await screen.findByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(rowNames(await table('Januar 2027'))).toEqual(['Jonas Albrecht']);
    await act(async () => { await router.navigate(-1); });
    expect(location()).toBe(PATH);

    await dirtyCorrection(user);
    await act(async () => { await router.navigate(1); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(PATH);
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(employeeSelect().value).toBe(tom.id);

    await act(async () => { await router.navigate(1); });
    await user.click(within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    await waitFor(() => expect(location()).toBe(`${PATH}/2027-01`));

    await dirtyCorrection(user, 'Jonas Albrecht');
    await act(async () => { await router.navigate(-1); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(`${PATH}/2027-01`);
  });

  it('sign-out / session loss (marked REPLACE to "/") passes; an unmarked REPLACE stays held', async () => {
    const { router, location } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await dirtyCorrection(user);

    await act(async () => { await router.navigate('/', { replace: true }); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(PATH);
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));

    await act(async () => { await router.navigate('/', { replace: true, state: SESSION_REDIRECT_STATE }); });
    expect(location()).toBe('/');
    expect(prompt()).toBeNull();
  });

  it('asks the browser before a reload only while there are unsaved changes or a running save', async () => {
    const server = company();
    const held = holding(server, (request) => request.method === 'PATCH');
    renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    const reload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await openCorrection(user);
    expect(reload()).toBe(false);
    await user.selectOptions(projectSelect(), messe.id);
    expect(reload()).toBe(true);
    await user.click(saveButton());
    await screen.findByRole('button', { name: 'Wird gespeichert …' });
    expect(reload()).toBe(true);
    held.release();
    expect(await screen.findByText(/Die Zuordnung wurde korrigiert/)).toBeTruthy();
    expect(reload()).toBe(false);
  });

  it('leaving during a running save is confirmed first; its outcome never shows up in the new month', async () => {
    const server = company();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { location } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(projectSelect(), messe.id);
    await user.click(saveButton());
    await screen.findByRole('button', { name: 'Wird gespeichert …' });

    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    const running = screen.getByRole('group', { name: 'Speichern läuft noch' });
    expect(running.textContent).toContain('Die Korrektur einer Zuordnung im Dezember 2026 wird gerade gespeichert.');
    expect(running.textContent).toContain('Ein Wechsel bricht das Speichern nicht ab');
    expect(running.textContent).toContain('Prüfen Sie die Zuordnungen danach.');
    await user.click(within(running).getByRole('button', { name: 'Trotzdem wechseln' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(rowNames(await table('Januar 2027'))).toEqual(['Jonas Albrecht']);

    held.release();
    await waitFor(() => expect(server.state.assignments[0].projectId).toBe(messe.id));
    expect(screen.queryByText(/Die Zuordnung wurde korrigiert/)).toBeNull();
    expect(rowNames(await table('Januar 2027'))).toEqual(['Jonas Albrecht']);
  });

  it('a save that fails while the prompt is open turns back into the unsaved question; staying shows the error and the input', async () => {
    const server = company();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { location } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await dirtyCorrection(user);
    await user.click(saveButton());
    await screen.findByRole('button', { name: 'Wird gespeichert …' });
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(prompt('Speichern läuft noch')).toBeTruthy();

    // Tom is assigned to Messe in December: the API answers with a conflict.
    held.release();
    expect(await screen.findByRole('group', { name: 'Ungespeicherte Zuordnungskorrektur' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(location()).toBe(PATH);
    expect((await within(correctionForm()).findByRole('alert')).textContent).toContain('Bereits einem anderen Projekt zugeordnet');
    expect(employeeSelect().value).toBe(tom.id);
  });

  it('a successful save while the prompt is open leaves a neutral question that names the correction', async () => {
    const server = company();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { location } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    await user.selectOptions(employeeSelect(), jonas.id);
    await user.click(saveButton());
    await screen.findByRole('button', { name: 'Wird gespeichert …' });
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));

    held.release();
    expect(await screen.findByRole('group', { name: 'Keine ungespeicherte Zuordnungskorrektur mehr' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hier bleiben' }));
    expect(location()).toBe(PATH);
    expect(screen.getByText(/Die Zuordnung wurde korrigiert: Jonas Albrecht/)).toBeTruthy();
  });

  it('unsaved shift times AND an unsaved correction: ONE prompt names both', async () => {
    const { location } = renderProjects(PATH, company().handler);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Schichtzeiten ab Dezember 2026 festlegen' }));
    const end = await screen.findByLabelText('Ende Tagschicht') as HTMLInputElement;
    await user.clear(end);
    await user.type(end, '17:45');
    await dirtyCorrection(user);

    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(screen.getAllByRole('group', { name: 'Ungespeicherte Änderungen' })).toHaveLength(1);
    const both = prompt('Ungespeicherte Änderungen')!;
    expect(both.textContent).toContain('Die Änderungen an den Schichtzeiten ab Dezember 2026 sind noch nicht gespeichert.');
    expect(both.textContent).toContain('Die Korrektur einer Zuordnung im Dezember 2026 ist noch nicht gespeichert.');
    await user.click(within(both).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(end.value).toBe('17:45');
    expect(employeeSelect().value).toBe(tom.id);

    // Cancelling the correction leaves only the shift times guarded.
    await user.click(within(correctionForm()).getByRole('button', { name: 'Abbrechen' }));
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(prompt('Ungespeicherte Schichtzeiten')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    expect(location()).toBe(`${PATH}/2027-01`);
  });

  it('under StrictMode (double effects, as on the dev server) the prompt still returns focus to the triggering link', async () => {
    renderProjects(PATH, company().handler, undefined, { strict: true });
    const user = userEvent.setup();
    await dirtyCorrection(user);
    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    await user.click(next);
    await waitFor(() => expect(document.activeElement).toBe(within(prompt()!).getByRole('heading', { name: 'Ungespeicherte Zuordnungskorrektur' })));
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(document.activeElement).toBe(next);
    expect(employeeSelect().value).toBe(tom.id);
  });
});

describe('SP-09 correction — inactive project', () => {
  it('existing assignments of an inactive project can still be corrected; the server decides what is allowed', async () => {
    const server = company();
    server.state.projects[0] = { ...hafen, status: 'INACTIVE' };
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openCorrection(user);
    expect(optionTexts(projectSelect())).toEqual(['Demo-Objekt Hafen – inaktiv – aktuell', 'Demo-Objekt Messe']);
    await setMonth(user, '2027-01');
    server.fail((request) => (request.method === 'PATCH' ? httpError(409, 'PROJECT_INACTIVE') : undefined));
    await user.click(saveButton());
    expect((await within(correctionForm()).findByRole('alert')).textContent).toContain('Projekt ist inaktiv');
    expect(patches(requests).map((request) => request.body)).toEqual([{ monthStart: JAN }]);
  });
});
