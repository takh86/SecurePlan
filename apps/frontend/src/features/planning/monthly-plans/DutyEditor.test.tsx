// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/monatsplanung"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../shared/api/api-error';
import { httpError, type RecordedRequest } from '../../employees/employees.test-support';
import {
  JONAS_ID,
  LEA_ID,
  MIRA_ID,
  OSKAR_ID,
  PLAN_ID,
  duty,
  hafen,
  member,
  plan,
  planningCompany,
} from './monthly-planning.test-support';
import { renderPlanning } from './monthly-planning-render.test-support';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PLAN_PATH = `/monatsplanung/${PLAN_ID}`;
const PLAN_URL = `/api/v1/monthly-plans/${PLAN_ID}`;
const DEC_3 = { dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' };
const EDITOR = 'Tagdienst am Do., 03.12.2026 bearbeiten';

/** A day duty on 3 Dec 2026 with Mira (shift lead) and Jonas; synthetic example. */
function setup(options: Parameters<typeof planningCompany>[0] = {}, render: { strict?: boolean } = {}) {
  const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] });
  const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] }, ...options });
  const view = renderPlanning(PLAN_PATH, server.handler, render);
  const dutyUrl = `${PLAN_URL}/entries/${stored.id}`;
  return { ...view, server, stored, dutyUrl, leaseUrl: `${dutyUrl}/edit-lease` };
}

function editor() {
  return screen.getByRole('region', { name: EDITOR });
}

function cell(name: string) {
  return within(screen.getByRole('grid')).getByRole('button', { name });
}

/** Opens the editor from Mira's cell (she becomes the focused person) and waits until it is editable. */
async function openEditor(user = userEvent.setup(), from = 'Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung') {
  await user.click(await screen.findByRole('button', { name: from }));
  const details = screen.getByRole('region', { name: /Do., 03.12.2026/ });
  await user.click(within(details).getByRole('button', { name: 'Tagdienst bearbeiten' }));
  await within(editor()).findByLabelText('Datum');
  return user;
}

function checkbox(name: string) {
  return within(editor()).getByRole('checkbox', { name }) as HTMLInputElement;
}

function writes(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method !== 'GET');
}

