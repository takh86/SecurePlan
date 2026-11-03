// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/monatsplanung"}
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, type KnownErrorCode } from '../../../shared/api/api-error';
import { installDialogPolyfill } from '../../../shared/ui/native-dialog.test-support';
import { deferred, httpError, type Handler, type RecordedRequest } from '../../employees/employees.test-support';
import {
  JONAS_ID,
  MIRA_ID,
  PLAN_ID,
  duty,
  hafen,
  isPublish,
  member,
  plan,
  planningCompany,
} from './monthly-planning.test-support';
import { renderPlanning } from './monthly-planning-render.test-support';

beforeAll(() => installDialogPolyfill());
afterEach(() => cleanup());

const PLAN_PATH = `/monatsplanung/${PLAN_ID}`;
const PLAN_URL = `/api/v1/monthly-plans/${PLAN_ID}`;
const ENTRIES = `${PLAN_URL}/entries`;
const PUBLISH_URL = `${PLAN_URL}/publish`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRIGGER = 'Monatsplan veröffentlichen …';
const DIALOG = 'Monatsplan veröffentlichen?';

// Synthetic example duties (not business rules): one staffed day duty, one unstaffed night duty.
const DEC_3 = { dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' };
const DEC_31_NIGHT = { dutyDate: '2026-12-31', shiftKind: 'NIGHT' as const, startsAt: '2026-12-31T17:00:00Z', endsAt: '2027-01-01T05:00:00Z' };

function company(overrides: Parameters<typeof planningCompany>[0] = {}) {
  return planningCompany({
    plans: [plan()],
    duties: { [PLAN_ID]: [duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] }), duty(DEC_31_NIGHT)] },
    ...overrides,
  });
}

function statusSection() {
  return screen.getByRole('heading', { level: 2, name: 'Planstatus' }).closest('section') as HTMLElement;
}

/** The trigger, once the page and its duties are loaded and nothing blocks publishing. */
async function readyTrigger() {
  const trigger = await screen.findByRole('button', { name: TRIGGER });
  await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBeNull());
  return trigger;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await readyTrigger());
  return screen.getByRole('alertdialog', { name: DIALOG });
}

function confirmButton(dialog: HTMLElement) {
  return within(dialog).getByRole('button', { name: 'Jetzt veröffentlichen' });
}

const publishes = (requests: RecordedRequest[]) => requests.filter(isPublish);

/** An alert (role=alert has no name of its own) found by its heading. */
async function findAlert(title: string) {
  const heading = await screen.findByRole('heading', { level: 2, name: title });
  return heading.closest('[role="alert"]') as HTMLElement;
}
const planReads = (requests: RecordedRequest[]) => requests.filter((request) => request.method === 'GET' && request.path === PLAN_URL);

