// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/projekte"}
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SESSION_REDIRECT_STATE } from '../../app/session-redirect';
import { ApiError } from '../../shared/api/api-error';
import { deferred, httpError, type Handler, type RecordedRequest } from '../employees/employees.test-support';
import { renderProjects } from './projects-render.test-support';
import { PROJECT_ID, fakeCompany, project, shiftVersion } from './projects.test-support';

afterEach(() => cleanup());

// Synthetic example records and times, not business rules. "Today" is 15.12.2026 (test clock).
const PATH = `/projekte/${PROJECT_ID}`;
const SHIFT_URL = `/api/v1/projects/${PROJECT_ID}/shift-configuration`;
const october = () => shiftVersion('2026-10-01', [['DAY', '07:00', '19:00'], ['NIGHT', '19:00', '07:00']]);
const december = () => shiftVersion('2026-12-01', [['DAY', '06:00', '18:00'], ['NIGHT', '18:00', '06:00']]);
const january = () => shiftVersion('2027-01-01', [['DAY', '08:00', '20:00']]);

const region = () => screen.getByRole('region', { name: 'Schichtzeiten' });
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const shiftRequests = (requests: RecordedRequest[]) => requests.filter((request) => request.path.startsWith(SHIFT_URL));
const patches = (requests: RecordedRequest[]) => shiftRequests(requests).filter((request) => request.method === 'PATCH');
const rowTexts = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map((row) => row.textContent);

/** Opens the editor via its (state-dependent) button and waits until focus is inside the form. */
async function openEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name }));
  await waitFor(() => expect(document.activeElement).toBe(field('Tagschicht verwenden')));
}

/** Delegates to the in-memory company, but holds back requests matching `hold` until released. */
function holding(server: ReturnType<typeof fakeCompany>, hold: (request: RecordedRequest) => boolean) {
  const gate = deferred<void>();
  const handler: Handler = (request) => (hold(request) ? gate.promise.then(() => server.handler(request)) : server.handler(request));
  return { handler, release: () => gate.resolve() };
}

describe('SP-08b — reading (requestedMonth vs. effectiveFromMonth)', () => {
  it('1: an unconfigured project shows an empty state; the suggested times are labelled and never saved on their own', async () => {
    const server = fakeCompany();
    const { requests } = renderProjects(PATH, server.handler);
    expect(await screen.findByText('Noch keine Schichtzeiten')).toBeTruthy();
    const section = region();
    expect(within(section).getByText('Nicht konfiguriert')).toBeTruthy();
    expect(within(section).getByText('Keine')).toBeTruthy();
    expect(within(section).getByText(/Ortszeit in der Zeitzone Ihres Unternehmens/)).toBeTruthy();
    expect(shiftRequests(requests)).toEqual([{ path: `${SHIFT_URL}?effectiveForMonth=2026-12-01`, method: 'GET', body: undefined }]);

    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    expect(within(section).getByText('Vorschlag, nicht gespeichert:')).toBeTruthy();
    expect([field('Beginn Tagschicht').value, field('Ende Tagschicht').value, field('Beginn Nachtschicht').value, field('Ende Nachtschicht').value])
      .toEqual(['06:00', '18:00', '18:00', '06:00']);
    // Opening the editor is not a change: no "unsaved" marker, nothing sent.
    expect(within(section).queryByText('Ungespeicherte Änderungen')).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Schichtzeiten ab Dezember 2026 festlegen' })));
    expect(patches(requests)).toEqual([]);
    expect(server.state.shiftVersions).toEqual([]);
  });

  it('2: without an own version, the October version is shown as inherited for December', async () => {
    renderProjects(PATH, fakeCompany({ shiftVersions: [october()] }).handler);
    const table = await screen.findByRole('table', { name: 'Schichtzeiten ab Oktober 2026' });
    expect(rowTexts(table)).toEqual(['Tagschicht07:0019:00', 'Nachtschicht19:0007:00 (Folgetag)']);
    const section = region();
    expect(within(section).getByText('Dezember 2026')).toBeTruthy();
    expect(within(section).getByText('ab Oktober 2026')).toBeTruthy();
    expect(within(section).getByText('Übernommen aus Oktober 2026')).toBeTruthy();
    expect(within(section).getByText('Für Dezember 2026 ist keine eigene Version gespeichert. Es gelten die Schichtzeiten ab Oktober 2026.'))
      .toBeTruthy();
    expect(screen.getByRole('button', { name: 'Eigene Schichtzeiten ab Dezember 2026 festlegen' })).toBeTruthy();
  });

  it('SHIFT_CONFIGURATION_MISSING (reserved for SP-11) is never treated as the empty state of a GET', async () => {
    const server = fakeCompany();
    // What the client gets for a 409 with a code it does not know.
    server.fail((request) => (request.path.startsWith(SHIFT_URL) ? new ApiError('http', 409, null, 'req-missing') : undefined));
    renderProjects(PATH, server.handler);
    const alert = await within(await screen.findByRole('region', { name: 'Schichtzeiten' })).findByRole('alert');
    expect(alert.textContent).toContain('Konflikt');
    expect(screen.queryByText('Noch keine Schichtzeiten')).toBeNull();
  });
});

