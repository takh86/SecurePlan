// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/projekte"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { deferred, httpError, type Handler, type RecordedRequest } from '../employees/employees.test-support';
import { renderProjects } from './projects-render.test-support';
import { PROJECT_ID, calendarVersion, fakeCompany, project } from './projects.test-support';

afterEach(() => cleanup());

// Synthetic example records. Every weekday set is an explicit example, never a default or business rule.
// "Today" is 15.12.2026 (test clock); the in-memory company's current month is December 2026.
const PATH = `/projekte/${PROJECT_ID}`;
const CALENDAR_URL = `/api/v1/projects/${PROJECT_ID}/operating-calendar`;
const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const TUESDAY_TO_SATURDAY = [2, 3, 4, 5, 6];

const region = () => screen.getByRole('region', { name: 'Betriebstage' });
const box = (day: string) => within(region()).getByRole('checkbox', { name: day }) as HTMLInputElement;
const checked = () => DAYS.filter((day) => box(day).checked);
const calendarRequests = (requests: RecordedRequest[]) => requests.filter((request) => request.path.startsWith(CALENDAR_URL));
const patches = (requests: RecordedRequest[]) => calendarRequests(requests).filter((request) => request.method === 'PATCH');
const overview = (label: string) =>
  within(region()).getAllByRole('listitem').filter((item) => item.closest('ul')?.getAttribute('aria-label') === label)
    .map((item) => item.textContent);
const saveButton = () => within(region()).getByRole('button', { name: /^(Betriebstage speichern|Ersteinrichtung speichern)$/ }) as HTMLButtonElement;

async function openForm(user: ReturnType<typeof userEvent.setup>, name: string, heading: string) {
  await user.click(await screen.findByRole('button', { name }));
  await waitFor(() => expect(document.activeElement).toBe(within(region()).getByRole('heading', { name: heading })));
}

/** Delegates to the in-memory company; requests matching `hold` wait until released. */
function holding(server: ReturnType<typeof fakeCompany>, hold: (request: RecordedRequest) => boolean) {
  const gate = deferred<void>();
  const handler: Handler = (request) => (hold(request) ? gate.promise.then(() => server.handler(request)) : server.handler(request));
  return { handler, release: () => gate.resolve() };
}