describe('SP-13 First Publish — confirmation dialog and the bodyless command', () => {
  it('confirms in a modal alertdialog, re-reads the duties, then sends ONE bodyless POST with a new key; PUBLISHED comes from the answer', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler, { strict: true });
    const user = userEvent.setup();
    const trigger = await readyTrigger();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    const before = requests.length;
    await user.click(trigger);

    const dialog = screen.getByRole('alertdialog', { name: DIALOG });
    expect(dialog.tagName).toBe('DIALOG');
    // Opened with showModal() (the page behind it is inert in a browser), exactly once even in StrictMode.
    expect(dialog.dataset.testModal).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent)
      .toContain('Sie veröffentlichen den Monatsplan Demo-Objekt Hafen – Dezember 2026 zum ersten Mal.');
    expect(within(dialog).getByText('Dienste').nextElementSibling!.textContent).toBe('2 (davon 1 ohne Besetzung)');
    expect(within(dialog).getByText('Eingeplante Personen').nextElementSibling!.textContent).toBe('2');
    expect(dialog.textContent).toContain('Danach gelten Änderungen an Diensten sofort, ohne erneutes Veröffentlichen.');
    // Versionless contract: the server publishes the state it finds at commit time; no snapshot-level promise.
    expect(dialog.textContent).toContain('Veröffentlicht wird der Stand, der beim Abschluss auf dem Server gespeichert ist.');
    expect(dialog.textContent).toContain('ist eine Regel verletzt, wird nichts veröffentlicht.');
    expect(dialog.textContent).toContain('Eine Änderung, die eine andere Administration unmittelbar danach speichert, kann trotzdem mitveröffentlicht werden.');
    expect(dialog.textContent).toContain('Dass genau der angezeigte Stand veröffentlicht wird, ist nicht garantiert.');
    // No notification and no employee visibility (SP-14 plan reads do not exist yet).
    expect(dialog.textContent).toContain('Es wird keine Benachrichtigung versendet. Mitarbeitende können veröffentlichte Monatspläne in dieser Ausbaustufe noch nicht abrufen.');
    expect(dialog.textContent).not.toMatch(/Mitarbeitende sehen/);
    // Least destructive action first: publication cannot be undone.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    // Opening the dialog sends nothing.
    expect(requests.slice(before)).toEqual([]);

    await user.click(confirmButton(dialog));
    const notice = await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    const sent = requests.slice(before);
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`GET ${ENTRIES}`, `POST ${PUBLISH_URL}`]);
    // No body, no company/actor/status, no Expected-Version or lease token: only the key (as a header).
    expect(sent[1]).toEqual({ path: PUBLISH_URL, method: 'POST', body: undefined, noBody: true, idempotencyKey: expect.stringMatching(UUID_V4) });
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(statusSection().textContent).toContain('Veröffentlicht am Di., 01.12.2026, 09:00 MEZ.');
    // No re-publish (CR-03).
    expect(within(statusSection()).queryByRole('button', { name: /veröffentlichen/i })).toBeNull();
    expect(notice.textContent).toContain('Änderungen an Diensten gelten ab jetzt sofort, ohne erneutes Veröffentlichen.');
    expect(document.activeElement).toBe(notice.closest('[tabindex="-1"]'));
    // Neither the result nor the new status claims an employee view or the exact reviewed snapshot.
    expect(statusSection().textContent).toContain('Mitarbeitende können veröffentlichte Monatspläne in dieser Ausbaustufe noch nicht abrufen.');
    expect(document.body.textContent).not.toMatch(/Mitarbeitende sehen|angezeigte Stand wurde veröffentlicht/);
    // The key never reaches the DOM.
    expect(document.body.innerHTML).not.toContain(sent[1].idempotencyKey!);
  });

  it.each(['the cancel button', 'Escape', 'a native cancel event', 'a browser close'])(
    'cancelling with %s sends nothing and returns focus to the trigger',
    async (how) => {
      const server = company();
      const { requests } = renderPlanning(PLAN_PATH, server.handler);
      const user = userEvent.setup();
      const trigger = await readyTrigger();
      const before = requests.length;
      await user.click(trigger);
      const dialog = screen.getByRole('alertdialog', { name: DIALOG });
      if (how === 'the cancel button') await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
      else if (how === 'Escape') await user.keyboard('{Escape}');
      else if (how === 'a browser close') (dialog as HTMLDialogElement).close();
      else {
        const event = new Event('cancel', { cancelable: true });
        fireEvent(dialog, event);
        // The component decides; the browser never closes the dialog behind its state.
        expect(event.defaultPrevented).toBe(true);
      }
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(requests.slice(before)).toEqual([]);
      expect(server.publishLog.publications).toBe(0);
    },
  );

  it('a double click, repeated Enter, clicks and Escape during the request send exactly one command; the dialog waits for the answer', async () => {
    const server = company();
    const gate = deferred<void>();
    const handler: Handler = async (request) => {
      if (isPublish(request)) await gate.promise;
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    const before = requests.length;
    await user.dblClick(confirmButton(dialog));
    await waitFor(() => expect(publishes(requests)).toHaveLength(1));

    const busy = within(dialog).getByRole('button', { name: 'Wird veröffentlicht …' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'Abbrechen' }).getAttribute('aria-disabled')).toBe('true');
    expect(dialog.textContent).toContain('Veröffentlichung wird übertragen …');
    busy.focus();
    await user.keyboard('{Enter}');
    await user.click(busy);
    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    // Nothing is claimed before the answer.
    expect(statusSection().textContent).toContain('Unveröffentlicht');

    gate.resolve();
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    expect(requests.slice(before).map((request) => `${request.method} ${request.path}`)).toEqual([`GET ${ENTRIES}`, `POST ${PUBLISH_URL}`]);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('an empty plan can be published: no staffing minimum is invented', async () => {
    const server = planningCompany({ plans: [plan()] });
    renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('Dienste').nextElementSibling!.textContent).toBe('keine');
    expect(dialog.textContent).toContain('Auch ein Plan ohne Dienste kann veröffentlicht werden.');
    await user.click(confirmButton(dialog));
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    expect(server.publishLog.publications).toBe(1);
  });
});

