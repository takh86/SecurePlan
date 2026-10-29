// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mitarbeitende"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { EmployeeFutureAssignmentsSection } from './EmployeeFutureAssignmentsSection';
import type {
  EmployeeFutureAssignmentsApi,
  FutureAssignmentPage,
  FutureProjectAssignment,
} from './employee-future-assignments-api';
import { EMPLOYEE_ID, deferred, employee, httpError, type RecordedRequest } from './employees.test-support';
import { renderEmployees } from './employees-render.test-support';

afterEach(() => cleanup());
const PATH = `/mitarbeitende/${EMPLOYEE_ID}`;
const isList = (request: RecordedRequest) => request.path.includes('/future-project-assignments?');
const row = (n = 0, overrides: Partial<FutureProjectAssignment> = {}): FutureProjectAssignment => ({
  id: `assignment-${n}`,
  employeeId: EMPLOYEE_ID,
  projectId: `project-${n}`,
  monthStart: `${2027 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`,
  version: 1793275200123456 + n,
  projectName: `Objekt ${n}`,
  projectStatus: 'ACTIVE',
  ...overrides,
});
const page = (items: FutureProjectAssignment[], number = 1, totalItems = items.length): FutureAssignmentPage => ({
  items,
  pagination: { page: number, pageSize: 25, totalItems, totalPages: Math.ceil(totalItems / 25) },
});
const section = () => screen.getByRole('region', { name: 'Zukünftige Projektzuordnungen' });