describe('F-A1-2 reading the actual saved configuration', () => {
  it('MISSING: shows the state, no weekday overview and no assumed set; only the selected month is read', async () => {
    const { requests } = renderProjects(PATH, fakeCompany().handler);
    expect(await within(await screen.findByRole('region', { name: 'Betriebstage' })).findByText('Keine Betriebstage festgelegt')).toBeTruthy();
    const section = region();
    expect(within(section).getByText('Nicht festgelegt')).toBeTruthy();
    expect(within(section).getByText(/Es gibt keine Voreinstellung\./)).toBeTruthy();
    expect(within(section).queryByRole('list')).toBeNull();
    expect(within(section).getByRole('button', { name: 'Betriebstage ab Dezember 2026 festlegen' })).toBeTruthy();
    expect(calendarRequests(requests)).toEqual([{ path: `${CALENDAR_URL}?effectiveForMonth=2026-12-01`, method: 'GET', body: undefined }]);
  });

  it('CONFIGURED: the stored set Monday first, its version and the next stored version', async () => {
    renderProjects(PATH, fakeCompany({ calendarVersions: [
      calendarVersion('2026-12-01', TUESDAY_TO_SATURDAY, 3), calendarVersion('2027-03-01', [1, 2, 3]),
    ] }).handler);
    await screen.findByText('Für Dezember 2026 gespeichert');
    expect(within(region()).getByText('ab Dezember 2026 · Version 3')).toBeTruthy();
    expect(within(region()).getByText('ab März 2027')).toBeTruthy();
    // Visible short label (aria-hidden) + full name for assistive technology + state as text.
    expect(overview('Betriebstage ab Dezember 2026')).toEqual([
      'MoMontag: geschlossen', 'DiDienstag: in Betrieb', 'MiMittwoch: in Betrieb', 'DoDonnerstag: in Betrieb',
      'FrFreitag: in Betrieb', 'SaSamstag: in Betrieb', 'SoSonntag: geschlossen',
    ]);
    expect(within(region()).getByRole('button', { name: 'Betriebstage ab Dezember 2026 ändern' })).toBeTruthy();
  });

  it('an earlier version is shown as inherited for the selected month', async () => {
    renderProjects(PATH, fakeCompany({ calendarVersions: [calendarVersion('2026-10-01', [1, 2, 3, 4, 5], 2)] }).handler);
    await screen.findByText('Übernommen aus Oktober 2026');
    expect(within(region()).getByText('Für Dezember 2026 ist keine eigene Fassung gespeichert. Es gelten die Betriebstage ab Oktober 2026.'))
      .toBeTruthy();
    expect(within(region()).getByRole('button', { name: 'Eigene Betriebstage ab Dezember 2026 festlegen' })).toBeTruthy();
  });

  it('read failures use the safe shared texts; an answer for another project is never shown', async () => {
    const server = fakeCompany();
    server.fail((request) => (request.path.startsWith(CALENDAR_URL) ? httpError(500, 'INTERNAL_ERROR') : undefined));
    renderProjects(PATH, server.handler);
    const alert = await within(await screen.findByRole('region', { name: 'Betriebstage' })).findByRole('alert');
    expect(alert.textContent).toContain('Ein Fehler ist aufgetreten');
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(region()).findByText('Keine Betriebstage festgelegt')).toBeTruthy();

    cleanup();
    const foreign: Handler = (request) => (request.path.startsWith(CALENDAR_URL)
      ? { projectId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', effectiveForMonth: '2026-12-01', state: 'CONFIGURED',
          effective: { id: '9a000000-0000-4000-8000-202612000001', effectiveFromMonth: '2026-12-01', operatingWeekdays: [7], version: 1 },
          exactVersion: { id: '9a000000-0000-4000-8000-202612000001', version: 1 }, nextEffectiveFromMonth: null }
      : fakeCompany().handler(request));
    renderProjects(PATH, foreign);
    expect((await within(await screen.findByRole('region', { name: 'Betriebstage' })).findByRole('alert')).textContent)
      .toContain('Antwort konnte nicht verarbeitet werden');
    expect(within(region()).queryByRole('list')).toBeNull();
    expect(within(region()).queryByText('Sonntag:')).toBeNull();
  });
});

