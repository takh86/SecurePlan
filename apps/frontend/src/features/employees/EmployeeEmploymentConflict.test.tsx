// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mitarbeitende"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, type EmploymentPeriodConflict } from '../../shared/api/api-error';
import { EMPLOYEE_ID, employee, httpError, type RecordedRequest } from './employees.test-support';
import { renderEmployees } from './employees-render.test-support';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const CODE = 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS';
const PATH = `/mitarbeitende/${EMPLOYEE_ID}`;
const isList = (r: RecordedRequest) => r.path.includes('/future-project-assignments?');
const row = (n = 0) => ({ id: `assignment-${n}`, employeeId: EMPLOYEE_ID, projectId: `project-${n}`,
  monthStart: `${2027 + Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}-01`, version: 1793275200123456 + n,
  projectName: `Synthetic ${n}`, projectStatus: 'ACTIVE' });
const page = (n = 1, total = 1) => ({ items: Array.from({ length: Math.min(25, total - (n - 1) * 25) }, (_, i) => row((n - 1) * 25 + i)), pagination: { page: n, pageSize: 25, totalItems: total, totalPages: Math.ceil(total / 25) } });
const section = () => screen.getByRole('region', { name: 'Zukünftige Projektzuordnungen' });
function conflict(summary?: EmploymentPeriodConflict) { return new ApiError('http', 409, CODE, 'server-safe-reference', [], summary); }