describe('S-9 operational employee detail', () => {
  it('shows independent loading/empty states without blocking employee master data', async () => {
    const pending = deferred<FutureAssignmentPage>();
    renderEmployees(PATH, (r) => (isList(r) ? pending.promise : employee()));
    expect(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' })).toBeTruthy();
    expect(within(section()).getByText('Zukünftige Projektzuordnungen werden geladen …')).toBeTruthy();
    expect(within(section()).queryByText('Keine zukünftigen Projektzuordnungen vorhanden.')).toBeNull();
    await act(async () => pending.resolve(page([])));
    expect(await within(section()).findByText('Keine zukünftigen Projektzuordnungen vorhanden.')).toBeTruthy();
  });

  it('shows a retryable list error without claiming empty or issuing writes', async () => {
    let reads = 0;
    const fake = renderEmployees(PATH, (r) => {
      if (!isList(r)) return employee();
      if (++reads === 1) throw httpError(500, 'INTERNAL_ERROR');
      return page([row()]);
    });
    await screen.findByRole('heading', { name: 'Zukünftige Projektzuordnungen' });
    expect(await within(section()).findByRole('alert')).toBeTruthy();
    expect(within(section()).queryByText('Keine zukünftigen Projektzuordnungen vorhanden.')).toBeNull();
    await userEvent.setup().click(within(section()).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(section()).findByText('Objekt 0')).toBeTruthy();
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('renders inactive employee/project and masked references with removal actions and no hidden project link', async () => {
    renderEmployees(PATH, (r) =>
      isList(r)
        ? page([row(0, { projectStatus: 'INACTIVE' }), row(1, { projectName: null, projectStatus: null })])
        : employee({ status: 'INACTIVE', accountStatus: 'DEACTIVATED' }),
    );
    expect(await screen.findByText('Projekt nicht verfügbar')).toBeTruthy();
    expect(within(section()).getByText('Inaktiv')).toBeTruthy();
    expect(within(section()).getByText('Referenz: project-1')).toBeTruthy();
    expect(within(section()).queryByRole('link')).toBeNull();
    expect(within(section()).getAllByRole('button', { name: /^Entfernen:/ })).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Deaktivieren' })).toBeNull();
  });

  it('pages, confirms exact version, refreshes page 1 and preserves unsaved master-data edits', async () => {
    const user = userEvent.setup();
    let removed = false;
    const first = Array.from({ length: 25 }, (_, n) => row(n));
    const fake = renderEmployees(PATH, (r) => {
      if (r.method === 'DELETE') {
        removed = true;
        return undefined;
      }
      if (isList(r)) return r.path.includes('page=2&') ? page([row(25)], 2, 26) : page(first, 1, removed ? 25 : 26);
      return employee();
    });
    await user.click(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' }));
    await user.clear(screen.getByLabelText('Vorname'));
    await user.type(screen.getByLabelText('Vorname'), 'Ungespeichert');
    await user.click(await within(section()).findByRole('button', { name: 'Nächste Seite' }));
    expect(await within(section()).findByText('Objekt 25')).toBeTruthy();
    const trigger = within(section()).getByRole('button', { name: /^Entfernen:/ });
    await user.click(trigger);
    const confirmation = within(section()).getByRole('group', { name: /Zuordnung Mira Beispiel/ });
    await waitFor(() => expect(document.activeElement).toBe(within(confirmation).getByRole('heading')));
    await user.click(within(confirmation).getByRole('button', { name: 'Zuordnung entfernen' }));
    expect(await within(section()).findByText('Objekt 0')).toBeTruthy();
    expect(within(section()).getByText('25 zukünftige Projektzuordnungen')).toBeTruthy();
    expect(within(section()).queryByRole('group')).toBeNull();
    expect((screen.getByLabelText('Vorname') as HTMLInputElement).value).toBe('Ungespeichert');
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([
      {
        path: '/api/v1/project-assignments/assignment-25',
        method: 'DELETE',
        body: undefined,
        expectedVersion: row(25).version,
      },
    ]);
    expect(
      fake.requests.filter(isList).map((r) => new URL(r.path, 'https://localhost').searchParams.get('page')),
    ).toEqual(['1', '2', '1']);
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Zuordnung entfernt:'));
  });

  it('supports keyboard confirmation/cancellation and restores trigger focus without DELETE', async () => {
    const user = userEvent.setup();
    const fake = renderEmployees(PATH, (r) => (isList(r) ? page([row()]) : employee()));
    const trigger = await screen.findByRole('button', { name: /^Entfernen:/ });
    trigger.focus();
    await user.keyboard('[Enter]');
    const group = within(section()).getByRole('group');
    await waitFor(() => expect(document.activeElement).toBe(within(group).getByRole('heading')));
    await user.tab();
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Zuordnung entfernen' }));
    await user.tab();
    await user.keyboard('[Enter]');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(within(section()).queryByRole('group')).toBeNull();
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('blocks duplicate pending removal, then announces a verified zero after a fresh read', async () => {
    const pending = deferred<undefined>();
    let removed = false;
    const fake = renderEmployees(PATH, (r) => {
      if (r.method === 'DELETE')
        return pending.promise.then(() => {
          removed = true;
        });
      return isList(r) ? page(removed ? [] : [row()]) : employee();
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Entfernen:/ }));
    await user.click(within(section()).getByRole('button', { name: 'Zuordnung entfernen' }));
    expect((within(section()).getByRole('button', { name: 'Wird entfernt …' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((within(section()).getByRole('button', { name: 'Liste aktualisieren' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    await act(async () => pending.resolve(undefined));
    expect(await within(section()).findByText('Keine zukünftigen Projektzuordnungen vorhanden.')).toBeTruthy();
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it.each([
    [httpError(409, 'PROJECT_ASSIGNMENT_CONFLICT'), 'Zuordnung wurde geändert'],
    [httpError(404, 'RESOURCE_NOT_FOUND'), 'Zuordnung nicht mehr vorhanden'],
    [httpError(409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'), 'Entfernen nicht möglich'],
    [new ApiError('network', null, null, null), 'Ergebnis unbekannt'],
  ])('closes and refreshes after a refusal/unknown outcome without retrying DELETE (%s)', async (failure, title) => {
    let reads = 0;
    const fake = renderEmployees(PATH, (r) => {
      if (r.method === 'DELETE') throw failure;
      if (isList(r)) return page([row(0, { version: row().version + reads++ })]);
      return employee();
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Entfernen:/ }));
    await user.click(within(section()).getByRole('button', { name: 'Zuordnung entfernen' }));
    expect(await within(section()).findByRole('heading', { name: title as string })).toBeTruthy();
    await within(section()).findByRole('button', { name: /^Entfernen:/ });
    expect(within(section()).queryByRole('group')).toBeNull();
    expect(reads).toBe(2);
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('does not mistake an empty beyond-last page for zero future assignments', async () => {
    const first = Array.from({ length: 25 }, (_, n) => row(n));
    renderEmployees(PATH, (r) =>
      isList(r) ? (r.path.includes('page=2&') ? page([], 2, 25) : page(first, 1, 26)) : employee(),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nächste Seite' }));
    expect(await within(section()).findByText(/Auf dieser Seite sind keine Zuordnungen/)).toBeTruthy();
    expect(within(section()).queryByText('Keine zukünftigen Projektzuordnungen vorhanden.')).toBeNull();
    await user.click(within(section()).getByRole('button', { name: 'Zur ersten Seite' }));
    expect(await within(section()).findByText('Objekt 0')).toBeTruthy();
  });

  it('aborts a previous employee read and discards its late answer on employee switch', async () => {
    const pending = deferred<FutureAssignmentPage>();
    let oldSignal: AbortSignal | undefined;
    const api: EmployeeFutureAssignmentsApi = {
      list: vi.fn((id, _page, signal) => {
        if (id === EMPLOYEE_ID) {
          oldSignal = signal;
          return pending.promise;
        }
        return Promise.resolve(page([]));
      }),
      remove: vi.fn(async () => {}),
    };
    const view = render(<EmployeeFutureAssignmentsSection key={EMPLOYEE_ID} employee={employee()} api={api} />);
    view.rerender(<EmployeeFutureAssignmentsSection key="another" employee={employee({ id: 'another' })} api={api} />);
    expect(oldSignal?.aborted).toBe(true);
    expect(await screen.findByText('Keine zukünftigen Projektzuordnungen vorhanden.')).toBeTruthy();
    await act(async () => pending.resolve(page([row()])));
    expect(screen.queryByText('Objekt 0')).toBeNull();
  });
});