describe('F-A1-2 normal month-effective writes', () => {
  it('first configuration: nothing preselected, explicit selection required, exact null preconditions, server answer shown', async () => {
    const server = fakeCompany();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    const section = region();
    // Monday-first, accessible names are the full weekday names.
    expect(within(section).getAllByRole('checkbox')).toHaveLength(7);
    expect(DAYS.map((day) => box(day).labels?.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(within(within(section).getByRole('group', { name: 'Betriebstage ab Dezember 2026' })).getAllByRole('checkbox')
      .map((item) => (item.closest('label') as HTMLElement).textContent)).toEqual(['MoMontag', 'DiDienstag', 'MiMittwoch', 'DoDonnerstag', 'FrFreitag', 'SaSamstag', 'SoSonntag']);
    expect(checked()).toEqual([]);
    expect(within(section).getByText(/Erste Fassung für dieses Projekt\./)).toBeTruthy();
    expect(within(section).getByText(/Nach diesem Speichern ist die Ersteinrichtung nicht mehr möglich/)).toBeTruthy();
    expect(within(section).queryByText('Ungespeicherte Änderungen')).toBeNull();

    // No selection: explained at the fieldset, focus on the first weekday, nothing sent.
    await user.click(saveButton());
    expect(within(section).getByText(/Bitte wählen Sie mindestens einen Betriebstag aus\./)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box('Montag')));
    expect(box('Montag').getAttribute('aria-invalid')).toBe('true');
    expect(patches(requests)).toEqual([]);

    for (const day of ['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']) await user.click(box(day));
    expect(within(section).getByText('Ungespeicherte Änderungen')).toBeTruthy();
    expect(within(section).getByText('Ihre Auswahl gilt ab Dezember 2026 für alle folgenden Monate, bis eine spätere Fassung gespeichert wird.')).toBeTruthy();
    await user.click(saveButton());
    expect(await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 1).')).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([{
      effectiveFromMonth: '2026-12-01', expectedExactVersion: null, expectedEffective: null,
      expectedNextEffectiveFromMonth: null, operatingWeekdays: TUESDAY_TO_SATURDAY, bootstrap: false,
    }]);
    // The PATCH answer is the server's state: no second read, the overview shows the stored set.
    expect(calendarRequests(requests).filter((request) => request.method === 'GET')).toHaveLength(1);
    expect(within(region()).getByText('Für Dezember 2026 gespeichert')).toBeTruthy();
    expect(overview('Betriebstage ab Dezember 2026').filter((text) => text?.endsWith('in Betrieb'))).toHaveLength(5);
    expect(document.activeElement).toBe(screen.getByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 1).'));
    expect(server.state.calendarVersions.map((item) => [item.month, item.weekdays, item.version])).toEqual([['2026-12-01', TUESDAY_TO_SATURDAY, 1]]);
  });

  it('inherited version: preselected from the stored set, closed/opened days explained, own version written; October unchanged', async () => {
    const october = calendarVersion('2026-10-01', [1, 2, 3, 4, 5], 2);
    const server = fakeCompany({ calendarVersions: [october] });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Eigene Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    expect(checked()).toEqual(['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag']);
    expect(within(region()).getByText(/Beim Speichern entsteht eine eigene Fassung ab Dezember 2026, auch wenn Sie die Auswahl nicht ändern\./)).toBeTruthy();
    expect(within(region()).queryByText(/Erste Fassung für dieses Projekt/)).toBeNull();
    await user.click(box('Montag'));
    await user.click(box('Samstag'));
    expect(within(region()).getByText(/Montag\. Beginnt im Geltungszeitraum bereits ein gespeicherter Dienst an einem dieser Wochentage/)).toBeTruthy();
    expect(within(region()).getByText('Neu geschlossen:', { exact: false })).toBeTruthy();
    expect(within(region()).getByText('Samstag.', { exact: false })).toBeTruthy();
    await user.click(saveButton());
    await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 1).');
    expect(patches(requests)[0].body).toMatchObject({
      expectedExactVersion: null, expectedEffective: { id: october.id, version: 2 }, expectedNextEffectiveFromMonth: null,
      operatingWeekdays: [2, 3, 4, 5, 6],
    });
    expect(server.state.calendarVersions.find((item) => item.month === '2026-10-01')).toEqual(october);
  });

  it('own version with a later one: bounded interval across the year; unchanged selection sends nothing; a change increments the version', async () => {
    const server = fakeCompany({ calendarVersions: [
      calendarVersion('2026-12-01', TUESDAY_TO_SATURDAY, 3), calendarVersion('2027-03-01', [1, 2, 3]),
    ] });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 ändern', 'Betriebstage ab Dezember 2026 ändern');
    expect(within(region()).getByText('Ihre Auswahl gilt von Dezember 2026 bis einschließlich Februar 2027. Ab März 2027 gilt weiterhin die dort gespeicherte Fassung.'))
      .toBeTruthy();
    await user.click(saveButton());
    expect(await screen.findByText('Es gab keine Änderungen zu speichern.')).toBeTruthy();
    expect(patches(requests)).toEqual([]);

    await openForm(user, 'Betriebstage ab Dezember 2026 ändern', 'Betriebstage ab Dezember 2026 ändern');
    await user.click(box('Sonntag'));
    await user.click(saveButton());
    await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 4).');
    expect(patches(requests)[0].body).toMatchObject({
      expectedExactVersion: { version: 3 }, expectedEffective: { version: 3 }, expectedNextEffectiveFromMonth: '2027-03-01',
      operatingWeekdays: [2, 3, 4, 5, 6, 7],
    });
  });

  it('keyboard only: Tab reaches the weekdays Monday first, Space toggles, Enter on the save button submits', async () => {
    const server = fakeCompany();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.tab();
    expect(document.activeElement).toBe(box('Montag'));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(box('Mittwoch'));
    await user.keyboard(' ');
    expect(checked()).toEqual(['Mittwoch']);
    // Donnerstag … Sonntag, then the save button (the alert container is not in the tab order).
    for (let step = 0; step < 5; step += 1) await user.tab();
    expect(document.activeElement).toBe(saveButton());
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 1).')).toBeTruthy();
    expect(server.state.calendarVersions[0].weekdays).toEqual([3]);
  });

  it('a double submit sends exactly one PATCH; the controls are disabled while saving', async () => {
    const server = fakeCompany();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { requests } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.click(box('Freitag'));
    await user.click(saveButton());
    const pending = await within(region()).findByRole('button', { name: 'Wird gespeichert …' });
    fireEvent.submit(pending.closest('form')!);
    // Disabled through its fieldset (the input's own attribute stays unset).
    expect(box('Freitag').matches(':disabled')).toBe(true);
    held.release();
    await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 1).');
    expect(patches(requests)).toHaveLength(1);
  });

  it('a NO_OP answer is reported as "nothing changed"', async () => {
    const server = fakeCompany();
    const noOp: Handler = (request) => {
      const answer = server.handler(request) as Record<string, unknown>;
      return request.method === 'PATCH' ? { ...answer, outcome: 'NO_OP' } : answer;
    };
    renderProjects(PATH, noOp);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.click(box('Montag'));
    await user.click(saveButton());
    expect(await screen.findByText('Die Betriebstage ab Dezember 2026 waren bereits so gespeichert. Es wurde nichts geändert.')).toBeTruthy();
  });
});

