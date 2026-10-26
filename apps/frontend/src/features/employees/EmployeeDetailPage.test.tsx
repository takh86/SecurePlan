// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mitarbeitende"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Employee } from './employee-types';
import { EMPLOYEE_ID, employee, httpError, type RecordedRequest } from './employees.test-support';
import { renderEmployees } from './employees-render.test-support';

afterEach(() => cleanup());

const PATH = `/mitarbeitende/${EMPLOYEE_ID}`;

/** Server stand-in: GET returns the record, writes apply the API semantics. */
function server(initial: Employee, overrides: Partial<Record<string, (request: RecordedRequest) => unknown>> = {}) {
  let current = initial;
  return (request: RecordedRequest) => {
    const override = overrides[`${request.method} ${request.path}`];
    if (override) return override(request);
    if (request.method === 'PATCH') {
      current = { ...current, ...(request.body as Partial<Employee>) };
    } else if (request.method === 'POST' && request.path.endsWith('/deactivate')) {
      current = { ...current, status: 'INACTIVE', accountStatus: 'DEACTIVATED' };
    }
    return current;
  };
}

describe('SP-07 — employee detail', () => {
  it('shows master data, German dates and status as text, plus the pending-activation hint', async () => {
    const { requests } = renderEmployees(PATH, server(employee()));
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Beispiel' })).toBeTruthy();
    const facts = screen.getByRole('region', { name: 'Stammdaten' });
    expect(facts.textContent).toContain('Mitarbeiter-IDA-001');
    expect(facts.textContent).toContain('Anmelde-E-Mailmira.beispiel@secureplan.test');
    expect(facts.textContent).toContain('Schicht-EignungTag und Nacht');
    expect(facts.textContent).toContain('BeschäftigungsbeginnSo., 01.11.2026');
    expect(facts.textContent).toContain('BeschäftigungsendeNicht angegeben');
    const status = screen.getByRole('region', { name: 'Status' });
    expect(status.textContent).toContain('Aktiv');
    expect(status.textContent).toContain('Aktivierung ausstehend');
    expect(status.textContent).toContain('erneuter Versand der Einladung ist in dieser Ausbaustufe nicht');
    expect(requests).toEqual([{ path: `/api/v1/employees/${EMPLOYEE_ID}`, method: 'GET', body: undefined }]);
  });

  it('edits with a PATCH of only the changed fields and confirms the save', async () => {
    const user = userEvent.setup();
    const { requests } = renderEmployees(PATH, server(employee()));
    await user.click(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' }));
    // The login e-mail is not editable here.
    expect(screen.queryByLabelText('E-Mail-Adresse')).toBeNull();

    const code = screen.getByLabelText('Mitarbeiter-ID');
    await user.clear(code);
    await user.type(code, 'A-002');
    await user.click(screen.getByRole('radio', { name: 'Nacht' }));
    await user.click(screen.getByRole('button', { name: 'Änderungen speichern' }));

    expect(await screen.findByText('Änderungen wurden gespeichert.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Änderungen wurden gespeichert.'));
    expect(requests.filter((request) => request.method === 'PATCH')).toEqual([{
      path: `/api/v1/employees/${EMPLOYEE_ID}`,
      method: 'PATCH',
      body: { employeeCode: 'A-002', shiftEligibility: 'NIGHT' },
    }]);
    const facts = screen.getByRole('region', { name: 'Stammdaten' });
    expect(facts.textContent).toContain('Mitarbeiter-IDA-002');
    expect(facts.textContent).toContain('Schicht-EignungNacht');
  });

  it('sends nothing when nothing changed or the dates conflict', async () => {
    const user = userEvent.setup();
    const { requests } = renderEmployees(PATH, server(employee()));
    await user.click(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' }));
    await user.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText('Es gab keine Änderungen zu speichern.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Stammdaten bearbeiten' }));
    await user.type(screen.getByLabelText('Beschäftigungsende (optional)'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    expect(screen.getByText('Das Beschäftigungsende darf nicht vor dem Beginn liegen.')).toBeTruthy();
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('opening the edit moves focus into the form; cancelling returns it to the edit button', async () => {
    const user = userEvent.setup();
    renderEmployees(PATH, server(employee()));
    await user.click(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' }));
    // The edit button unmounts; focus must not fall back to <body>.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Mitarbeiter-ID')));
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stammdaten bearbeiten' })));
  });

  it('deactivation needs an explicit confirmation that explains the consequences; cancel sends nothing', async () => {
    const user = userEvent.setup();
    const { requests } = renderEmployees(PATH, server(employee({ accountStatus: 'ACTIVE' })));
    const trigger = await screen.findByRole('button', { name: 'Mitarbeiter:in deaktivieren …' });
    await user.click(trigger);

    const confirm = screen.getByRole('group', { name: 'Mira Beispiel wirklich deaktivieren?' });
    await waitFor(() => expect(document.activeElement).toBe(within(confirm).getByRole('heading', { level: 3 })));
    expect(confirm.textContent).toContain('Alle aktiven Sitzungen der Person werden sofort beendet.');
    expect(confirm.textContent).toContain('Die Stammdaten bleiben für die Historie erhalten.');

    await user.click(within(confirm).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mitarbeiter:in deaktivieren …' })));
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('confirmed deactivation updates the status, removes the action and moves focus to the result', async () => {
    const user = userEvent.setup();
    const { requests } = renderEmployees(PATH, server(employee({ accountStatus: 'ACTIVE' })));
    await user.click(await screen.findByRole('button', { name: 'Mitarbeiter:in deaktivieren …' }));
    await user.click(screen.getByRole('button', { name: 'Jetzt deaktivieren' }));

    const notice = await screen.findByText('Mira Beispiel wurde deaktiviert. Alle aktiven Sitzungen wurden beendet.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    const status = screen.getByRole('region', { name: 'Status' });
    expect(status.textContent).toContain('Deaktiviert');
    expect(status.textContent).toContain('Konto gesperrt');
    expect(screen.queryByRole('button', { name: /deaktivieren/ })).toBeNull();
    expect(requests.filter((request) => request.method === 'POST')).toEqual([
      { path: `/api/v1/employees/${EMPLOYEE_ID}/deactivate`, method: 'POST', body: {} },
    ]);
  });

  it('reloads when someone else already deactivated the record (409 EMPLOYEE_INACTIVE)', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { requests } = renderEmployees(PATH, (request) => {
      if (request.method === 'POST') throw httpError(409, 'EMPLOYEE_INACTIVE');
      reads += 1;
      return reads === 1 ? employee() : employee({ status: 'INACTIVE', accountStatus: 'DEACTIVATED' });
    });
    await user.click(await screen.findByRole('button', { name: 'Mitarbeiter:in deaktivieren …' }));
    await user.click(screen.getByRole('button', { name: 'Jetzt deaktivieren' }));

    await waitFor(() => expect(screen.getByRole('region', { name: 'Status' }).textContent).toContain('Konto gesperrt'));
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(2);
  });

  it('never offers deactivation for an inactive record and explains its state', async () => {
    renderEmployees(PATH, server(employee({ status: 'INACTIVE', accountStatus: 'DEACTIVATED' })));
    expect(await screen.findByText(/Diese Person ist deaktiviert/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Deaktivieren' })).toBeNull();
  });

  it('shows "not found" for an unknown or foreign id without retry', async () => {
    renderEmployees(PATH, () => {
      throw httpError(404, 'RESOURCE_NOT_FOUND');
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nicht gefunden');
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Mitarbeiterdetails');
  });
});
