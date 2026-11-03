// @vitest-environment jsdom
/**
 * #88 A2 employee-month Save (contract A2-GATE-1) through the planner, the
 * real adapter and an in-memory model of the three A2 routes. Mocked UI
 * tests: they do not establish browser end-to-end acceptance (pending with
 * the production wiring).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../shared/api/api-error';
import { fullName } from '../../employees/employee-types';
import type { Project } from '../../projects/project-types';
import { EmployeeMonthWorkspace } from './EmployeeMonthWorkspace';
import type { SaveEmployeeMonthBody } from './employee-month-api';
import { ALL_WEEK, MON_TO_FRI, PUBLISHED_AT_A2, employeeMonthServer, type MonthSpec } from './employee-month.test-support';
import type { Duty } from './monthly-plan-types';
import { HAFEN_ID, JONAS_ID, LEA_ID, MIRA_ID, OSKAR_ID, duty, hafen, member, monthAssignments, plan, staff } from './monthly-planning.test-support';
import { buildMatrixRows } from './planning-matrix';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NAMES = new Map(staff.map((employee) => [employee.id.toLowerCase(), fullName(employee)]));
const nameOf = (id: string) => NAMES.get(id.toLowerCase()) ?? 'Unbekannte Person';

function dec(day: number): string {
  return `2026-12-${String(day).padStart(2, '0')}`;
}

const SHARED = 'd0000000-0000-4000-8000-0000000000a3';
const OWN_NIGHT = 'd0000000-0000-4000-8000-0000000000b4';
const LEAD_DAY = 'd0000000-0000-4000-8000-0000000000c8';

/** Example month: an empty-for-Mira shared day duty on the 3rd, Mira's night on the 4th, Mira as Schichtleitung on the 8th. */
const EXAMPLE: MonthSpec = {
  calendar: ALL_WEEK,
  day: { 3: { dutyId: SHARED, version: 4, role: null }, 8: { dutyId: LEAD_DAY, version: 6, role: 'SHIFT_LEAD' } },
  night: { 4: { dutyId: OWN_NIGHT, version: 2, role: 'EMPLOYEE' } },
};

type Options = { duties?: Duty[]; project?: Project };

async function renderWorkspace(spec: MonthSpec = EXAMPLE, options: Options = {}) {
  const server = employeeMonthServer(spec);
  const month = spec.month ?? '2026-12';
  const monthStart = `${month}-01`;
  const duties = options.duties ?? [];
  const person = buildMatrixRows(staff, monthAssignments(HAFEN_ID, monthStart, [MIRA_ID, JONAS_ID, LEA_ID, OSKAR_ID]), duties, HAFEN_ID, monthStart)
    .find((row) => row.key === MIRA_ID.toLowerCase())!;
  const onReloadDuties = vi.fn();
  const onEditStateChange = vi.fn();
  render(
    <EmployeeMonthWorkspace
      api={server.api}
      plan={plan({ monthStart, status: server.model.plan.status, publishedAt: server.model.plan.publishedAt })}
      project={options.project ?? hafen}
      month={month}
      person={person}
      duties={duties}
      nameOf={nameOf}
      onReloadDuties={onReloadDuties}
      dutiesReloading={false}
      onEditStateChange={onEditStateChange}
    />,
  );
  await screen.findByRole('grid');
  return { server, onReloadDuties, onEditStateChange, user: userEvent.setup() };
}

function dateButton(day: number) {
  return within(screen.getByRole('grid')).getByRole('button', { name: new RegExp(`^[A-Z][a-z]\\., ${day}\\. Dezember:`) });
}

function stateOf(day: number) {
  return dateButton(day).getAttribute('aria-label')!.split(': ')[1];
}

function description(button: HTMLElement) {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)!.textContent : '';
}

function saveButton() {
  return screen.getByRole('button', { name: /^Monat (speichern|wird gespeichert)/ });
}

function saveNote() {
  const id = saveButton().getAttribute('aria-describedby');
  return id ? document.getElementById(id)!.textContent : null;
}

function changes() {
  return screen.getByRole('region', { name: /Ungespeicherte Änderungen/ });
}

function status() {
  return screen.getAllByRole('status').find((element) => element.getAttribute('aria-live') === 'polite')!.textContent;
}

async function paint(user: ReturnType<typeof userEvent.setup>, mode: 'Tag' | 'Nacht' | 'Frei', days: number[]) {
  await user.click(within(screen.getByRole('group', { name: 'Eintragen als' })).getByRole('radio', { name: mode }));
  for (const day of days) await user.click(dateButton(day));
}