describe('F-A1-2 conflicts keep the input', () => {
  it('stale version: German explanation, selection kept, saving blocked until the current state is loaded, then fresh preconditions', async () => {
    const server = fakeCompany({ calendarVersions: [calendarVersion('2026-12-01', TUESDAY_TO_SATURDAY, 3)] });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 ändern', 'Betriebstage ab Dezember 2026 ändern');
    await user.click(box('Sonntag'));
    // Another administrator saves meanwhile (version 4, Monday-Friday as an example).
    server.state.calendarVersions = [{ ...server.state.calendarVersions[0], weekdays: [1, 2, 3, 4, 5], version: 4 }];
    await user.click(saveButton());
    const alert = await within(region()).findByRole('alert');
    expect(alert.textContent).toContain('Betriebstage wurden inzwischen geändert');
    expect(alert.textContent).toContain('Ihre Auswahl bleibt erhalten. Es wurde nichts gespeichert.');
    await waitFor(() => expect(document.activeElement).toBe(alert.parentElement));
    expect(checked()).toEqual(['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']);
    expect(saveButton().disabled).toBe(true);
    expect(within(region()).getByText('Laden Sie zuerst den aktuellen Stand, bevor Sie erneut speichern.')).toBeTruthy();

    await user.click(within(region()).getByRole('button', { name: 'Aktuellen Stand laden' }));
    const reloaded = await within(region()).findByText(/^Aktueller Stand geladen:/);
    expect(reloaded.textContent).toBe('Aktueller Stand geladen: Ab Dezember 2026 gelten Montag, Dienstag, Mittwoch, Donnerstag und Freitag (Version 4). Ihre Auswahl ist unverändert. Prüfen Sie sie und speichern Sie bei Bedarf erneut.');
    await waitFor(() => expect(document.activeElement).toBe(reloaded));
    expect(checked()).toEqual(['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']);
    expect(within(region()).queryByRole('alert')).toBeNull();
    expect(within(region()).getByText(/Neu geschlossen/).parentElement?.textContent).toContain('Montag');

    await user.click(saveButton());
    await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 5).');
    expect(patches(requests).map((request) => (request.body as { expectedExactVersion: { version: number } }).expectedExactVersion.version)).toEqual([3, 4]);
  });

  it('newly closing an occupied date: explained, nothing changed, the input can be corrected and saved without a reload', async () => {
    const server = fakeCompany({
      calendarVersions: [calendarVersion('2026-12-01', TUESDAY_TO_SATURDAY, 3)],
      // A saved duty starting on Saturday 12.12.2026 (example).
      dutyDates: [{ projectId: PROJECT_ID, date: '2026-12-12' }],
    });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 ändern', 'Betriebstage ab Dezember 2026 ändern');
    await user.click(box('Samstag'));
    await user.click(saveButton());
    const alert = await within(region()).findByRole('alert');
    expect(alert.textContent).toContain('Gespeicherte Dienste an geschlossenen Tagen');
    expect(alert.textContent).toContain('auch Dienste ohne Besetzung und Dienste veröffentlichter Pläne zählen');
    expect(alert.textContent).not.toMatch(/12\.12\.2026|2026-12-12/);
    expect(checked()).toEqual(['Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag']);
    expect(server.state.calendarVersions[0].version).toBe(3);
    expect(saveButton().disabled).toBe(false);

    await user.click(box('Samstag'));
    await user.click(box('Dienstag'));
    await user.click(saveButton());
    await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 4).');
    expect(patches(requests)).toHaveLength(2);
  });

  it('lost answer after commit: outcome unknown, no blind resend; the reloaded state matches, so nothing is sent again', async () => {
    const server = fakeCompany();
    const lost: Handler = (request) => {
      const answer = server.handler(request);
      if (request.method === 'PATCH') throw new ApiError('network', null, null, null);
      return answer;
    };
    const { requests } = renderProjects(PATH, lost);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.click(box('Montag'));
    await user.click(saveButton());
    const alert = await within(region()).findByRole('alert');
    expect(alert.textContent).toContain('Ergebnis unbekannt');
    expect(alert.textContent).not.toContain('nichts gespeichert');
    expect(saveButton().disabled).toBe(true);
    expect(checked()).toEqual(['Montag']);

    await user.click(within(region()).getByRole('button', { name: 'Aktuellen Stand laden' }));
    await within(region()).findByText(/^Aktueller Stand geladen: Ab Dezember 2026 gelten Montag \(Version 1\)\./);
    // Selection equals the stored set: no unsaved marker; saving again writes nothing.
    expect(within(region()).queryByText('Ungespeicherte Änderungen')).toBeNull();
    await user.click(saveButton());
    expect(await screen.findByText('Es gab keine Änderungen zu speichern.')).toBeTruthy();
    expect(patches(requests)).toHaveLength(1);
    expect(server.state.calendarVersions).toHaveLength(1);
    expect(within(region()).getByText('Für Dezember 2026 gespeichert')).toBeTruthy();
  });

  it('project deactivated meanwhile: PROJECT_INACTIVE ends the form (no reload offer), the input stays visible', async () => {
    const server = fakeCompany();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    server.state.projects[0] = { ...server.state.projects[0], status: 'INACTIVE' };
    await user.click(box('Donnerstag'));
    await user.click(saveButton());
    expect((await within(region()).findByRole('alert')).textContent).toContain('Projekt ist inaktiv');
    expect(within(region()).queryByRole('button', { name: 'Aktuellen Stand laden' })).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(checked()).toEqual(['Donnerstag']);
  });
});