describe('SP-13 First Publish — what blocks the action', () => {
  it('an inactive project: the action is unavailable with its reason; no dialog, no request', async () => {
    const server = company({ projects: [{ ...hafen, status: 'INACTIVE' }] });
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: TRIGGER });
    await screen.findByRole('grid');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)!.textContent)
      .toContain('Der Monatsplan eines inaktiven Projekts kann nicht veröffentlicht werden');
    const before = requests.length;
    await user.click(trigger);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(requests.slice(before)).toEqual([]);
  });

  it('duties that could not be loaded block publishing (the admin must see what is published)', async () => {
    const server = company();
    server.fail((request) => (request.path === ENTRIES ? httpError(500, 'INTERNAL_ERROR') : undefined));
    renderPlanning(PLAN_PATH, server.handler);
    const trigger = await screen.findByRole('button', { name: TRIGGER });
    await screen.findAllByRole('alert');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)!.textContent)
      .toContain('erst möglich, wenn die Dienste dieses Plans vollständig geladen sind');
  });

  it('a clean, open editor (lease held) does not block; after publishing it says changes apply at once (CR-03)', async () => {
    const server = company();
    renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mira Beispiel, Do., 3. Dezember: Tagdienst, Schichtleitung' }));
    await user.click(within(screen.getByRole('region', { name: /Do., 03.12.2026/ })).getByRole('button', { name: 'Tagdienst bearbeiten' }));
    const editor = screen.getByRole('region', { name: 'Tagdienst am Do., 03.12.2026 bearbeiten' });
    await within(editor).findByLabelText('Datum');
    expect(editor.textContent).toContain('Gespeicherte Änderungen werden Teil der späteren Veröffentlichung.');
    const dialog = await openDialog(user);
    await user.click(confirmButton(dialog));
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    // Same editor, same lease: no second plan, no copy; the effect note follows the new status.
    expect(screen.getByRole('region', { name: 'Tagdienst am Do., 03.12.2026 bearbeiten' })).toBe(editor);
    expect(editor.textContent).toContain('Gespeicherte Änderungen gelten sofort im veröffentlichten Plan');
    expect(server.state.leases[server.state.duties[PLAN_ID][0].id]?.live).toBe(true);
  });
});