function bodyOf(request: { body: unknown }) {
  return request.body as SaveEmployeeMonthBody;
}

async function alertTitled(name: string | RegExp) {
  const heading = await screen.findByRole('heading', { name });
  return heading.closest('[role="alert"]') as HTMLElement;
}

describe('#88 A2 — one atomic save of the complete month', () => {
  it('loads the month, saves it in ONE request with every precondition of the read, then re-reads it', async () => {
    const { server, user, onReloadDuties, onEditStateChange } = await renderWorkspace();
    expect(screen.queryByText(/Vorschau/)).toBeNull();
    expect(screen.getByText(/Betriebstage des Projekts: Mo, Di, Mi, Do, Fr, Sa, So\./)).toBeTruthy();
    expect(stateOf(8)).toBe('Tagdienst (Schichtleitung)');

    await paint(user, 'Tag', [3, 5]);
    await paint(user, 'Nacht', [10]);
    await paint(user, 'Frei', [4]);
    expect(onEditStateChange).toHaveBeenLastCalledWith('dirty');
    expect(changes().textContent).toContain('05.12.2026 · neu: Tagdienst (Mitarbeitende) – Dienst wird beim Speichern angelegt');
    await user.click(saveButton());

    await waitFor(() => expect(status()).toBe('Der Monat wurde gespeichert: 2 Dienste angelegt, 2 Dienste geändert. Der aktuelle Stand ist geladen.'));
    expect(server.saves()).toHaveLength(1);
    const [request] = server.saves();
    expect(request.idempotencyKey).toMatch(/^[\x21-\x7e]{8,128}$/);
    const body = bodyOf(request);
    expect(body.days).toHaveLength(31);
    expect(body.expectedPlan).toEqual({ status: 'UNPUBLISHED', publishedAt: null });
    expect(body.expectedCalendar).toEqual({ id: server.model.calendar!.id, version: 1 });
    expect(body.days[2]).toEqual({ date: dec(3), expected: { day: { id: SHARED, version: 4 }, night: null }, desired: { state: 'DAY', role: 'EMPLOYEE' } });
    expect(body.days[3]).toEqual({ date: dec(4), expected: { day: null, night: { id: OWN_NIGHT, version: 2 } }, desired: { state: 'OFF' } });
    expect(body.days[4]).toEqual({ date: dec(5), expected: { day: null, night: null }, desired: { state: 'DAY', role: 'EMPLOYEE' } });
    // The untouched Schichtleitung on the 8th is sent as it is stored: no downgrade.
    expect(body.days[7]).toEqual({ date: dec(8), expected: { day: { id: LEAD_DAY, version: 6 }, night: null }, desired: { state: 'DAY', role: 'SHIFT_LEAD' } });

    expect(server.log.commits).toBe(1);
    expect(server.reads()).toHaveLength(2);
    expect(onReloadDuties).toHaveBeenCalledTimes(1);
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(stateOf(5)).toBe('Tagdienst (Mitarbeitende)');
    expect(description(dateButton(5))).not.toContain('noch nicht gespeichert');
    expect(onEditStateChange).toHaveBeenLastCalledWith('clean');
    expect(saveNote()).toBe('Es gibt keine ungespeicherten Änderungen.');
  });

  it('sends a role chosen in the day panel and never sends or changes other people of a shared duty', async () => {
    const shared = duty({ id: SHARED, version: 4, dutyDate: dec(3), startsAt: `${dec(3)}T05:00:00Z`, endsAt: `${dec(3)}T17:00:00Z`, assignments: [member(JONAS_ID, 'SHIFT_LEAD'), member(LEA_ID)] });
    const { server, user } = await renderWorkspace(EXAMPLE, { duties: [shared] });
    await paint(user, 'Tag', [3]);
    const details = screen.getByRole('region', { name: /^Ausgewählter Tag:/ });
    expect(details.textContent).toContain('Tagdienst, weitere Personen (bleiben unverändert): Jonas Muster (Schichtleitung), Lea Probe');
    await user.click(within(details).getByRole('radio', { name: 'Schichtleitung' }));
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    const body = bodyOf(server.saves()[0]);
    expect(body.days[2].desired).toEqual({ state: 'DAY', role: 'SHIFT_LEAD' });
    expect(JSON.stringify(body)).not.toContain(JONAS_ID);
    expect(JSON.stringify(body)).not.toContain(LEA_ID);
  });

  it('does not mix reads of different times: other people of a newer duty version are not listed', async () => {
    const older = duty({ id: SHARED, version: 3, dutyDate: dec(3), startsAt: `${dec(3)}T05:00:00Z`, endsAt: `${dec(3)}T17:00:00Z`, assignments: [member(JONAS_ID)] });
    const { user } = await renderWorkspace(EXAMPLE, { duties: [older] });
    await user.click(dateButton(3));
    expect(screen.getByRole('region', { name: /^Ausgewählter Tag:/ }).textContent).toContain('Tagdienst: weitere eingeplante Personen bleiben unverändert.');
  });

  it('CR-03: a published plan is saved directly with its publication as precondition and says so', async () => {
    const { server, user } = await renderWorkspace({ ...EXAMPLE, status: 'PUBLISHED' });
    expect(screen.getByText('Der Plan ist veröffentlicht: Gespeicherte Änderungen gelten sofort, ohne erneutes Veröffentlichen.')).toBeTruthy();
    await paint(user, 'Tag', [9]);
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(bodyOf(server.saves()[0]).expectedPlan).toEqual({ status: 'PUBLISHED', publishedAt: PUBLISHED_AT_A2 });
    expect(server.model.plan.status).toBe('PUBLISHED');
  });
});