describe('F-A1-2 one-time historical bootstrap', () => {
  // Example legacy duties (saved before A1): Tuesdays 8.9.2026 and 13.10.2026.
  const legacy = () => fakeCompany({ dutyDates: [
    { projectId: PROJECT_ID, date: '2026-09-08' }, { projectId: PROJECT_ID, date: '2026-10-13' },
  ] });

  it('only for a past month without any stored version; warnings and an explicit confirmation before the request', async () => {
    const server = legacy();
    const { requests } = renderProjects(`${PATH}/2026-09`, server.handler);
    const user = userEvent.setup();
    await screen.findByText('Für dieses Projekt sind noch keine Betriebstage gespeichert. Für einen vergangenen Monat ist nur die einmalige Ersteinrichtung möglich.');
    await openForm(user, 'Einmalige Ersteinrichtung ab September 2026 …', 'Einmalige Ersteinrichtung ab September 2026');
    const form = within(region()).getByRole('form', { name: 'Einmalige Ersteinrichtung ab September 2026' });
    expect(form.getAttribute('aria-describedby')).toBeTruthy();
    for (const warning of [
      'Einmalige Ersteinrichtung – bitte sorgfältig prüfen.',
      /nur ab dem Monat des frühesten gespeicherten Dienstes dieses Projekts/,
      /auch Dienste ohne Besetzung und Dienste veröffentlichter Pläne\. Dienste werden dabei nicht geändert oder gelöscht\./,
      /kein Nachweis früherer Betriebszeiten/,
    ]) expect(within(form).getByText(warning)).toBeTruthy();
    expect(checked()).toEqual([]);

    await user.click(box('Montag'));
    await user.click(saveButton());
    const confirm = within(form).getByRole('checkbox', { name: /Ich habe die Auswahl geprüft\./ });
    expect(within(form).getByText('Bitte bestätigen Sie die einmalige Ersteinrichtung ausdrücklich.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    expect(patches(requests)).toEqual([]);

    // Monday would exclude the saved Tuesday duties: refused, nothing written.
    await user.click(confirm);
    await user.click(saveButton());
    const alert = await within(region()).findByRole('alert');
    expect(alert.textContent).toContain('Die Ersteinrichtung muss alle gespeicherten Dienste ab September 2026 abdecken');
    expect(server.state.calendarVersions).toEqual([]);

    await user.click(box('Dienstag'));
    await user.click(saveButton());
    expect(await screen.findByText('Die einmalige Ersteinrichtung ab September 2026 wurde gespeichert (Version 1).')).toBeTruthy();
    expect(patches(requests).map((request) => (request.body as { bootstrap: boolean }).bootstrap)).toEqual([true, true]);
    expect(patches(requests)[1].body).toEqual({
      effectiveFromMonth: '2026-09-01', expectedExactVersion: null, expectedEffective: null,
      expectedNextEffectiveFromMonth: null, operatingWeekdays: [1, 2], bootstrap: true,
    });
    // Afterwards the past month is read-only and the bootstrap is gone.
    expect(within(region()).getByText('September 2026 liegt in der Vergangenheit. Betriebstage vergangener Monate können nicht geändert werden.')).toBeTruthy();
    expect(within(region()).queryByRole('button', { name: /Ersteinrichtung/ })).toBeNull();
  });

  it('the server decides the bootstrap month: a later month is refused with guidance; the input stays', async () => {
    const server = legacy();
    renderProjects(`${PATH}/2026-10`, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Einmalige Ersteinrichtung ab Oktober 2026 …', 'Einmalige Ersteinrichtung ab Oktober 2026');
    await user.click(box('Dienstag'));
    await user.click(within(region()).getByRole('checkbox', { name: /Ich habe die Auswahl geprüft\./ }));
    await user.click(saveButton());
    const alert = await within(region()).findByRole('alert');
    expect(alert.textContent).toContain('Ersteinrichtung für Oktober 2026 nicht möglich');
    expect(alert.textContent).toContain('Wechseln Sie über die Monatsnavigation zu diesem Monat.');
    expect(checked()).toEqual(['Dienstag']);
    expect(server.state.calendarVersions).toEqual([]);
  });

  it('a stored version anywhere removes the bootstrap: a past month is then read-only with the reason', async () => {
    renderProjects(`${PATH}/2026-09`, fakeCompany({ calendarVersions: [calendarVersion('2026-12-01', [1])] }).handler);
    expect(await screen.findByText(/Die einmalige Ersteinrichtung ist nicht mehr möglich, weil für dieses Projekt bereits Betriebstage ab Dezember 2026 gespeichert sind\./))
      .toBeTruthy();
    expect(within(region()).queryByRole('button', { name: /festlegen|ändern|Ersteinrichtung/ })).toBeNull();
  });

  it('a bootstrap opened before another admin configured the project: stale, then blocked with the reason after reload', async () => {
    const server = legacy();
    renderProjects(`${PATH}/2026-09`, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Einmalige Ersteinrichtung ab September 2026 …', 'Einmalige Ersteinrichtung ab September 2026');
    server.state.calendarVersions = [calendarVersion('2026-12-01', [2])];
    await user.click(box('Dienstag'));
    await user.click(within(region()).getByRole('checkbox', { name: /Ich habe die Auswahl geprüft\./ }));
    await user.click(saveButton());
    expect((await within(region()).findByRole('alert')).textContent).toContain('Betriebstage wurden inzwischen geändert');
    await user.click(within(region()).getByRole('button', { name: 'Aktuellen Stand laden' }));
    expect(await within(region()).findByText(/Die einmalige Ersteinrichtung ist nicht mehr möglich, weil für dieses Projekt bereits Betriebstage ab Dezember 2026 gespeichert sind\./))
      .toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    // The confirmation belongs to the old basis and is reset.
    expect((within(region()).getByRole('checkbox', { name: /Ich habe die Auswahl geprüft\./ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('F-A1-2 read-only states', () => {
  it('an INACTIVE project shows its calendar but offers no write', async () => {
    renderProjects(PATH, fakeCompany({
      projects: [project({ status: 'INACTIVE' })], calendarVersions: [calendarVersion('2026-12-01', [6, 7])],
    }).handler);
    await screen.findByText('Für Dezember 2026 gespeichert');
    expect(within(region()).getByText(/Das Projekt ist inaktiv\. Betriebstage können nur angesehen werden/)).toBeTruthy();
    expect(within(region()).queryByRole('button')).toBeNull();
  });
});

describe('F-A1-2 unsaved input and navigation', () => {
  it('month links ask first ("Ungespeicherte Betriebstage"); staying keeps the selection; discarding is explicit', async () => {
    const server = fakeCompany();
    const { location, requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.click(box('Sonntag'));
    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    await user.click(next);
    expect(location()).toBe(PATH);
    const prompt = screen.getByRole('group', { name: 'Ungespeicherte Betriebstage' });
    expect(prompt.textContent).toContain('Die Auswahl der Betriebstage ab Dezember 2026 ist noch nicht gespeichert.');
    await user.click(within(prompt).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(document.activeElement).toBe(next);
    expect(checked()).toEqual(['Sonntag']);

    await user.click(next);
    await user.click(screen.getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(await within(region()).findByText('Keine Betriebstage festgelegt')).toBeTruthy();
    expect(patches(requests)).toEqual([]);
  });

  it('two forms with changes are named together in one prompt', async () => {
    renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.click(box('Montag'));
    await user.click(await screen.findByRole('button', { name: 'Schichtzeiten ab Dezember 2026 festlegen' }));
    const end = screen.getByLabelText('Ende Tagschicht') as HTMLInputElement;
    await user.clear(end);
    await user.type(end, '17:45');
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    const prompt = screen.getByRole('group', { name: 'Ungespeicherte Änderungen' });
    expect(prompt.textContent).toContain('Die Auswahl der Betriebstage ab Dezember 2026 ist noch nicht gespeichert.');
    expect(prompt.textContent).toContain('Die Änderungen an den Schichtzeiten ab Dezember 2026 sind noch nicht gespeichert.');
  });

  it('the browser asks before a reload only while a selection is unsaved or a save is running', async () => {
    const server = fakeCompany();
    const held = holding(server, (request) => request.method === 'PATCH');
    renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    const reload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    expect(reload()).toBe(false);
    await user.click(box('Dienstag'));
    expect(reload()).toBe(true);
    await user.click(saveButton());
    await within(region()).findByRole('button', { name: 'Wird gespeichert …' });
    expect(reload()).toBe(true);
    held.release();
    await screen.findByText('Die Betriebstage ab Dezember 2026 wurden gespeichert (Version 1).');
    expect(reload()).toBe(false);
  });

  it('cancel discards the selection and returns focus to the edit button', async () => {
    renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await openForm(user, 'Betriebstage ab Dezember 2026 festlegen', 'Betriebstage ab Dezember 2026 festlegen');
    await user.click(box('Montag'));
    await user.click(within(region()).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Betriebstage ab Dezember 2026 festlegen' })));
    expect(within(region()).getByText('Keine Betriebstage festgelegt')).toBeTruthy();
  });
});