describe('SP-12 A10 — duty editor: lease, read, edit', () => {
  it('acquires the lease first, then reads the duty and the plan; the token stays in memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { requests, server, stored, dutyUrl, leaseUrl } = setup();
    await openEditor();
    const opened = requests.slice(requests.findIndex((request) => request.path === leaseUrl));
    expect(opened.map((request) => `${request.method} ${request.path}`).slice(0, 3).sort()).toEqual([
      `GET ${PLAN_URL}`, `GET ${dutyUrl}`, `POST ${leaseUrl}`,
    ].sort());
    expect(opened[0]).toMatchObject({ method: 'POST', path: leaseUrl });
    expect(editor().textContent).toContain('Für Sie reserviert');
    expect(editor().textContent).toContain('Gespeicherte Änderungen werden Teil der späteren Veröffentlichung.');
    expect((within(editor()).getByLabelText('Datum') as HTMLInputElement).value).toBe('2026-12-03');
    expect((within(editor()).getByRole('radio', { name: 'Tagdienst' }) as HTMLInputElement).checked).toBe(true);
    // The person of the selected cell comes first; members are ticked with their duty role.
    const roster = within(editor()).getByRole('list', { name: 'Besetzung des Dienstes' });
    expect(within(roster).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual([
      'Mira Beispiel (A-001)', 'Jonas Muster (A-002)', 'Lea Probe (A-003)',
    ]);
    expect(checkbox('Mira Beispiel (A-001)').checked).toBe(true);
    expect((within(editor()).getByRole('combobox', { name: 'Funktion im Dienst für Mira Beispiel' }) as HTMLSelectElement).value).toBe('SHIFT_LEAD');
    expect(checkbox('Lea Probe (A-003)').checked).toBe(false);
    // Oskar (deactivated) is listed as not selectable, never offered.
    expect(within(editor()).getByText('1 weitere zugeordnete Person ist nicht auswählbar')).toBeTruthy();
    expect(within(editor()).getByRole('button', { name: 'Änderungen speichern' }).hasAttribute('disabled')).toBe(true);
    expect(editor().textContent).toContain('Keine ungespeicherten Änderungen.');

    const token = server.state.leases[stored.id].token;
    expect(document.body.innerHTML).not.toContain(token);
    expect(window.location.href).not.toContain(token);
    expect(setItem).not.toHaveBeenCalled();
    expect(cell('Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung').className).toContain('planning-matrix__cell--editing');
  });

  it('saves exactly one PATCH with only the roster, Expected-Version and the lease token; then releases the lease', async () => {
    const { requests, server, stored, dutyUrl, leaseUrl } = setup();
    const user = await openEditor();
    const token = server.state.leases[stored.id].token;
    await user.click(checkbox('Jonas Muster (A-002)'));
    await user.click(checkbox('Lea Probe (A-003)'));
    const pending = editor().textContent!;
    expect(pending).toContain('Eingeplant: Lea Probe');
    expect(pending).toContain('Ausgetragen: Jonas Muster');
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));

    const notice = await screen.findByText('Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    const patch = requests.filter((request) => request.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0]).toEqual({
      path: dutyUrl,
      method: 'PATCH',
      body: { assignments: [{ employeeId: MIRA_ID, dutyRole: 'SHIFT_LEAD' }, { employeeId: LEA_ID, dutyRole: 'EMPLOYEE' }] },
      expectedVersion: 1,
      editLeaseToken: token,
    });
    expect(cell('Lea Probe, Do., 3. Dezember: Tagdienst').textContent).toBe('Tag');
    expect(cell('Jonas Muster, Do., 3. Dezember: frei').textContent).toBe('–');
    expect(screen.queryByRole('region', { name: EDITOR })).toBeNull();
    // Closing the editor gave the lease back with the same token; nothing else was written.
    await waitFor(() => expect(server.state.leases[stored.id].live).toBe(false));
    expect(writes(requests).map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${leaseUrl}`, `PATCH ${dutyUrl}`, `DELETE ${leaseUrl}`,
    ]);
    expect(requests.find((request) => request.method === 'DELETE')?.editLeaseToken).toBe(token);
  });

  it('moving the date sends only the date; the duty time is resolved anew by the server', async () => {
    const { requests } = setup();
    const user = await openEditor();
    fireEvent.change(within(editor()).getByLabelText('Datum'), { target: { value: '2026-12-04' } });
    expect(editor().textContent).toContain('wird beim Speichern aus den Schichtzeiten des Projekts neu bestimmt');
    expect(editor().textContent).toContain('Datum: Do., 03.12.2026 → Fr., 04.12.2026');
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText('Die Änderungen am Tagdienst am Fr., 04.12.2026 wurden gespeichert.')).toBeTruthy();
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ dutyDate: '2026-12-04' });
    expect(cell('Mira Beispiel, Fr., 4. Dezember: Tagdienst, Schichtleitung')).toBeTruthy();
    expect(cell('Mira Beispiel, Do., 3. Dezember: frei')).toBeTruthy();
  });

  it('a kind change flags a member who is not eligible for it; removing them sends kind and roster', async () => {
    const { requests } = setup();
    const user = await openEditor();
    await user.click(within(editor()).getByRole('radio', { name: 'Nachtdienst' }));
    expect(editor().textContent).toContain('Dienstart: Tagdienst → Nachtdienst');
    // Jonas is eligible for day duties only (synthetic example).
    const jonas = checkbox('Jonas Muster (A-002)');
    expect(document.getElementById(jonas.getAttribute('aria-describedby')!)!.textContent)
      .toBe('Nicht für diese Dienstart freigegeben: Solange die Person eingeplant ist, wird eine Änderung voraussichtlich abgelehnt.');
    await user.click(jonas);
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText('Die Änderungen am Nachtdienst am Do., 03.12.2026 wurden gespeichert.')).toBeTruthy();
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      shiftKind: 'NIGHT', assignments: [{ employeeId: MIRA_ID, dutyRole: 'SHIFT_LEAD' }],
    });
    expect(cell('Mira Beispiel, Do., 3. Dezember: Nachtdienst, Schichtleitung').textContent).toBe('NachtSL');
  });

  it('catches an occupied date/kind and a date outside the plan month before sending', async () => {
    const other = duty({ dutyDate: '2026-12-04', startsAt: '2026-12-04T05:00:00Z', endsAt: '2026-12-04T17:00:00Z' });
    const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID)] });
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored, other] } });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = await openEditor(userEvent.setup(), 'Mira Beispiel, Do., 3. Dezember: Tagdienst');
    const date = within(editor()).getByLabelText('Datum');
    fireEvent.change(date, { target: { value: '2026-12-04' } });
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(within(editor()).getByText('Am Fr., 04.12.2026 gibt es in diesem Plan bereits einen Tagdienst.')).toBeTruthy();
    expect(date.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(date, { target: { value: '2027-01-01' } });
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(within(editor()).getByText('Das Datum muss im Dezember 2026 liegen.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH')).toEqual([]);
  });

  it('CR-03: in a PUBLISHED plan the editor says changes apply at once; saving needs no publish step', async () => {
    const published = plan({ status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' });
    const { requests } = setup({ plans: [published] });
    const user = await openEditor();
    expect(editor().textContent).toContain('Gespeicherte Änderungen gelten sofort im veröffentlichten Plan; ein erneutes Veröffentlichen ist nicht nötig.');
    await user.click(checkbox('Lea Probe (A-003)'));
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText(/wurden gespeichert\. Der Plan ist veröffentlicht: Die Änderung gilt sofort, ohne erneutes Veröffentlichen\./)).toBeTruthy();
    expect(requests.every((request) => !/publish/i.test(request.path))).toBe(true);
  });

  it('the plan status is re-read when the lease is granted: a plan published meanwhile is shown as published', async () => {
    const { server } = setup();
    await screen.findByRole('grid');
    // Another admin published after this page was loaded (synthetic).
    server.state.plans[0] = plan({ status: 'PUBLISHED', publishedAt: '2026-12-01T08:00:00Z' });
    await openEditor();
    expect(editor().textContent).toContain('Gespeicherte Änderungen gelten sofort im veröffentlichten Plan');
    const status = screen.getByRole('heading', { level: 2, name: 'Planstatus' }).closest('section')!;
    expect(status.textContent).toContain('Veröffentlicht am Di., 01.12.2026, 09:00 MEZ.');
  });
});

describe('SP-12 A10 — duty editor: another editor, conflicts and lost responses', () => {
  it('another admin holds the lease: read-only with the reason; retry acquires once the lease is free', async () => {
    const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD')] });
    const server = planningCompany({
      plans: [plan()],
      duties: { [PLAN_ID]: [stored] },
      leases: { [stored.id]: { token: 'o'.repeat(43), holder: 'other', live: true } },
    });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = await openEditorReadOnly();
    expect(editor().textContent).toContain('Dieser Dienst wird gerade von einer anderen Person bearbeitet.');
    expect(editor().textContent).toContain('Mira Beispiel · Schichtleitung');
    expect(within(editor()).queryByLabelText('Datum')).toBeNull();
    expect(within(editor()).queryByRole('button', { name: 'Dienst löschen' })).toBeNull();
    await user.click(within(editor()).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(editor()).findByText(/Dieser Dienst wird gerade von einer anderen Person bearbeitet/)).toBeTruthy();

    server.state.leases[stored.id].live = false;
    await user.click(within(editor()).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(editor()).findByLabelText('Datum')).toBeTruthy();
    expect(editor().textContent).toContain('Für Sie reserviert');
    expect(requests.filter((request) => request.method === 'POST' && request.path.endsWith('/edit-lease'))).toHaveLength(3);
    expect(requests.some((request) => request.method === 'PATCH' || (request.method === 'DELETE' && !request.path.endsWith('/edit-lease')))).toBe(false);

    async function openEditorReadOnly() {
      const actor = userEvent.setup();
      await actor.click(await screen.findByRole('button', { name: 'Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung' }));
      await actor.click(within(screen.getByRole('region', { name: /Do., 03.12.2026/ })).getByRole('button', { name: 'Tagdienst bearbeiten' }));
      await within(editor()).findByText(/von einer anderen Person bearbeitet/);
      return actor;
    }
  });

  it('a version conflict overwrites nothing, keeps the input visible, and loads the current state only on request', async () => {
    const { requests, server, stored } = setup();
    const user = await openEditor();
    await user.click(checkbox('Lea Probe (A-003)'));
    // Another writer changed the duty meanwhile (synthetic: version and roster moved on).
    const current = server.state.duties[PLAN_ID][0];
    current.version = 2;
    current.assignments = [member(MIRA_ID, 'SHIFT_LEAD')];
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));

    const alert = await within(editor()).findByRole('alert');
    expect(alert.textContent).toContain('Dienst wurde inzwischen geändert');
    expect(alert.textContent).toContain('Es wurde nichts überschrieben.');
    expect(alert.textContent).toContain('Eingeplant: Lea Probe');
    expect(checkbox('Lea Probe (A-003)').checked).toBe(true);
    expect(within(editor()).getByRole('button', { name: 'Änderungen speichern' }).hasAttribute('disabled')).toBe(true);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(server.state.duties[PLAN_ID][0].assignments.map((item) => item.employeeId)).toEqual([MIRA_ID]);

    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(await within(editor()).findByText('Der aktuelle Stand wurde geladen.')).toBeTruthy();
    expect(checkbox('Lea Probe (A-003)').checked).toBe(false);
    expect(checkbox('Jonas Muster (A-002)').checked).toBe(false);
    // The matrix shows the newer server state too.
    expect(cell('Jonas Muster, Do., 3. Dezember: frei')).toBeTruthy();
    // Saving again uses the new version.
    await user.click(checkbox('Lea Probe (A-003)'));
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText(/wurden gespeichert/)).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH').map((request) => request.expectedVersion)).toEqual([1, 2]);
    expect(server.state.leases[stored.id]).toBeDefined();
  });

  it('a conflict whose current state already equals the input (e.g. a browser re-send) is reported as saved', async () => {
    const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] });
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
    let resend = false;
    const { requests } = renderPlanning(PLAN_PATH, (request) => {
      if (resend && request.method === 'PATCH') {
        // The first attempt committed but its connection dropped; the transport re-sent it.
        resend = false;
        server.handler(request);
      }
      return server.handler(request);
    });
    const user = await openEditor();
    await user.click(checkbox('Lea Probe (A-003)'));
    resend = true;
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    const alert = await within(editor()).findByRole('alert');
    expect(alert.textContent).toContain('Dienst wurde inzwischen geändert');
    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(await screen.findByText(
      'Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert. Das hat das erneute Laden des aktuellen Stands bestätigt.',
    )).toBeTruthy();
    expect(cell('Lea Probe, Do., 3. Dezember: Tagdienst')).toBeTruthy();
    expect(server.state.duties[PLAN_ID][0].version).toBe(2);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('a lost lease keeps the input; re-acquiring checks the version and saves with the NEW token', async () => {
    const { requests, server, stored } = setup();
    const user = await openEditor();
    const firstToken = server.state.leases[stored.id].token;
    await user.click(checkbox('Lea Probe (A-003)'));
    server.state.leases[stored.id].live = false; // expired on the server
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));

    expect(await within(editor()).findByText('Reservierung abgelaufen', { selector: '.api-error-alert__title' })).toBeTruthy();
    expect(editor().textContent).toContain('Ihre Reservierung für diesen Dienst gilt nicht mehr. Es wurde nichts geändert.');
    expect(editor().textContent).toContain('Ihre Eingaben sind erhalten, aber noch nicht gespeichert.');
    expect(checkbox('Lea Probe (A-003)').checked).toBe(true);
    expect(within(editor()).getByRole('button', { name: 'Änderungen speichern' }).hasAttribute('disabled')).toBe(true);

    await user.click(within(editor()).getByRole('button', { name: 'Erneut reservieren' }));
    expect(await within(editor()).findByText(/wieder für Sie reserviert und unverändert/)).toBeTruthy();
    const secondToken = server.state.leases[stored.id].token;
    expect(secondToken).not.toBe(firstToken);
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText(/wurden gespeichert/)).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH').map((request) => request.editLeaseToken)).toEqual([firstToken, secondToken]);
  });

  it('a lost PATCH response is never retried; checking shows the change was NOT applied and keeps the input', async () => {
    const { requests, server } = setup();
    const user = await openEditor();
    await user.click(checkbox('Lea Probe (A-003)'));
    server.fail((request) => (request.method === 'PATCH' ? new ApiError('network', null, null, null) : undefined));
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    const alert = await within(editor()).findByRole('alert');
    expect(alert.textContent).toContain('Ergebnis unbekannt');
    expect(alert.textContent).toContain('Ob die Änderungen gespeichert wurden, ist unklar.');
    expect(within(editor()).getByRole('button', { name: 'Änderungen speichern' }).hasAttribute('disabled')).toBe(true);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);

    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand prüfen' }));
    expect(await within(editor()).findByText(/Die Änderungen wurden nicht gespeichert; der Dienst ist unverändert/)).toBeTruthy();
    expect(checkbox('Lea Probe (A-003)').checked).toBe(true);
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText('Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
  });

  it('a lost PATCH response after the server committed: checking confirms the save', async () => {
    const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] });
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
    let loseNext = false;
    const { requests } = renderPlanning(PLAN_PATH, (request) => {
      const answer = server.handler(request);
      if (loseNext && request.method === 'PATCH') {
        loseNext = false;
        throw new ApiError('network', null, null, null);
      }
      return answer;
    });
    const user = await openEditor();
    await user.click(checkbox('Jonas Muster (A-002)'));
    loseNext = true;
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    await user.click(within(await within(editor()).findByRole('alert')).getByRole('button', { name: 'Aktuellen Stand prüfen' }));
    expect(await screen.findByText(
      'Die Änderungen am Tagdienst am Do., 03.12.2026 wurden gespeichert. Das hat das erneute Laden des aktuellen Stands bestätigt.',
    )).toBeTruthy();
    expect(cell('Jonas Muster, Do., 3. Dezember: frei')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it.each([
    ['EMPLOYEE_UNAVAILABLE', 'Person nicht verfügbar'],
    ['DUTY_ASSIGNMENT_CONFLICT', 'Zeitliche Überschneidung'],
    ['PROJECT_INACTIVE', 'Projekt ist inaktiv'],
    // A1 (#90): changed work is validated; the texts keep removal as the correction path.
    ['PROJECT_CALENDAR_MISSING', 'Keine Betriebstage festgelegt'],
    ['PROJECT_CLOSED_WEEKDAY', 'Kein Betriebstag'],
    ['EMPLOYEE_DAILY_SHIFT_CONFLICT', 'Tag- und Nachtdienst am selben Tag'],
  ] as const)('a business refusal %s says nothing was changed and keeps input and lease', async (code, title) => {
    const { server } = setup();
    const user = await openEditor();
    await user.click(checkbox('Lea Probe (A-003)'));
    server.fail((request) => (request.method === 'PATCH' ? httpError(409, code) : undefined));
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    const alert = await within(editor()).findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain('Es wurde nichts geändert.');
    expect(alert.textContent).not.toMatch(/krank|urlaub/i);
    expect(checkbox('Lea Probe (A-003)').checked).toBe(true);
    expect(editor().textContent).toContain('Für Sie reserviert');
  });

  it('flags a member who no longer meets the rules, without hiding them', async () => {
    const stored = duty({ ...DEC_3, assignments: [member(OSKAR_ID)] });
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
    renderPlanning(PLAN_PATH, server.handler);
    await openEditor(userEvent.setup(), 'Oskar Test, Do., 3. Dezember: Tagdienst');
    const box = checkbox('Oskar Test (A-004)');
    expect(box.checked).toBe(true);
    const note = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(note.textContent).toContain('Deaktiviert: Solange die Person eingeplant ist, wird eine Änderung voraussichtlich abgelehnt.');
  });
});

describe('SP-12 A10 — duty removal and leaving the editor', () => {
  it('asks before deleting; cancelling sends nothing; confirming deletes once with version and token', async () => {
    const { requests, server, stored, dutyUrl, leaseUrl } = setup();
    const user = await openEditor();
    const token = server.state.leases[stored.id].token;
    await user.click(within(editor()).getByRole('button', { name: 'Dienst löschen' }));
    const confirm = within(editor()).getByRole('group', { name: 'Tagdienst am Do., 03.12.2026 löschen?' });
    await waitFor(() => expect(document.activeElement).toBe(within(confirm).getByRole('heading')));
    expect(confirm.textContent).toContain('2 eingeplante Personen werden aus diesem Dienst ausgetragen.');
    expect(confirm.textContent).toContain('Der Plan ist noch nicht veröffentlicht.');
    expect(confirm.textContent).toContain('Wurde der Dienst inzwischen geändert, wird er nicht gelöscht.');
    await user.click(within(confirm).getByRole('button', { name: 'Abbrechen' }));
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);

    await user.click(within(editor()).getByRole('button', { name: 'Dienst löschen' }));
    await user.click(within(editor()).getByRole('button', { name: 'Ja, Dienst löschen' }));
    const notice = await screen.findByText('Der Tagdienst am Do., 03.12.2026 wurde gelöscht.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    expect(server.state.duties[PLAN_ID]).toEqual([]);
    expect(cell('Mira Beispiel, Do., 3. Dezember: frei')).toBeTruthy();
    expect(cell('Do., 3. Dezember: kein Tagdienst; kein Nachtdienst')).toBeTruthy();
    // The removal released the lease on the server; no separate release follows.
    expect(writes(requests).map((request) => `${request.method} ${request.path}`)).toEqual([`POST ${leaseUrl}`, `DELETE ${dutyUrl}`]);
    expect(requests.find((request) => request.path === dutyUrl && request.method === 'DELETE')).toMatchObject({
      expectedVersion: 1, editLeaseToken: token,
    });
  });

  it('CR-03: deleting from a PUBLISHED plan says it applies at once', async () => {
    setup({ plans: [plan({ status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' })] });
    const user = await openEditor();
    await user.click(within(editor()).getByRole('button', { name: 'Dienst löschen' }));
    expect(within(editor()).getByRole('group', { name: /löschen\?$/ }).textContent)
      .toContain('Der Plan ist veröffentlicht: Das Löschen gilt sofort, ohne erneutes Veröffentlichen.');
    await user.click(within(editor()).getByRole('button', { name: 'Ja, Dienst löschen' }));
    expect(await screen.findByText('Der Tagdienst am Do., 03.12.2026 wurde gelöscht. Der Plan ist veröffentlicht: Die Löschung gilt sofort.')).toBeTruthy();
  });

  it('a lost DELETE response: checking finds the duty gone and reports the deletion as complete', async () => {
    const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD')] });
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
    let loseNext = false;
    const { requests } = renderPlanning(PLAN_PATH, (request) => {
      const answer = server.handler(request);
      if (loseNext && request.method === 'DELETE') {
        loseNext = false;
        throw new ApiError('network', null, null, null);
      }
      return answer;
    });
    const user = await openEditor();
    await user.click(within(editor()).getByRole('button', { name: 'Dienst löschen' }));
    loseNext = true;
    await user.click(within(editor()).getByRole('button', { name: 'Ja, Dienst löschen' }));
    const alert = await within(editor()).findByRole('alert');
    expect(alert.textContent).toContain('Ob der Dienst gelöscht wurde, ist unklar.');
    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand prüfen' }));
    expect(await screen.findByText('Der Tagdienst am Do., 03.12.2026 ist nicht mehr vorhanden; das Löschen ist damit abgeschlossen.')).toBeTruthy();
    expect(requests.filter((request) => request.method === 'DELETE' && !request.path.endsWith('/edit-lease'))).toHaveLength(1);
  });

  it('an inactive project: the editor allows deletion only and says why', async () => {
    setup({ projects: [{ ...hafen, status: 'INACTIVE' }] });
    await openEditor();
    expect(editor().textContent).toContain('Das Projekt ist inaktiv: Datum, Dienstart und Besetzung können nicht geändert werden. Löschen bleibt möglich.');
    expect((within(editor()).getByLabelText('Datum') as HTMLInputElement).disabled).toBe(true);
    expect(within(editor()).getByRole('button', { name: 'Dienst löschen' }).hasAttribute('disabled')).toBe(false);
  });

  it('unsaved edits hold navigation; discarding leaves once and releases the lease', async () => {
    const { requests, server, stored, location, leaseUrl } = setup();
    const user = await openEditor();
    await user.click(checkbox('Lea Probe (A-003)'));
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    const prompt = await screen.findByRole('group', { name: 'Ungespeicherte Änderungen' });
    expect(prompt.textContent).toContain('die Reservierung des Dienstes wird freigegeben');
    await user.click(within(prompt).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(checkbox('Lea Probe (A-003)').checked).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await user.click(await screen.findByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
    await waitFor(() => expect(server.state.leases[stored.id].live).toBe(false));
    expect(requests.filter((request) => request.path === leaseUrl && request.method === 'DELETE')).toHaveLength(1);
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('closing with unsaved edits asks first; a clean close releases the lease at once', async () => {
    const { server, stored } = setup();
    const user = await openEditor();
    await user.click(checkbox('Lea Probe (A-003)'));
    await user.click(within(editor()).getByRole('button', { name: 'Schließen' }));
    const prompt = within(editor()).getByRole('group', { name: 'Ungespeicherte Änderungen' });
    await user.click(within(prompt).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    expect(screen.queryByRole('region', { name: EDITOR })).toBeNull();
    await waitFor(() => expect(server.state.leases[stored.id].live).toBe(false));
    // Focus returns to the matrix cell that opened the panel.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung');
  });

  it('works under StrictMode: one live lease, one PATCH', async () => {
    const { requests, server, stored } = setup({}, { strict: true });
    const user = await openEditor();
    await waitFor(() => expect(editor().textContent).toContain('Für Sie reserviert'));
    await user.click(checkbox('Lea Probe (A-003)'));
    await user.click(within(editor()).getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText(/wurden gespeichert/)).toBeTruthy();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(server.state.duties[PLAN_ID][0].assignments.map((item) => item.employeeId).sort())
      .toEqual([MIRA_ID, JONAS_ID, LEA_ID].sort());
    await waitFor(() => expect(server.state.leases[stored.id].live).toBe(false));
  });
});

describe('SP-12 A10 — lease renewal while the editor is open (fake timers)', () => {
  it('renews with the same token about every 60 s; a refused renewal shows the loss and keeps the input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests, server, stored, leaseUrl } = setup();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openEditor(user);
    const token = server.state.leases[stored.id].token;
    await user.click(checkbox('Lea Probe (A-003)'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    const renewals = () => requests.filter((request) => request.path === leaseUrl && request.method === 'PUT');
    expect(renewals()).toHaveLength(1);
    expect(renewals()[0].editLeaseToken).toBe(token);
    expect(editor().textContent).toContain('Für Sie reserviert');

    server.state.leases[stored.id].live = false; // e.g. taken over after an expiry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(renewals()).toHaveLength(2);
    expect(await within(editor()).findByText(/Ihre Reservierung gilt nicht mehr/)).toBeTruthy();
    expect(checkbox('Lea Probe (A-003)').checked).toBe(true);
    expect(within(editor()).getByRole('button', { name: 'Änderungen speichern' }).hasAttribute('disabled')).toBe(true);
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });
});