describe('#88 A2 — definite refusals keep the whole selection', () => {
  it('PRECONDITION: another admin changed a slot; nothing saved, reload required, then an explicit decision and a NEW key', async () => {
    const { server, user } = await renderWorkspace();
    await paint(user, 'Tag', [3, 5]);
    server.changeSlot(dec(3), 'DAY', null);
    await user.click(saveButton());

    const alert = await alertTitled('Monat nicht gespeichert: inzwischen geändert');
    expect(within(alert).getByRole('heading')).toBe(document.activeElement);
    expect(alert.textContent).toContain('Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.');
    expect(alert.textContent).toContain('03.12.2026, Tagdienst: Inzwischen geändert. Laden Sie den aktuellen Stand.');
    expect([stateOf(3), stateOf(5)]).toEqual(['Tagdienst (Mitarbeitende)', 'Tagdienst (Mitarbeitende)']);
    expect(saveNote()).toBe('Laden Sie zuerst den aktuellen Stand.');
    expect(server.log.commits).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    await waitFor(() => expect(status()).toContain('1 Änderung betrifft inzwischen geänderte Dienste'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveNote()).toBe('Entscheiden Sie zuerst über die inzwischen geänderten Dienste.');
    await user.click(dateButton(3));
    await user.click(screen.getByRole('button', { name: 'Meine Auswahl behalten' }));
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    const [first, second] = server.saves();
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(bodyOf(second).days[2].expected.day).toEqual({ id: SHARED, version: 5 });
  });

  it('PRECONDITION: a publication meanwhile is reported after the reload, and the next save expects it (CR-03)', async () => {
    const { server, user } = await renderWorkspace();
    await paint(user, 'Tag', [9]);
    server.publish();
    await user.click(saveButton());
    await alertTitled('Monat nicht gespeichert: inzwischen geändert');
    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    await waitFor(() => expect(status()).toContain('Der Plan wurde inzwischen veröffentlicht: Gespeicherte Änderungen gelten danach sofort.'));
    expect(screen.getByText('Der Plan ist veröffentlicht: Gespeicherte Änderungen gelten sofort, ohne erneutes Veröffentlichen.')).toBeTruthy();
    expect(stateOf(9)).toBe('Tagdienst (Mitarbeitende)');
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(bodyOf(server.saves()[1]).expectedPlan).toEqual({ status: 'PUBLISHED', publishedAt: PUBLISHED_AT_A2 });
  });

  it('VALIDATION: neutral dated findings; editing a date drops its finding; the corrected month saves with a NEW key', async () => {
    const { server, user } = await renderWorkspace();
    server.invalid.set(`${dec(5)}|DAY`, 'EMPLOYEE_UNAVAILABLE');
    await paint(user, 'Tag', [3, 5]);
    await user.click(saveButton());
    const alert = await alertTitled('Monat nicht gespeichert');
    expect(alert.textContent).toContain('Bitte prüfen Sie 1 Tag:');
    expect(alert.textContent).toContain('05.12.2026, Tagdienst: An diesem Tag nicht verfügbar.');
    expect(document.body.textContent).not.toMatch(/krank|Krankheit|Urlaub/i);
    expect(description(dateButton(5))).toContain('Nicht gespeichert: Tagdienst: An diesem Tag nicht verfügbar.');
    expect(saveNote()).toBeNull();

    await paint(user, 'Frei', [5]);
    expect(description(dateButton(5))).not.toContain('Nicht gespeichert');
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(server.saves()[1].idempotencyKey).not.toBe(server.saves()[0].idempotencyKey);
    expect(bodyOf(server.saves()[1]).days[4].desired).toEqual({ state: 'OFF' });
  });

  it('LEASE: a duty opened in the single-duty editor refuses the month without naming who; a later save succeeds', async () => {
    const { server, user } = await renderWorkspace();
    server.leases.add(`${dec(3)}|DAY`);
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());
    const alert = await alertTitled('Monat nicht gespeichert: Dienst wird bearbeitet');
    expect(alert.textContent).toContain('03.12.2026, Tagdienst: Dieser Dienst wird gerade bearbeitet. Speichern Sie später erneut.');
    expect(alert.textContent).not.toMatch(/Jonas|Lea|Mira Beispiel/);
    server.leases.clear();
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
  });

  it('ends the form when the plan or person is gone (404) and keeps the selection visible', async () => {
    const { server, user } = await renderWorkspace();
    server.failNext((request) => (request.method === 'POST' ? new ApiError('http', 404, 'RESOURCE_NOT_FOUND', 'req') : undefined));
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());
    await alertTitled('Monat nicht mehr verfügbar');
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    expect(saveNote()).toBe('Dieser Monat kann hier nicht gespeichert werden.');
    expect((screen.getByRole('button', { name: 'Aktuellen Stand laden' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('#88 A2 — unknown outcome: ask the server before anything else', () => {
  it('a lost answer after the commit: blocked and locked, lookup proves the commit, no second save', async () => {
    const { server, user, onEditStateChange } = await renderWorkspace();
    server.loseNextSave();
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());

    const alert = await alertTitled('Ergebnis unbekannt');
    expect(within(alert).getByRole('heading')).toBe(document.activeElement);
    expect(saveNote()).toBe('Fragen Sie zuerst das Ergebnis des letzten Speicherns ab.');
    expect(onEditStateChange).toHaveBeenLastCalledWith('dirty');
    await user.click(saveButton());
    expect(server.saves()).toHaveLength(1);
    // The selection stays as sent and cannot be edited, and no reload hides the open question.
    expect(dateButton(5).getAttribute('aria-disabled')).toBe('true');
    await user.click(dateButton(5));
    expect(stateOf(5)).toBe('Frei (nicht eingeplant)');
    expect((screen.getByRole('button', { name: 'Aktuellen Stand laden' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(alert).getByRole('button', { name: 'Ergebnis abfragen' }));
    await waitFor(() => expect(status()).toBe('Der Monat wurde gespeichert: 1 Dienst geändert. Der aktuelle Stand ist geladen.'));
    expect(server.lookups()).toHaveLength(1);
    expect(server.lookups()[0].idempotencyKey).toBe(server.saves()[0].idempotencyKey);
    expect(server.saves()).toHaveLength(1);
    expect(server.log.commits).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onEditStateChange).toHaveBeenLastCalledWith('clean');
  });

  it('a malformed answer after the commit is never shown as success; the lookup receipt is', async () => {
    const { server, user } = await renderWorkspace();
    server.malformNextSave();
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());
    const alert = await alertTitled('Ergebnis unbekannt');
    expect(status()).not.toContain('gespeichert:');
    await user.click(within(alert).getByRole('button', { name: 'Ergebnis abfragen' }));
    await waitFor(() => expect(status()).toContain('Der Monat wurde gespeichert'));
    expect(server.log.commits).toBe(1);
  });

  it('NOT_COMPLETED allows an explicitly confirmed resend of the SAME key and body', async () => {
    const { server, user } = await renderWorkspace();
    server.failNext((request) => (request.method === 'POST' ? new ApiError('http', 500, 'INTERNAL_ERROR', 'req') : undefined));
    server.scriptLookup(() => ({ state: 'NOT_COMPLETED' }));
    await paint(user, 'Tag', [3, 5]);
    await user.click(saveButton());
    await user.click(within(await alertTitled('Ergebnis unbekannt')).getByRole('button', { name: 'Ergebnis abfragen' }));
    const alert = await alertTitled('Monat nicht gespeichert');
    expect(alert.textContent).toContain('Der Server bestätigt: Das letzte Speichern wurde nicht abgeschlossen');
    expect(saveNote()).toBe('Entscheiden Sie zuerst, wie es mit dem nicht abgeschlossenen Speichern weitergeht.');
    await user.click(within(alert).getByRole('button', { name: 'Unverändert erneut speichern' }));
    await waitFor(() => expect(server.log.commits).toBe(1));
    const [first, second] = server.saves();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.body).toEqual(first.body);
  });

  it('UNKNOWN evidence requires a fresh read; the next save is a new decision with a NEW key', async () => {
    const { server, user } = await renderWorkspace();
    server.failNext((request) => (request.method === 'POST' ? new ApiError('network', null, null, null) : undefined));
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());
    await user.click(within(await alertTitled('Ergebnis unbekannt')).getByRole('button', { name: 'Ergebnis abfragen' }));
    const alert = await alertTitled('Ergebnis nicht feststellbar');
    expect(saveNote()).toBe('Laden Sie zuerst den aktuellen Stand.');
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    await user.click(within(alert).getByRole('button', { name: 'Aktuellen Stand laden und Auswahl prüfen' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(server.saves()[1].idempotencyKey).not.toBe(server.saves()[0].idempotencyKey);
  });

  it('a failed lookup teaches nothing; IN_PROGRESS asks to query again; the receipt then settles it', async () => {
    const { server, user } = await renderWorkspace();
    server.loseNextSave();
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());
    server.scriptLookup(() => new ApiError('network', null, null, null));
    await user.click(within(await alertTitled('Ergebnis unbekannt')).getByRole('button', { name: 'Ergebnis abfragen' }));
    await waitFor(() => expect(screen.getByText('Die Abfrage ist fehlgeschlagen. Versuchen Sie es erneut.')).toBeTruthy());
    server.scriptLookup(() => ({ state: 'IN_PROGRESS', retryAfterSeconds: 1 }));
    await user.click(screen.getByRole('button', { name: 'Ergebnis abfragen' }));
    const running = await alertTitled('Speichern läuft noch');
    expect(saveNote()).toBe('Das letzte Speichern wird noch verarbeitet. Fragen Sie das Ergebnis erneut ab.');
    await user.click(within(running).getByRole('button', { name: 'Ergebnis erneut abfragen' }));
    await waitFor(() => expect(status()).toContain('Der Monat wurde gespeichert'));
    expect(server.saves()).toHaveLength(1);
    expect(server.lookups()).toHaveLength(3);
  });

  it('after a committed save, a failed re-read keeps the page clean and asks to load again', async () => {
    const { server, user, onEditStateChange } = await renderWorkspace();
    await paint(user, 'Tag', [3]);
    server.failNext((request) => (request.method === 'GET' ? new ApiError('network', null, null, null) : undefined));
    await user.click(saveButton());
    await waitFor(() => expect(saveNote()).toBe('Laden Sie den aktuellen Stand erneut.'));
    expect(status()).toBe('Der Monat wurde gespeichert: 1 Dienst geändert. Der aktuelle Stand wird geladen …');
    expect(onEditStateChange).toHaveBeenLastCalledWith('clean');
    expect(dateButton(5).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    await waitFor(() => expect(status()).toBe('Der Monat wurde gespeichert: 1 Dienst geändert. Der aktuelle Stand ist geladen.'));
    expect(within(changes()).getByText('Keine ungespeicherten Änderungen.')).toBeTruthy();
    expect(server.saves()).toHaveLength(1);
  });

  it('asks the browser before a reload or close drops a draft, a running save or an unresolved outcome', async () => {
    const { server, user } = await renderWorkspace();
    const reload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(reload()).toBe(false);
    await paint(user, 'Tag', [3]);
    expect(reload()).toBe(true);
    server.loseNextSave();
    await user.click(saveButton());
    await alertTitled('Ergebnis unbekannt');
    expect(reload()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Ergebnis abfragen' }));
    await waitFor(() => expect(status()).toContain('Der aktuelle Stand ist geladen.'));
    expect(reload()).toBe(false);
  });

  it('one activation sends one request; the page sees the running save', async () => {
    const { server, user, onEditStateChange } = await renderWorkspace();
    const release = server.holdNextSave();
    await paint(user, 'Tag', [3]);
    await user.click(saveButton());
    expect(saveButton().textContent).toBe('Monat wird gespeichert …');
    expect(onEditStateChange).toHaveBeenLastCalledWith('saving');
    await user.click(saveButton());
    await user.click(saveButton());
    release();
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(server.saves()).toHaveLength(1);
  });
});

describe('#88 A2 — stored data and operating days from the read', () => {
  it('a stored Tag + Nacht needs an explicit decision; keeping the night keeps its Schichtleitung', async () => {
    const { server, user } = await renderWorkspace({ calendar: ALL_WEEK, day: { 7: { dutyId: SHARED, version: 2, role: 'EMPLOYEE' } }, night: { 7: { dutyId: OWN_NIGHT, version: 3, role: 'SHIFT_LEAD' } } });
    const fixes = screen.getByRole('region', { name: 'Korrektur nötig (1)' });
    await paint(user, 'Tag', [10]);
    expect(saveNote()).toBe('Korrigieren Sie zuerst 1 Tag unter „Korrektur nötig“.');
    // The link moves to the date without painting it.
    await user.click(within(fixes).getByRole('button', { name: 'Mo., 07.12.2026' }));
    await user.click(screen.getByRole('button', { name: 'Nur Nachtdienst behalten' }));
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(bodyOf(server.saves()[0]).days[6]).toEqual({
      date: dec(7),
      expected: { day: { id: SHARED, version: 2 }, night: { id: OWN_NIGHT, version: 3 } },
      desired: { state: 'NIGHT', role: 'SHIFT_LEAD' },
    });
  });

  it('MISSING calendar: no new work on any date, never an assumed week; removing still saves', async () => {
    const { server, user } = await renderWorkspace({ calendar: null, night: { 4: { dutyId: OWN_NIGHT, version: 2, role: 'EMPLOYEE' } } });
    expect(screen.getByText(/keine Betriebstage festgelegt: Neue Dienste sind nicht möglich/)).toBeTruthy();
    await paint(user, 'Tag', []);
    for (const day of [1, 2, 7, 31]) {
      expect(dateButton(day).getAttribute('aria-disabled')).toBe('true');
      expect(description(dateButton(day))).toContain('Tag nicht möglich: keine Betriebstage festgelegt: nur Frei möglich');
    }
    expect(description(dateButton(4))).toContain('Bestehender Dienst, obwohl für diesen Monat keine Betriebstage festgelegt sind.');
    await paint(user, 'Frei', [4]);
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(bodyOf(server.saves()[0]).expectedCalendar).toBeNull();
  });

  it('closed weekday: a stored duty stays without blocking the month; new work is not offered there', async () => {
    // Example calendar Mon–Fri; 5 and 12 December 2026 are Saturdays.
    const { server, user } = await renderWorkspace({ calendar: MON_TO_FRI, day: { 5: { version: 1, role: 'EMPLOYEE' } } });
    expect(screen.getByText(/Betriebstage des Projekts: Mo, Di, Mi, Do, Fr\./)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /Korrektur nötig/ })).toBeNull();
    expect(description(dateButton(5))).toContain('Bestehender Dienst an einem Tag, an dem das Projekt nicht in Betrieb ist.');
    await paint(user, 'Tag', [12]);
    expect(stateOf(12)).toBe('Frei (nicht eingeplant)');
    await paint(user, 'Tag', [7]);
    await user.click(saveButton());
    await waitFor(() => expect(server.log.commits).toBe(1));
    expect(bodyOf(server.saves()[0]).days[4].desired).toEqual({ state: 'DAY', role: 'EMPLOYEE' });
  });

  it('shows the first read failure with a retry, and keeps the selection when a later re-read fails', async () => {
    const server = employeeMonthServer(EXAMPLE);
    server.failNext(() => new ApiError('http', 500, 'INTERNAL_ERROR', 'req'));
    const person = buildMatrixRows(staff, monthAssignments(HAFEN_ID, '2026-12-01', [MIRA_ID]), [], HAFEN_ID, '2026-12-01')[0];
    render(
      <EmployeeMonthWorkspace
        api={server.api}
        plan={plan()}
        project={hafen}
        month="2026-12"
        person={person}
        duties={[]}
        nameOf={nameOf}
        onReloadDuties={vi.fn()}
        dutiesReloading={false}
        onEditStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /erneut/i }));
    await screen.findByRole('grid');
    await paint(user, 'Tag', [3]);
    server.failNext(() => new ApiError('network', null, null, null));
    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /erneut/i })).toBeTruthy());
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    expect(changes().textContent).toContain('03.12.2026');
  });
});