describe('SP-13 First Publish — concurrent changes by other admins', () => {
  it.each([
    ['a new duty', (server: ReturnType<typeof company>) => {
      server.state.duties[PLAN_ID].push(duty({ dutyDate: '2026-12-10', startsAt: '2026-12-10T05:00:00Z', endsAt: '2026-12-10T17:00:00Z', assignments: [member(JONAS_ID)] }));
    }],
    ['a changed roster (new version)', (server: ReturnType<typeof company>) => {
      const target = server.state.duties[PLAN_ID][0];
      target.assignments = [target.assignments[0]];
      target.version += 1;
    }],
    ['a new unavailability (same version)', (server: ReturnType<typeof company>) => {
      const target = server.state.duties[PLAN_ID][0];
      target.availabilityConflicts = [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: target.assignments[1].id, employeeId: JONAS_ID }];
    }],
  ])('%s since the page was loaded: nothing is sent; the duties are reloaded for a fresh decision', async (_label, change) => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    change(server);
    await user.click(confirmButton(dialog));

    const alert = await findAlert('Plan wurde inzwischen geändert');
    expect(alert.textContent).toContain('Der Plan wurde nicht veröffentlicht.');
    expect(publishes(requests)).toEqual([]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(alert.closest('[tabindex="-1"]'));
    // The matrix stays on screen during the reload; afterwards a NEW decision publishes the current state.
    expect(screen.getByRole('grid')).toBeTruthy();
    const again = await openDialog(user);
    await user.click(confirmButton(again));
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    expect(publishes(requests)).toHaveLength(1);
  });

  it('another admin published first: 409 MONTHLY_PLAN_ALREADY_PUBLISHED reloads the plan; no re-publish is offered', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.state.plans[0] = { ...server.state.plans[0], status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' };
    const reads = planReads(requests).length;
    await user.click(confirmButton(dialog));
    const alert = await findAlert('Bereits veröffentlicht');
    expect(alert.textContent).toContain('Ein erneutes Veröffentlichen gibt es nicht');
    await waitFor(() => expect(statusSection().textContent).toContain('Veröffentlicht am Mo., 30.11.2026, 13:00 MEZ.'));
    expect(planReads(requests).length).toBeGreaterThan(reads);
    expect(within(statusSection()).queryByRole('button', { name: /veröffentlichen/i })).toBeNull();
    expect(server.publishLog.publications).toBe(0);
  });

  it('the project was deactivated meanwhile: 409 PROJECT_INACTIVE reloads; the action is then unavailable', async () => {
    const server = company();
    renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.state.projects[0] = { ...hafen, status: 'INACTIVE' };
    await user.click(confirmButton(dialog));
    const alert = await findAlert('Projekt ist inaktiv');
    expect(alert.textContent).toContain('Der Plan wurde nicht veröffentlicht.');
    const trigger = screen.getByRole('button', { name: TRIGGER });
    await waitFor(() => expect(trigger.getAttribute('aria-disabled')).toBe('true'));
    expect(statusSection().textContent).toContain('Inaktiv');
    expect(statusSection().textContent).toContain('Unveröffentlicht');
  });

  it('an unavailable member: the dialog warns neutrally; the server refusal is shown without a reason', async () => {
    const lead = member(MIRA_ID, 'SHIFT_LEAD');
    const server = company({
      duties: {
        [PLAN_ID]: [duty({
          ...DEC_3,
          assignments: [lead],
          availabilityConflicts: [{ code: 'EMPLOYEE_UNAVAILABLE', assignmentId: lead.id, employeeId: MIRA_ID }],
        })],
      },
      unavailable: new Set([`${MIRA_ID}|2026-12-03`]),
    });
    renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    expect(dialog.textContent).toContain('Eine Einplanung betrifft eine Person, die am Diensttag nicht verfügbar ist.');
    // Not a client-side block: the server decides.
    await user.click(confirmButton(dialog));
    const alert = await findAlert('Person nicht verfügbar');
    expect(`${dialog.textContent} ${alert.textContent}`).not.toMatch(/krank|urlaub|abwesen|grund|sick|leave/i);
    expect(server.publishLog.publications).toBe(0);
    expect(statusSection().textContent).toContain('Unveröffentlicht');
  });

  it.each([
    [409, 'PLAN_CONCURRENT_MODIFICATION', 'Plan wurde währenddessen geändert', true],
    [409, 'SHIFT_CONFIGURATION_MISSING', 'Keine Schichtzeiten hinterlegt', true],
    [409, 'EMPLOYEE_INACTIVE', 'Deaktivierte Person eingeplant', true],
    [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY', 'Am Diensttag nicht beschäftigt', true],
    [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH', 'Nicht dem Projekt zugeordnet', true],
    [409, 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT', 'Nicht für die Dienstart freigegeben', true],
    [409, 'DUTY_ASSIGNMENT_CONFLICT', 'Zeitliche Überschneidung', true],
    [409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST', 'Vorgang stimmt nicht überein', true],
    [404, 'RESOURCE_NOT_FOUND', 'Monatsplan nicht verfügbar', true],
    [400, 'IDEMPOTENCY_KEY_INVALID', 'Veröffentlichung nicht angenommen', false],
    [403, 'ACTION_FORBIDDEN', 'Kein Zugriff', false],
  ] as const)('a definitive %s %s: alert "%s", nothing claimed, reload=%s; the next try is a new decision with a new key', async (status, code, title, reloads) => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.fail((request) => (isPublish(request) ? httpError(status, code as KnownErrorCode, [], 'req-13') : undefined));
    const reads = planReads(requests).length;
    await user.click(confirmButton(dialog));

    const alert = await findAlert(title);
    expect(alert.textContent).toContain('Referenz-ID: req-13');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(statusSection().textContent).toContain('Unveröffentlicht');
    expect(screen.getByRole('grid')).toBeTruthy();
    if (reloads) await waitFor(() => expect(planReads(requests).length).toBe(reads + 1));
    else expect(planReads(requests).length).toBe(reads);

    const again = await openDialog(user);
    await user.click(confirmButton(again));
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(server.publishLog.publications).toBe(1);
  });

  it('the pre-send check fails: nothing is sent and nothing is claimed', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.fail((request) => (request.path === ENTRIES ? new ApiError('network', null, null, null) : undefined));
    await user.click(confirmButton(dialog));
    const alert = await findAlert('Stand konnte nicht geprüft werden');
    expect(alert.textContent).toContain('Der Plan wurde nicht veröffentlicht.');
    expect(publishes(requests)).toEqual([]);
  });
});

describe('SP-13 First Publish — lost responses and idempotent retries', () => {
  it('the server committed but the answer was lost: nothing is claimed until a GET shows PUBLISHED', async () => {
    const server = company();
    const gate = deferred<void>();
    let holdPlanRead = false;
    const handler: Handler = async (request) => {
      if (holdPlanRead && request.method === 'GET' && request.path === PLAN_URL) await gate.promise;
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.loseResponse(isPublish);
    holdPlanRead = true;
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(dialog.textContent).toContain('Keine Antwort erhalten – der aktuelle Stand wird geprüft …'));
    expect(statusSection().textContent).toContain('Unveröffentlicht');
    expect(screen.queryByText(/Der Monatsplan (wurde|ist) veröffentlicht/)).toBeNull();

    gate.resolve();
    const notice = await screen.findByText(/Das hat das erneute Laden des aktuellen Stands bestätigt\./);
    expect(notice.textContent).toContain('Der Monatsplan ist veröffentlicht.');
    expect(statusSection().textContent).toContain('Veröffentlicht am Di., 01.12.2026, 09:00 MEZ.');
    expect(publishes(requests)).toHaveLength(1);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('no answer and the plan still reads UNPUBLISHED: the outcome stays open; a resend uses the SAME key', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    // The request never reached the server.
    server.fail((request) => (isPublish(request) ? new ApiError('network', null, null, null) : undefined));
    await user.click(confirmButton(dialog));

    const heading = await within(dialog).findByRole('heading', { level: 3, name: 'Ergebnis unbekannt' });
    expect(document.activeElement).toBe(heading);
    expect(dialog.getAttribute('aria-describedby')).toBe(heading.parentElement!.id);
    expect(dialog.textContent).toContain('Ob der Monatsplan veröffentlicht wurde, ist unklar.');
    expect(dialog.textContent).toContain('daraus folgt nicht, dass nichts veröffentlicht wird');
    expect(statusSection().textContent).toContain('Unveröffentlicht');

    await user.click(within(dialog).getByRole('button', { name: 'Erneut anfragen' }));
    const notice = await screen.findByText(/erneute Anfrage mit demselben Vorgang bestätigt/);
    expect(notice.textContent).toContain('doppelt veröffentlicht wurde nicht');
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second).toEqual({ path: PUBLISH_URL, method: 'POST', body: undefined, noBody: true, idempotencyKey: first.idempotencyKey });
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('committed, answer lost, and the check read failed too: the resend with the same key is answered by the replay', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.loseResponse(isPublish);
    server.fail((request) => (request.method === 'GET' && request.path === PLAN_URL ? new ApiError('network', null, null, null) : undefined));
    await user.click(confirmButton(dialog));
    await within(dialog).findByRole('heading', { level: 3, name: 'Ergebnis unbekannt' });
    expect(dialog.textContent).toContain('Der aktuelle Stand des Plans konnte nicht geladen werden.');
    expect(statusSection().textContent).toContain('Unveröffentlicht');

    await user.click(within(dialog).getByRole('button', { name: 'Erneut anfragen' }));
    await screen.findByText(/erneute Anfrage mit demselben Vorgang bestätigt/);
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    // One publication; the second request was the server's replay of the completed command.
    expect(server.publishLog).toEqual({ publications: 1, replays: 1 });
    expect(statusSection().textContent).toContain('Veröffentlicht am Di., 01.12.2026, 09:00 MEZ.');
  });

  it('a technical 500 keeps the key: the outcome is open, the reference ID is shown, the resend completes it', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.fail((request) => (isPublish(request) ? httpError(500, 'INTERNAL_ERROR', [], 'req-500') : undefined));
    await user.click(confirmButton(dialog));
    await within(dialog).findByRole('heading', { level: 3, name: 'Ergebnis unbekannt' });
    expect(dialog.textContent).toContain('Referenz-ID: req-500');
    await user.click(within(dialog).getByRole('button', { name: 'Erneut anfragen' }));
    await screen.findByText(/erneute Anfrage mit demselben Vorgang bestätigt/);
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('409 IDEMPOTENCY_REQUEST_IN_PROGRESS: the resend waits for Retry-After (1 s), then uses the same key', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.fail((request) => (isPublish(request) ? httpError(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS') : undefined));
    await user.click(confirmButton(dialog));
    await within(dialog).findByRole('heading', { level: 3, name: 'Veröffentlichung läuft noch' });
    const resend = within(dialog).getByRole('button', { name: 'Erneut anfragen' });
    expect(resend.getAttribute('aria-disabled')).toBe('true');
    await user.click(resend);
    expect(publishes(requests)).toHaveLength(1);
    await waitFor(() => expect(resend.getAttribute('aria-disabled')).toBeNull(), { timeout: 2500 });
    await user.click(resend);
    await screen.findByText(/erneute Anfrage mit demselben Vorgang bestätigt/);
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it.each(['the leave button', 'Escape', 'Escape pressed three times', 'a browser close'])(
    'leaving an open outcome with %s reloads the state once; a later decision gets a new key',
    async (how) => {
      const server = company();
      const { requests } = renderPlanning(PLAN_PATH, server.handler);
      const user = userEvent.setup();
      const dialog = await openDialog(user);
      server.fail((request) => (isPublish(request) ? new ApiError('invalid-response', 200, null, null) : undefined));
      await user.click(confirmButton(dialog));
      await within(dialog).findByRole('heading', { level: 3, name: 'Ergebnis unbekannt' });
      const reads = planReads(requests).length;
      if (how === 'Escape') await user.keyboard('{Escape}');
      else if (how === 'Escape pressed three times') await user.keyboard('{Escape}{Escape}{Escape}');
      // The browser closed the modal dialog itself (e.g. Chrome after repeated close requests).
      else if (how === 'a browser close') (dialog as HTMLDialogElement).close();
      else await user.click(within(dialog).getByRole('button', { name: 'Vorgang verlassen und Stand laden' }));

      const alert = await findAlert('Ergebnis offen');
      expect(alert.textContent).toContain('der Planstatus zeigt danach, ob der Monatsplan veröffentlicht ist');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(alert.closest('[tabindex="-1"]'));
      await waitFor(() => expect(planReads(requests).length).toBe(reads + 1));

      const again = await openDialog(user);
      await user.click(confirmButton(again));
      await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
      const [first, second] = publishes(requests);
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
      expect(server.publishLog.publications).toBe(1);
      // Exactly one reload for leaving, however often the close request came.
      expect(planReads(requests).length).toBe(reads + 1);
    },
  );
});

describe('SP-13 First Publish — dialog transitions, focus and repeated input', () => {
  it('repeated Escape: the first press cancels and returns focus; further presses reopen and send nothing', async () => {
    const server = company();
    const { requests } = renderPlanning(PLAN_PATH, server.handler);
    const user = userEvent.setup();
    const trigger = await readyTrigger();
    const before = requests.length;
    await user.click(trigger);
    expect(screen.getByRole('alertdialog', { name: DIALOG })).toBeTruthy();
    await user.keyboard('{Escape}{Escape}{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // The keyboard path still works afterwards: Enter reopens a fresh confirmation, focus on "Abbrechen".
    await user.keyboard('{Enter}');
    const again = screen.getByRole('alertdialog', { name: DIALOG });
    expect(document.activeElement).toBe(within(again).getByRole('button', { name: 'Abbrechen' }));
    await user.keyboard('{Escape}{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(requests.slice(before)).toEqual([]);
    expect(server.publishLog.publications).toBe(0);
  });

  it('during the pre-send check, a second confirmation, "Abbrechen", Escape and a native cancel do nothing; one POST follows', async () => {
    const server = company();
    const gate = deferred<void>();
    let holdCheck = false;
    const handler: Handler = async (request) => {
      if (holdCheck && request.method === 'GET' && request.path === ENTRIES) await gate.promise;
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    holdCheck = true;
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(dialog.textContent).toContain('Aktueller Stand wird geprüft …'));

    const busy = within(dialog).getByRole('button', { name: 'Wird veröffentlicht …' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    await user.click(busy);
    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await user.keyboard('{Escape}');
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(publishes(requests)).toEqual([]);

    gate.resolve();
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    expect(publishes(requests)).toHaveLength(1);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('a forced browser close while the request runs cancels nothing; the answer still settles the result and takes focus', async () => {
    const server = company();
    const gate = deferred<void>();
    const handler: Handler = async (request) => {
      if (isPublish(request)) await gate.promise;
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = (await openDialog(user)) as HTMLDialogElement;
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(publishes(requests)).toHaveLength(1));

    // Chrome may close a modal dialog itself after repeated close requests; the request is not cancelled.
    dialog.close();
    expect(dialog.open).toBe(false);
    expect(dialog.isConnected).toBe(true);
    // Progress stays announced outside the dialog; nothing is claimed.
    expect(statusSection().querySelector('.planning-publish__live')!.textContent).toContain('Veröffentlichung wird übertragen …');
    expect(statusSection().textContent).toContain('Unveröffentlicht');

    gate.resolve();
    const notice = await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(notice.closest('[tabindex="-1"]'));
    expect(publishes(requests)).toHaveLength(1);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('a forced browser close and then an unknown outcome: the decision is shown modally again with focus on its heading', async () => {
    const server = company();
    const gate = deferred<void>();
    let dropFirst = true;
    const handler: Handler = async (request) => {
      if (isPublish(request) && dropFirst) {
        dropFirst = false;
        await gate.promise;
        // The request never reached the server.
        throw new ApiError('network', null, null, null);
      }
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = (await openDialog(user)) as HTMLDialogElement;
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(publishes(requests)).toHaveLength(1));
    dialog.close();
    expect(dialog.open).toBe(false);

    gate.resolve();
    const heading = await within(dialog).findByRole('heading', { level: 3, name: 'Ergebnis unbekannt' });
    // Same element, opened with showModal() again: the open decision is never left behind a closed dialog.
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.testModal).toBe('true');
    expect(document.activeElement).toBe(heading);
    expect(statusSection().textContent).toContain('Unveröffentlicht');

    await user.click(within(dialog).getByRole('button', { name: 'Erneut anfragen' }));
    await screen.findByText(/erneute Anfrage mit demselben Vorgang bestätigt/);
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('two clicks on "Erneut anfragen" in one tick resend the same key once; focus stays inside the dialog while it runs', async () => {
    const server = company();
    const gate = deferred<void>();
    let holdResend = false;
    const handler: Handler = async (request) => {
      if (holdResend && isPublish(request)) await gate.promise;
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    server.fail((request) => (isPublish(request) ? new ApiError('network', null, null, null) : undefined));
    await user.click(confirmButton(dialog));
    const resend = await within(dialog).findByRole('button', { name: 'Erneut anfragen' });
    holdResend = true;
    // Both clicks reach the same button before React re-renders: only the synchronous guard can stop the second.
    act(() => {
      resend.click();
      resend.click();
    });
    await waitFor(() => expect(publishes(requests)).toHaveLength(2));
    // The focused button was replaced by the progress view: focus moved to the dialog title, not to the page.
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { level: 2, name: DIALOG }));
    expect(within(dialog).getByRole('button', { name: 'Wird veröffentlicht …' }).getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBe(dialog);

    gate.resolve();
    await screen.findByText(/erneute Anfrage mit demselben Vorgang bestätigt/);
    expect(publishes(requests)).toHaveLength(2);
    const [first, second] = publishes(requests);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(server.publishLog).toEqual({ publications: 1, replays: 0 });
  });

  it('a late plan read showing PUBLISHED closes an open confirmation: nothing is sent, no re-publish, focus on the notice', async () => {
    const server = company();
    const gate = deferred<void>();
    let holdPlanRead = false;
    const handler: Handler = async (request) => {
      if (holdPlanRead && request.method === 'GET' && request.path === PLAN_URL) await gate.promise;
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const first = await openDialog(user);
    // A refusal reloads plan and duties; here the duties come back first and the plan read is slow.
    server.fail((request) => (isPublish(request) ? httpError(409, 'PLAN_CONCURRENT_MODIFICATION') : undefined));
    holdPlanRead = true;
    await user.click(confirmButton(first));
    await findAlert('Plan wurde währenddessen geändert');
    const dialog = await openDialog(user);

    // Meanwhile another admin published; the slow read returns that state.
    server.state.plans[0] = { ...server.state.plans[0], status: 'PUBLISHED', publishedAt: '2026-11-30T12:00:00Z' };
    gate.resolve();
    const alert = await findAlert('Bereits veröffentlicht');
    expect(alert.textContent).toContain('Der Monatsplan ist inzwischen veröffentlicht.');
    expect(alert.textContent).toContain('Ein erneutes Veröffentlichen gibt es nicht');
    expect(dialog.isConnected).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(alert.closest('[tabindex="-1"]'));
    await waitFor(() => expect(statusSection().textContent).toContain('Veröffentlicht am Mo., 30.11.2026, 13:00 MEZ.'));
    expect(within(statusSection()).queryByRole('button', { name: /veröffentlichen/i })).toBeNull();
    // Only the refused first attempt was ever sent.
    expect(publishes(requests)).toHaveLength(1);
    expect(server.publishLog.publications).toBe(0);
  });
});

describe('SP-13 First Publish — versionless contract (documented gap, not closed by the client)', () => {
  // Synthetic example: another admin's duty for Jonas on 10 December, committed after the pre-send read.
  const LATE_DUTY = { dutyDate: '2026-12-10', startsAt: '2026-12-10T05:00:00Z', endsAt: '2026-12-10T17:00:00Z' };
  const LATE_CELL = /^Jonas Muster, Do\., 10\. Dezember: Tagdienst/;

  it('a valid change committed between the pre-send read and the POST is published without having been shown', async () => {
    const server = company();
    let raced = false;
    const handler: Handler = async (request) => {
      if (isPublish(request) && !raced) {
        raced = true;
        server.state.duties[PLAN_ID].push(duty({ ...LATE_DUTY, assignments: [member(JONAS_ID)] }));
      }
      return server.handler(request);
    };
    const { requests } = renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('Dienste').nextElementSibling!.textContent).toBe('2 (davon 1 ohne Besetzung)');
    await user.click(confirmButton(dialog));
    await screen.findByText(/^Der Monatsplan wurde veröffentlicht\./);

    // The command carries nothing that binds it to the reviewed state: no version, fingerprint or body.
    expect(publishes(requests)).toEqual([
      { path: PUBLISH_URL, method: 'POST', body: undefined, noBody: true, idempotencyKey: expect.stringMatching(UUID_V4) },
    ]);
    // The server published three live duties; the admin reviewed two and the screen still shows two.
    expect(server.state.duties[PLAN_ID]).toHaveLength(3);
    expect(server.publishLog.publications).toBe(1);
    expect(screen.queryByRole('button', { name: LATE_CELL })).toBeNull();
  });

  it('the latest state must still pass every rule: an unseen change the server refuses publishes nothing and appears after the reload', async () => {
    const server = company();
    server.state.unavailable.add(`${JONAS_ID}|2026-12-10`);
    let raced = false;
    const handler: Handler = async (request) => {
      if (isPublish(request) && !raced) {
        raced = true;
        server.state.duties[PLAN_ID].push(duty({ ...LATE_DUTY, assignments: [member(JONAS_ID)] }));
      }
      return server.handler(request);
    };
    renderPlanning(PLAN_PATH, handler);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.click(confirmButton(dialog));
    const alert = await findAlert('Person nicht verfügbar');
    expect(alert.textContent).toContain('Der Plan wurde nicht veröffentlicht.');
    expect(server.publishLog.publications).toBe(0);
    expect(statusSection().textContent).toContain('Unveröffentlicht');
    expect(await screen.findByRole('button', { name: LATE_CELL })).toBeTruthy();
  });
});
