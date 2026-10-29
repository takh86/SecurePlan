// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mitarbeitende/neu"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deferred, employee, httpError, type RecordedRequest } from './employees.test-support';
import { renderEmployees } from './employees-render.test-support';

afterEach(() => cleanup());

const created = employee({ employeeCode: 'A-100', employmentStart: null, shiftEligibility: 'DAY' });
const server = (answer: unknown) => (request: RecordedRequest) => request.path.includes('/future-project-assignments?')
  ? { items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } }
  : answer;

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Mitarbeiter-ID'), ' A-100 ');
  await user.type(screen.getByLabelText('Vorname'), 'Mira');
  await user.type(screen.getByLabelText('Nachname'), 'Beispiel');
  await user.type(screen.getByLabelText('E-Mail-Adresse'), 'mira.beispiel@secureplan.test');
  await user.click(screen.getByRole('radio', { name: 'Tag' }));
}

function writes(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method !== 'GET');
}

describe('SP-07 — create employee', () => {
  it('validates on the client first: no request, errors linked to their fields, focus on the first one', async () => {
    const user = userEvent.setup();
    const { requests } = renderEmployees('/mitarbeitende/neu', server(created));
    expect(screen.getByRole('heading', { level: 1, name: 'Mitarbeiter:in anlegen' })).toBeTruthy();
    // No password is set by the admin.
    expect(screen.queryByLabelText(/Passwort/)).toBeNull();
    // Employment end is not part of the create contract.
    expect(screen.queryByLabelText(/Beschäftigungsende/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));
    const code = screen.getByLabelText('Mitarbeiter-ID');
    expect(code.getAttribute('aria-invalid')).toBe('true');
    const errorId = code.getAttribute('aria-describedby')?.split(' ').find((id) => id.endsWith('-error'));
    expect(document.getElementById(errorId!)?.textContent).toBe('Bitte eine Mitarbeiter-ID eingeben.');
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(screen.getByText('Bitte eine Schicht-Eignung auswählen.')).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it('sends exactly the contract fields (trimmed) and opens the new record with an honest notice', async () => {
    const user = userEvent.setup();
    const { requests, location } = renderEmployees('/mitarbeitende/neu', server(created));
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Beispiel' })).toBeTruthy();
    expect(location()).toBe(`/mitarbeitende/${created.id}`);
    expect(writes(requests)).toEqual([{
      path: '/api/v1/employees',
      method: 'POST',
      body: {
        employeeCode: 'A-100',
        firstName: 'Mira',
        lastName: 'Beispiel',
        email: 'mira.beispiel@secureplan.test',
        shiftEligibility: 'DAY',
      },
    }]);
    const notice = screen.getByText(/Mitarbeiter:in wurde angelegt/).textContent ?? '';
    expect(notice).toContain('Mitarbeiter:in wurde angelegt');
    // The UI must not claim a successful delivery it cannot know about.
    expect(notice).toContain('kann diese Ansicht nicht bestätigen');
  });

  it('locks the form while the request is pending', async () => {
    const user = userEvent.setup();
    const response = deferred<unknown>();
    renderEmployees('/mitarbeitende/neu', server(response.promise));
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));

    const submit = screen.getByRole('button', { name: 'Wird angelegt …' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.closest('form')?.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByLabelText('Vorname') as HTMLInputElement).disabled).toBe(true);
    response.resolve(created);
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Beispiel' })).toBeTruthy();
  });

  it('shows a duplicate code at the field and moves focus there', async () => {
    const user = userEvent.setup();
    const { location } = renderEmployees('/mitarbeitende/neu', () => {
      throw httpError(409, 'EMPLOYEE_CODE_ALREADY_EXISTS');
    });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));

    expect(await screen.findByText('Diese Mitarbeiter-ID ist in Ihrem Unternehmen bereits vergeben.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Mitarbeiter-ID')));
    expect(location()).toBe('/mitarbeitende/neu');
  });

  it('keeps e-mail conflicts neutral (no hint where the address is registered)', async () => {
    const user = userEvent.setup();
    renderEmployees('/mitarbeitende/neu', () => {
      throw httpError(409, 'EMAIL_ALREADY_IN_USE');
    });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));

    expect(await screen.findByText('Diese E-Mail-Adresse kann nicht verwendet werden.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/anderen Unternehmen|bereits registriert|existiert/i);
  });

  it('maps server validation pointers to fields and shows other failures with a reference id', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    renderEmployees('/mitarbeitende/neu', () => {
      attempt += 1;
      if (attempt === 1) throw httpError(400, 'VALIDATION_FAILED', [{ pointer: '#/lastName', code: 'TOO_LONG' }]);
      throw httpError(500, 'INTERNAL_ERROR', [], 'req-500');
    });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));
    expect(await screen.findByText('Der Wert ist zu lang.')).toBeTruthy();
    expect(screen.getByLabelText('Nachname').getAttribute('aria-invalid')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Mitarbeiter:in anlegen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Referenz-ID: req-500');
  });
});