describe('SP-08b — saving versions (full replacement)', () => {
  it('3/4/14: saving an inherited configuration writes a NEW version for the selected month, even unchanged; October stays; data are re-read', async () => {
    const server = fakeCompany({ shiftVersions: [october()] });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Eigene Schichtzeiten ab Dezember 2026 festlegen');
    const section = region();
    expect(section.textContent).toContain('Vorbelegt sind die Schichtzeiten ab Oktober 2026');
    expect(section.textContent).toContain('eigene Version ab Dezember 2026, auch wenn Sie die Uhrzeiten nicht ändern');
    expect(section.textContent).toContain('Die Version ab Oktober 2026 bleibt unverändert.');
    expect(field('Beginn Tagschicht').value).toBe('07:00');

    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    const notice = await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    expect(patches(requests)).toEqual([{
      path: SHIFT_URL,
      method: 'PATCH',
      body: {
        effectiveFromMonth: '2026-12-01',
        shifts: [
          { shiftKind: 'DAY', startLocal: '07:00', endLocal: '19:00' },
          { shiftKind: 'NIGHT', startLocal: '19:00', endLocal: '07:00' },
        ],
      },
    }]);
    // October is untouched; December is a version of its own.
    expect(server.state.shiftVersions.find((version) => version.month === '2026-10-01')).toEqual(october());
    expect(server.state.shiftVersions.map((version) => version.month).sort()).toEqual(['2026-10-01', '2026-12-01']);
    // The view shows the state read back from the API after the write.
    const patchAt = requests.findIndex((request) => request.method === 'PATCH');
    expect(requests.slice(patchAt + 1).map((request) => request.path)).toContain(`${SHIFT_URL}?effectiveForMonth=2026-12-01`);
    expect(await within(section).findByText('Für Dezember 2026 gespeichert')).toBeTruthy();

    // Reload: a fresh mount reads the persisted versions; November still inherits October.
    cleanup();
    renderProjects(PATH, server.handler);
    expect(await screen.findByRole('table', { name: 'Schichtzeiten ab Dezember 2026' })).toBeTruthy();
    cleanup();
    renderProjects(`${PATH}/2026-11`, server.handler);
    const november = await screen.findByRole('table', { name: 'Schichtzeiten ab Oktober 2026' });
    expect(rowTexts(november)).toEqual(['Tagschicht07:0019:00', 'Nachtschicht19:0007:00 (Folgetag)']);
  });

  it('5: changing an own version sends DAY and NIGHT completely; the retimed kind keeps its id', async () => {
    const server = fakeCompany({ shiftVersions: [december()] });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 ändern');
    expect(region().textContent).toContain('Sie ändern die gespeicherte Version ab Dezember 2026.');
    await user.clear(field('Ende Tagschicht'));
    await user.type(field('Ende Tagschicht'), '17:30');
    expect(within(region()).getByText('Ungespeicherte Änderungen')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));

    expect(await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([{
      effectiveFromMonth: '2026-12-01',
      shifts: [
        { shiftKind: 'DAY', startLocal: '06:00', endLocal: '17:30' },
        { shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' },
      ],
    }]);
    const table = await screen.findByRole('table', { name: 'Schichtzeiten ab Dezember 2026' });
    expect(rowTexts(table)).toEqual(['Tagschicht06:0017:30', 'Nachtschicht18:0006:00 (Folgetag)']);
    expect(server.state.shiftVersions[0].shifts.map((rule) => rule.id)).toEqual(december().shifts.map((rule) => rule.id));
  });

  it('6: deselecting NIGHT saves only DAY; NIGHT is then not configured from this month on; removing both is refused', async () => {
    const server = fakeCompany({ shiftVersions: [december()] });
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 ändern');
    expect(region().textContent).toContain('Eine nicht ausgewählte Schichtart gilt ab Dezember 2026 als nicht konfiguriert');

    // Both deselected: explained at the checkboxes, nothing is sent.
    await user.click(field('Tagschicht verwenden'));
    await user.click(field('Nachtschicht verwenden'));
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    expect(screen.getByText(/mindestens eine Schichtart aus/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field('Tagschicht verwenden')));
    expect(field('Tagschicht verwenden').getAttribute('aria-invalid')).toBe('true');
    expect(patches(requests)).toEqual([]);

    await user.click(field('Tagschicht verwenden'));
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    expect(await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([{
      effectiveFromMonth: '2026-12-01',
      shifts: [{ shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' }],
    }]);
    expect(rowTexts(await screen.findByRole('table', { name: 'Schichtzeiten ab Dezember 2026' })))
      .toEqual(['Tagschicht06:0018:00', 'NachtschichtNicht konfiguriert']);
  });

  it('validates on the client first: focus moves to the first invalid field, which is described by its error', async () => {
    const server = fakeCompany();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    await user.clear(field('Beginn Tagschicht'));
    await user.type(field('Beginn Tagschicht'), '6:00');
    await user.clear(field('Ende Nachtschicht'));
    await user.type(field('Ende Nachtschicht'), '18:00');
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));

    const start = field('Beginn Tagschicht');
    await waitFor(() => expect(document.activeElement).toBe(start));
    expect(start.getAttribute('aria-invalid')).toBe('true');
    const errorId = start.getAttribute('aria-describedby')!.split(' ').find((id) => id.endsWith('-error'))!;
    expect(document.getElementById(errorId)?.textContent).toContain('Format HH:MM');
    expect(field('Ende Nachtschicht').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Beginn und Ende müssen sich unterscheiden.')).toBeTruthy();
    expect(patches(requests)).toEqual([]);
  });

  it('works with the keyboard only and states the last-writer-wins behaviour honestly', async () => {
    const server = fakeCompany();
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    const edit = await screen.findByRole('button', { name: 'Schichtzeiten ab Dezember 2026 festlegen' });
    edit.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(field('Tagschicht verwenden')));
    expect(region().textContent).toContain('gilt die zuletzt gespeicherte Fassung');
    expect(region().textContent).toContain('Gleichzeitige Änderungen werden nicht erkannt');
    await user.tab();
    expect(document.activeElement).toBe(field('Beginn Tagschicht'));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
    expect(server.state.shiftVersions.map((version) => version.month)).toEqual(['2026-12-01']);
  });
});

describe('SP-08b — read-only states', () => {
  it('7: an INACTIVE project shows its shift times but offers no editing', async () => {
    const server = fakeCompany({ projects: [project({ status: 'INACTIVE' })], shiftVersions: [december()] });
    const { requests } = renderProjects(PATH, server.handler);
    expect(await screen.findByRole('table', { name: 'Schichtzeiten ab Dezember 2026' })).toBeTruthy();
    expect(within(region()).getByText(/Das Projekt ist inaktiv. Schichtzeiten können nur angesehen werden/)).toBeTruthy();
    expect(within(region()).queryByRole('button')).toBeNull();
    expect(patches(requests)).toEqual([]);
  });

  it('8: a past month is read-only; the current and a future month are editable', async () => {
    const server = fakeCompany({ shiftVersions: [october()] });
    renderProjects(`${PATH}/2026-10`, server.handler);
    expect(await screen.findByRole('table', { name: 'Schichtzeiten ab Oktober 2026' })).toBeTruthy();
    expect(within(region()).getByText('Oktober 2026 liegt in der Vergangenheit. Schichtzeiten vergangener Monate können nicht geändert werden.'))
      .toBeTruthy();
    expect(within(region()).queryByRole('button')).toBeNull();

    cleanup();
    renderProjects(`${PATH}/2027-01`, server.handler);
    expect(await screen.findByRole('button', { name: 'Eigene Schichtzeiten ab Januar 2027 festlegen' })).toBeTruthy();
  });
});

describe('SP-08b — failures', () => {
  it.each([
    ['SHIFT_CONFIGURATION_INVALID', 400, 'Schichtzeiten nicht zulässig'],
    ['SHIFT_CONFIGURATION_CONFLICT', 409, 'Schichtzeiten derzeit nicht änderbar'],
    ['PROJECT_INACTIVE', 409, 'Projekt ist inaktiv'],
    ['INVALID_MONTH_START', 400, 'Monat ungültig'],
    ['RESOURCE_NOT_FOUND', 404, 'Nicht gefunden'],
    ['VALIDATION_FAILED', 400, 'Eingaben überprüfen'],
  ] as const)('9: %s is explained safely with the reference id; input stays and focus moves to the message', async (code, status, title) => {
    const server = fakeCompany({ shiftVersions: [december()] });
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 ändern');
    await user.clear(field('Ende Tagschicht'));
    await user.type(field('Ende Tagschicht'), '17:00');
    server.fail((request) => (request.method === 'PATCH' ? httpError(status, code) : undefined));
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));

    const alert = await within(region()).findByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain('req-sp07-1');
    await waitFor(() => expect(alert.parentElement?.contains(document.activeElement) || document.activeElement === alert.parentElement).toBe(true));
    expect(field('Ende Tagschicht').value).toBe('17:00');
    expect(server.state.shiftVersions).toEqual([december()]);
  });

  it('9: a server field error is shown at the field it belongs to', async () => {
    const server = fakeCompany({ shiftVersions: [december()] });
    renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 ändern');
    server.fail((request) => (request.method === 'PATCH'
      ? httpError(400, 'VALIDATION_FAILED', [{ pointer: '#/shifts/1/endLocal', code: 'INVALID_FORMAT' }])
      : undefined));
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    expect(await within(region()).findByRole('alert')).toBeTruthy();
    expect(field('Ende Nachtschicht').getAttribute('aria-invalid')).toBe('true');
    expect(field('Ende Tagschicht').getAttribute('aria-invalid')).toBeNull();
  });

  it('10: a double submit sends exactly one PATCH; the button is disabled while saving', async () => {
    const server = fakeCompany();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { requests } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    const pending = await screen.findByRole('button', { name: 'Wird gespeichert …' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    // A second submit (e.g. Enter in a field) while the first is in flight.
    fireEvent.submit(pending.closest('form')!);
    fireEvent.submit(pending.closest('form')!);
    expect(patches(requests)).toHaveLength(1);

    held.release();
    expect(await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
    expect(patches(requests)).toHaveLength(1);
    expect(server.state.shiftVersions).toHaveLength(1);
  });

  it('11: a failed save keeps every input; the same values can be saved again', async () => {
    const server = fakeCompany();
    const { requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    await user.click(field('Nachtschicht verwenden'));
    await user.clear(field('Beginn Tagschicht'));
    await user.type(field('Beginn Tagschicht'), '05:30');
    server.fail((request) => (request.method === 'PATCH' ? new ApiError('network', null, null, null) : undefined));
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));

    expect((await within(region()).findByRole('alert')).textContent).toContain('Verbindung fehlgeschlagen');
    expect(field('Beginn Tagschicht').value).toBe('05:30');
    expect(field('Nachtschicht verwenden').checked).toBe(false);
    expect(server.state.shiftVersions).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    expect(await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
    expect(patches(requests).map((request) => request.body)).toEqual([
      { effectiveFromMonth: '2026-12-01', shifts: [{ shiftKind: 'DAY', startLocal: '05:30', endLocal: '18:00' }] },
      { effectiveFromMonth: '2026-12-01', shifts: [{ shiftKind: 'DAY', startLocal: '05:30', endLocal: '18:00' }] },
    ]);
  });
});

describe('SP-08b — month changes and unsaved changes', () => {
  it('12: a late answer for the previous month never appears in the new month', async () => {
    const server = fakeCompany({ shiftVersions: [december(), january()] });
    const held = holding(server, (request) => request.path === `${SHIFT_URL}?effectiveForMonth=2026-12-01`);
    const { location } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    expect(await within(await screen.findByRole('region', { name: 'Schichtzeiten' })).findByText('Schichtzeiten werden geladen …')).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    const table = await screen.findByRole('table', { name: 'Schichtzeiten ab Januar 2027' });

    held.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rowTexts(table)).toEqual(['Tagschicht08:0020:00', 'NachtschichtNicht konfiguriert']);
    expect(screen.queryByRole('table', { name: 'Schichtzeiten ab Dezember 2026' })).toBeNull();
  });

  it('12: leaving during a running save is confirmed first; its outcome never shows up in the new month', async () => {
    const server = fakeCompany({ shiftVersions: [january()] });
    const held = holding(server, (request) => request.method === 'PATCH');
    const { location } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    await screen.findByRole('button', { name: 'Wird gespeichert …' });

    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    // A running save is neither presented as safely discarded nor as cancelled.
    const prompt = screen.getByRole('group', { name: 'Speichern läuft noch' });
    expect(prompt.textContent).toContain('Ein Wechsel bricht das Speichern nicht ab');
    expect(within(prompt).queryByRole('button', { name: 'Änderungen verwerfen und wechseln' })).toBeNull();
    await user.click(within(prompt).getByRole('button', { name: 'Trotzdem wechseln' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(await screen.findByRole('table', { name: 'Schichtzeiten ab Januar 2027' })).toBeTruthy();

    held.release();
    await waitFor(() => expect(server.state.shiftVersions.map((version) => version.month).sort()).toEqual(['2026-12-01', '2027-01-01']));
    expect(screen.queryByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeNull();
    expect(screen.getByRole('table', { name: 'Schichtzeiten ab Januar 2027' })).toBeTruthy();
  });

  it('unsaved input is not discarded silently: month links ask first; "Weiter bearbeiten" keeps everything', async () => {
    const server = fakeCompany();
    const { location, requests } = renderProjects(PATH, server.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    await user.clear(field('Ende Tagschicht'));
    await user.type(field('Ende Tagschicht'), '17:45');

    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    await user.click(next);
    expect(location()).toBe(PATH);
    const prompt = screen.getByRole('group', { name: 'Ungespeicherte Schichtzeiten' });
    await waitFor(() => expect(document.activeElement).toBe(within(prompt).getByRole('heading', { name: 'Ungespeicherte Schichtzeiten' })));
    await user.click(within(prompt).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(screen.queryByRole('group', { name: 'Ungespeicherte Schichtzeiten' })).toBeNull();
    expect(document.activeElement).toBe(next);
    expect(field('Ende Tagschicht').value).toBe('17:45');

    // The back link is guarded too; discarding is an explicit choice.
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await user.click(screen.getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    expect(location()).toBe('/projekte');
    expect(patches(requests)).toEqual([]);
  });

  it('asks the browser before a reload only while there are unsaved changes; an untouched editor never blocks', async () => {
    const { location } = renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    const reload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(reload()).toBe(false);
    await user.clear(field('Beginn Nachtschicht'));
    await user.type(field('Beginn Nachtschicht'), '19:00');
    expect(reload()).toBe(true);
    await user.click(within(region()).getByRole('button', { name: 'Abbrechen' }));
    expect(reload()).toBe(false);

    // Without changes, month steps are not interrupted.
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(location()).toBe(`${PATH}/2027-01`);
    expect(screen.queryByRole('group', { name: 'Ungespeicherte Schichtzeiten' })).toBeNull();
  });

  it('a running save also asks the browser before a reload', async () => {
    const server = fakeCompany();
    const held = holding(server, (request) => request.method === 'PATCH');
    renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Dezember 2026 festlegen');
    // Unchanged suggestion values: not dirty, but the save is not confirmed yet.
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    await screen.findByRole('button', { name: 'Wird gespeichert …' });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    held.release();
    expect(await screen.findByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
  });
});

describe('SP-08b — navigation blocking (data router, useBlocker)', () => {
  const prompt = (name = 'Ungespeicherte Schichtzeiten') => screen.queryByRole('group', { name });

  async function dirtyEditor(user: ReturnType<typeof userEvent.setup>, month = 'Dezember 2026') {
    await openEditor(user, `Schichtzeiten ab ${month} festlegen`);
    await user.clear(field('Ende Tagschicht'));
    await user.type(field('Ende Tagschicht'), '17:45');
  }

  it('Browser Back and Forward (POP) are held: "Weiter bearbeiten" resets, discarding proceeds once', async () => {
    const { router, location } = renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    // History: December -> January (clean step), then back to December.
    await user.click(await screen.findByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(await screen.findByRole('button', { name: 'Schichtzeiten ab Januar 2027 festlegen' })).toBeTruthy();
    await act(async () => { await router.navigate(-1); });
    expect(location()).toBe(PATH);

    // Forward with unsaved input: held.
    await dirtyEditor(user);
    await act(async () => { await router.navigate(1); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(PATH);
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(prompt()).toBeNull();
    expect(field('Ende Tagschicht').value).toBe('17:45');

    await act(async () => { await router.navigate(1); });
    await user.click(within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    await waitFor(() => expect(location()).toBe(`${PATH}/2027-01`));
    expect(await screen.findByRole('button', { name: 'Schichtzeiten ab Januar 2027 festlegen' })).toBeTruthy();

    // Back with unsaved input: held as well.
    await dirtyEditor(user, 'Januar 2027');
    await act(async () => { await router.navigate(-1); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(`${PATH}/2027-01`);
    await user.click(within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    await waitFor(() => expect(location()).toBe(PATH));
  });

  it('a normal REPLACE without the session marker stays guarded; only the marked session redirect passes', async () => {
    const { router, location } = renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await dirtyEditor(user);

    await act(async () => { await router.navigate('/projekte', { replace: true }); });
    expect(prompt()).toBeTruthy();
    expect(location()).toBe(PATH);
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));

    await act(async () => { await router.navigate('/', { replace: true, state: SESSION_REDIRECT_STATE }); });
    expect(location()).toBe('/');
    expect(prompt()).toBeNull();
  });

  describe('F-3: only a marked REPLACE to a bare "/" is exempt from the guard', () => {
    async function expectHeld(
      target: string,
      options: { replace?: boolean; state?: unknown },
    ) {
      const { router, location } = renderProjects(PATH, fakeCompany().handler);
      const user = userEvent.setup();
      await dirtyEditor(user);
      await act(async () => { await router.navigate(target, options); });
      expect(prompt()).toBeTruthy();
      expect(location()).toBe(PATH);
      await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));
      expect(field('Ende Tagschicht').value).toBe('17:45');
    }

    it('1: a marked REPLACE to "/" passes without a prompt', async () => {
      const { router, location } = renderProjects(PATH, fakeCompany().handler);
      const user = userEvent.setup();
      await dirtyEditor(user);
      await act(async () => { await router.navigate('/', { replace: true, state: SESSION_REDIRECT_STATE }); });
      expect(location()).toBe('/');
      expect(prompt()).toBeNull();
    });

    it('2: a marked REPLACE to /projekte is held', async () => {
      await expectHeld('/projekte', { replace: true, state: SESSION_REDIRECT_STATE });
    });

    it('3: a marked PUSH to "/" is held', async () => {
      await expectHeld('/', { state: SESSION_REDIRECT_STATE });
    });

    it('4: an unmarked REPLACE to "/" is held', async () => {
      await expectHeld('/', { replace: true });
    });

    it('a marked REPLACE to "/" with extra search or hash is held', async () => {
      await expectHeld('/?next=x', { replace: true, state: SESSION_REDIRECT_STATE });
      cleanup();
      await expectHeld('/#x', { replace: true, state: SESSION_REDIRECT_STATE });
    });
  });

  it('navigating again while the prompt is open keeps ONE prompt; the latest target wins; a double click navigates once', async () => {
    const { router, location } = renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await dirtyEditor(user);

    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    expect(screen.getAllByRole('group', { name: 'Ungespeicherte Schichtzeiten' })).toHaveLength(1);

    const leave = within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' });
    fireEvent.click(leave);
    fireEvent.click(leave);
    await waitFor(() => expect(location()).toBe('/projekte'));
    // Exactly one history entry was added: Back leads straight to the detail page
    // (neither a second /projekte entry nor the abandoned January target).
    await act(async () => { await router.navigate(-1); });
    expect(location()).toBe(PATH);
  });

  it('a save that finishes while the prompt is open turns it into a neutral question; staying keeps the result', async () => {
    const server = fakeCompany();
    const held = holding(server, (request) => request.method === 'PATCH');
    const { location } = renderProjects(PATH, held.handler);
    const user = userEvent.setup();
    await dirtyEditor(user);
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    await screen.findByRole('button', { name: 'Wird gespeichert …' });
    await user.click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
    expect(prompt('Speichern läuft noch')).toBeTruthy();

    held.release();
    expect(await screen.findByRole('group', { name: 'Keine ungespeicherten Schichtzeiten mehr' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hier bleiben' }));
    expect(location()).toBe(PATH);
    expect(screen.getByText('Die Schichtzeiten ab Dezember 2026 wurden gespeichert.')).toBeTruthy();
    expect(server.state.shiftVersions.map((version) => version.month)).toEqual(['2026-12-01']);
  });

  it('under StrictMode (double effects, as on the dev server) "Weiter bearbeiten" still returns focus to the triggering link', async () => {
    renderProjects(PATH, fakeCompany().handler, undefined, { strict: true });
    const user = userEvent.setup();
    await dirtyEditor(user);
    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    await user.click(next);
    await waitFor(() => expect(document.activeElement).toBe(within(prompt()!).getByRole('heading', { name: 'Ungespeicherte Schichtzeiten' })));
    await user.click(within(prompt()!).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(prompt()).toBeNull();
    expect(document.activeElement).toBe(next);
  });

  it('the prompt is keyboard operable: focus starts on its heading and returns to the triggering link', async () => {
    renderProjects(PATH, fakeCompany().handler);
    const user = userEvent.setup();
    await dirtyEditor(user);
    const next = screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' });
    next.focus();
    await user.keyboard('{Enter}');
    const heading = within(prompt()!).getByRole('heading', { name: 'Ungespeicherte Schichtzeiten' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.tab();
    expect(document.activeElement).toBe(within(prompt()!).getByRole('button', { name: 'Änderungen verwerfen und wechseln' }));
    await user.tab();
    await user.keyboard('{Enter}');
    expect(prompt()).toBeNull();
    expect(document.activeElement).toBe(next);
    expect(field('Ende Tagschicht').value).toBe('17:45');
  });
});

describe('SP-08b F-2 — read-only only for months past in every time zone (company zone unknown to the client)', () => {
  // Absolute instants ("Z"): the rule uses UTC only, so the CI runner's time zone does not matter.
  const at = (iso: string) => () => new Date(iso);

  it('browser Berlin already in November, company New York still in October: no false lock, the save succeeds', async () => {
    // 2026-11-01T03:30Z = Berlin 04:30 on 1 Nov, New York 23:30 on 31 Oct.
    const server = fakeCompany({ shiftVersions: [october()], currentMonthStart: '2026-10-01' });
    renderProjects(`${PATH}/2026-10`, server.handler, at('2026-11-01T03:30:00Z'));
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Oktober 2026 ändern');
    await user.clear(field('Ende Tagschicht'));
    await user.type(field('Ende Tagschicht'), '18:30');
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    expect(await screen.findByText('Die Schichtzeiten ab Oktober 2026 wurden gespeichert.')).toBeTruthy();
    expect(server.state.shiftVersions[0].shifts[0].endLocal).toBe('18:30');
  });

  it('browser Berlin still in October, company Tokyo already in November: the attempt is offered, the 400 is explained, input stays', async () => {
    // 2026-10-31T16:00Z = Berlin 17:00 on 31 Oct, Tokyo 01:00 on 1 Nov.
    const server = fakeCompany({ shiftVersions: [october()], currentMonthStart: '2026-11-01' });
    renderProjects(`${PATH}/2026-10`, server.handler, at('2026-10-31T16:00:00Z'));
    const user = userEvent.setup();
    await openEditor(user, 'Schichtzeiten ab Oktober 2026 ändern');
    await user.clear(field('Ende Tagschicht'));
    await user.type(field('Ende Tagschicht'), '18:30');
    await user.click(screen.getByRole('button', { name: 'Schichtzeiten speichern' }));
    expect((await within(region()).findByRole('alert')).textContent).toContain('Schichtzeiten nicht zulässig');
    expect(field('Ende Tagschicht').value).toBe('18:30');
    expect(server.state.shiftVersions).toEqual([october()]);
  });

  it.each([
    // [label, now, month path, editable]
    ['last instant of October at UTC-12', '2026-11-01T11:59:59Z', '2026-10', true],
    ['every zone in November', '2026-11-01T12:00:00Z', '2026-10', false],
    ['year boundary, UTC-12 still in December', '2027-01-01T11:59:59Z', '2026-12', true],
    ['year boundary, every zone in January', '2027-01-01T12:00:00Z', '2026-12', false],
    ['UTC+14 already in November does not lock October', '2026-10-31T10:00:00Z', '2026-10', true],
  ] as const)('month boundary: %s', async (_label, now, month, editable) => {
    const server = fakeCompany({ shiftVersions: [shiftVersion(`${month}-01`, [['DAY', '06:00', '18:00']])] });
    renderProjects(`${PATH}/${month}`, server.handler, at(now));
    expect(await screen.findByRole('table', { name: /^Schichtzeiten ab / })).toBeTruthy();
    if (editable) {
      expect(within(region()).getByRole('button', { name: /^Schichtzeiten ab .* ändern$/ })).toBeTruthy();
    } else {
      expect(within(region()).getByText(/liegt in der Vergangenheit/)).toBeTruthy();
      expect(within(region()).queryByRole('button')).toBeNull();
    }
  });

  it('an INACTIVE project stays read-only at a month boundary too (status rule unchanged)', async () => {
    const server = fakeCompany({ projects: [project({ status: 'INACTIVE' })], shiftVersions: [october()], currentMonthStart: '2026-10-01' });
    renderProjects(`${PATH}/2026-10`, server.handler, at('2026-11-01T03:30:00Z'));
    expect(await within(await screen.findByRole('region', { name: 'Schichtzeiten' })).findByText(/Das Projekt ist inaktiv/)).toBeTruthy();
    expect(within(region()).queryByRole('button')).toBeNull();
  });
});