async function edit(user: ReturnType<typeof userEvent.setup>, field: 'start' | 'end' | 'both' | 'mixed') {
  await user.click(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' }));
  if (field === 'start' || field === 'both') fireEvent.change(screen.getByLabelText('Beschäftigungsbeginn (optional)'), { target: { value: '2027-03-01' } });
  if (field !== 'start') fireEvent.change(screen.getByLabelText('Beschäftigungsende (optional)'), { target: { value: '2027-03-31' } });
  if (field === 'mixed') {
    await user.clear(screen.getByLabelText('Vorname')); await user.type(screen.getByLabelText('Vorname'), 'Unsaved');
    await user.clear(screen.getByLabelText('Mitarbeiter-ID')); await user.type(screen.getByLabelText('Mitarbeiter-ID'), 'UNSAVED');
    await user.click(screen.getByRole('radio', { name: 'Nacht' }));
  }
  await user.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
  await screen.findByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' });
}

describe('Case 2 employee form recovery', () => {
  it.each(['start', 'end', 'both', 'mixed'] as const)('F01/04/05 rejected %s preserves form and explicitly refreshes/focuses S-9 page 1', async (field) => {
    const user = userEvent.setup(); const fake = renderEmployees(PATH, (r) => {
      if (isList(r)) return page(); if (r.method === 'PATCH') throw conflict(); return employee();
    });
    await edit(user, field);
    expect(screen.getByRole('alert').textContent).toContain('server-safe-reference');
    expect(screen.queryByText('Änderungen wurden gespeichert.')).toBeNull();
    const form = screen.getByLabelText('Mitarbeiter-ID').closest('form')!;
    const before = Array.from(form.querySelectorAll('input')).map((input) => [input.value, input.checked]);
    await user.click(screen.getByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' }));
    await waitFor(() => expect(document.activeElement).toBe(within(section()).getByRole('heading')));
    await waitFor(() => expect(fake.requests.filter(isList)).toHaveLength(2));
    expect(screen.getByLabelText('Mitarbeiter-ID').closest('form')).toBe(form);
    expect(Array.from(form.querySelectorAll('input')).map((input) => [input.value, input.checked])).toEqual(before);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(1);
  });

  it('F05 refresh starts at page 1 and cancels stale confirmation without remounting the form', async () => {
    const user = userEvent.setup(); const fake = renderEmployees(PATH, (r) => {
      if (isList(r)) return page(r.path.includes('page=2&') ? 2 : 1, 26);
      if (r.method === 'PATCH') throw conflict(); return employee();
    });
    await user.click(await screen.findByRole('button', { name: 'Nächste Seite' }));
    await screen.findByText('Synthetic 25');
    await user.click(within(section()).getByRole('button', { name: /^Entfernen:/ }));
    await edit(user, 'mixed');
    await user.click(screen.getByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' }));
    expect(await screen.findByText('Synthetic 0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Zuordnung entfernen' })).toBeNull();
    expect(fake.requests.filter(isList).at(-1)?.path).toContain('page=1&');
    expect((screen.getByLabelText('Vorname') as HTMLInputElement).value).toBe('Unsaved');
  });

  it('F06 valid truncated conflict hints differ from total future assignments', async () => {
    const user = userEvent.setup(); const refs = Array.from({ length: 25 }, (_, i) => ({ assignmentId: `ref-${i}`, monthStart: row(i).monthStart }));
    renderEmployees(PATH, (r) => { if (isList(r)) return page(1, 30); if (r.method === 'PATCH') throw conflict({ conflictCount: 26, conflictingAssignments: refs }); return employee(); });
    await edit(user, 'end'); expect(screen.getByText('25 von 26 betroffenen Projektzuordnungen (Hinweis):')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Betroffene Zuordnungsmonate' })).getAllByRole('listitem')).toHaveLength(25);
    expect(within(section()).getByText('30 zukünftige Projektzuordnungen')).toBeTruthy();
  });

  it('F07 discovery failure retains form and recovery action, without retrying the PATCH', async () => {
    const user = userEvent.setup(); let reads = 0; const fake = renderEmployees(PATH, (r) => {
      if (isList(r)) { if (++reads > 1) throw httpError(500, 'INTERNAL_ERROR'); return page(); }
      if (r.method === 'PATCH') throw conflict(); return employee();
    });
    await edit(user, 'mixed'); await user.click(screen.getByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' }));
    expect(await within(section()).findByRole('alert')).toBeTruthy(); expect((screen.getByLabelText('Vorname') as HTMLInputElement).value).toBe('Unsaved');
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it('F08..10 explicitly removes one conflict with current version then saves while covered futures remain', async () => {
    const user = userEvent.setup(); let removed = false; const fake = renderEmployees(PATH, (r) => {
      if (isList(r)) return removed ? { ...page(), items: [row(1)] } : page(1, 2);
      if (r.method === 'DELETE') { removed = true; return undefined; }
      if (r.method === 'PATCH') { if (!removed) throw conflict(); return employee({ ...r.body as object }); } return employee();
    });
    await edit(user, 'mixed'); await user.click(screen.getByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' }));
    await user.click((await within(section()).findAllByRole('button', { name: /^Entfernen:/ }))[0]);
    await user.click(screen.getByRole('button', { name: 'Zuordnung entfernen' }));
    await waitFor(() => expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1));
    expect(fake.requests.find((r) => r.method === 'DELETE')?.expectedVersion).toBe(row().version);
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect((screen.getByLabelText('Vorname') as HTMLInputElement).value).toBe('Unsaved');
    await user.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText('Änderungen wurden gespeichert.')).toBeTruthy();
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(2); expect(fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('F11/13 inactive employee can recover; editing clears stale conflict hint', async () => {
    const user = userEvent.setup(); renderEmployees(PATH, (r) => { if (isList(r)) return page(); if (r.method === 'PATCH') throw conflict(); return employee({ status: 'INACTIVE', accountStatus: 'DEACTIVATED' }); });
    await edit(user, 'end'); fireEvent.change(screen.getByLabelText('Beschäftigungsende (optional)'), { target: { value: '2027-04-30' } });
    expect(screen.queryByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('T09/F15 a skewed browser clock cannot suppress a server-classified conflict or its recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2040-12-31T23:30:00Z'));
    const user = userEvent.setup(); renderEmployees(PATH, (r) => {
      if (isList(r)) return page();
      if (r.method === 'PATCH') throw conflict({ conflictCount: 1, conflictingAssignments: [{ assignmentId: 'ref-1', monthStart: '2027-01-01' }] });
      return employee();
    });
    await edit(user, 'end'); expect(screen.getByRole('list', { name: 'Betroffene Zuordnungsmonate' }).textContent).toBe('2027-01-01');
    await user.click(screen.getByRole('button', { name: 'Zukünftige Projektzuordnungen prüfen' }));
    await waitFor(() => expect(document.activeElement).toBe(within(section()).getByRole('heading')));
  });
});
