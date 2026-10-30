// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/mitarbeitende"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../shared/api/api-error';
import { EmployeeAvailabilitySection } from './EmployeeAvailabilitySection';
import { employee, deferred, EMPLOYEE_ID, type RecordedRequest } from './employees.test-support';
import type { AvailabilityApi, AvailabilityPreview, AvailabilitySelection, PreviewDay } from './availability-api';
import { renderEmployees } from './employees-render.test-support';

afterEach(() => cleanup());
function shown(input: AvailabilitySelection, effects: PreviewDay['effect'][] = ['CREATE', 'CREATE']): AvailabilityPreview {
  return { ...input, ...(input.operation === 'SET' ? { conflictPolicy: input.conflictPolicy ?? 'REJECT' } : {}),
    employeeId: EMPLOYEE_ID, previewToken: 't'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    canCommit: !effects.includes('CONFLICT'), days: effects.map((effect, index) => ({
      day: new Date(Date.parse(`${input.fromDate}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10), effect,
      currentStatus: effect === 'CLEAR' ? 'SICK' : effect === 'CONFLICT' || effect === 'REPLACE' ? 'LEAVE' : null,
    })) } as AvailabilityPreview;
}
function client() {
  return { list: vi.fn<AvailabilityApi['list']>().mockResolvedValue([]),
    preview: vi.fn<AvailabilityApi['preview']>().mockImplementation(async (_id, selection) => shown(selection)),
    commit: vi.fn<AvailabilityApi['commit']>().mockResolvedValue({ employeeId: EMPLOYEE_ID, changedDayCount: 2, unchangedDayCount: 0 }) };
}
async function setup(api = client()) {
  const user = userEvent.setup(); const view = render(<EmployeeAvailabilitySection employee={employee()} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Verfügbarkeit anzeigen' }));
  await screen.findByText('Keine Verfügbarkeitseinträge in diesem Monat.');
  dates(); return { user, api, ...view };
}
function dates(from = '2026-10-28', to = '2026-10-29') {
  fireEvent.change(screen.getByLabelText('Von einschließlich'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('Bis einschließlich'), { target: { value: to } });
}
describe('SP-10 administrator availability interaction', () => {
  it('loads only after disclosure, displays localized markers, and saves an explicitly reviewed range', async () => {
    const { user, api } = await setup();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: 'Krank' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Urlaub (genehmigt)' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    const heading = await screen.findByRole('heading', { name: 'Vorschau: 2026-10-28 bis 2026-10-29' });
    expect(document.activeElement).toBe(heading); expect(api.commit).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('t'.repeat(43));
    await user.click(screen.getByRole('button', { name: 'Einträge speichern' }));
    expect(await screen.findByText(/2 Tage geändert, 0 Tage unverändert/)).toBeTruthy();
    expect(api.commit.mock.calls[0][1]).toMatchObject({ status: 'SICK', conflictPolicy: 'REJECT', previewToken: 't'.repeat(43) });
    expect(api.commit.mock.calls[0][2]).toMatch(/^[a-f0-9-]{36}$/);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
  it('shows conflicts and requires a new replacement preview plus explicit confirmation', async () => {
    const api = client(); api.preview.mockImplementation(async (_id, selection) => shown(selection,
      selection.operation === 'SET' && selection.conflictPolicy === 'REPLACE' ? ['REPLACE', 'CREATE'] : ['CONFLICT', 'CREATE']));
    const { user } = await setup(api);
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    expect(screen.queryByRole('button', { name: 'Einträge speichern' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Vorschau zum Ersetzen erstellen' }));
    const save = screen.getByRole('button', { name: 'Bestätigte Ersetzung speichern' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); expect(api.commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: 'Ich bestätige das Ersetzen der abweichenden Einträge.' }));
    await user.click(save);
    expect(api.commit.mock.calls[0][1]).toMatchObject({ confirmation: 'REPLACE', conflictPolicy: 'REPLACE' });
    expect(api.preview).toHaveBeenCalledTimes(2);
  });
  it('CLEAR has no status field and requires its own confirmation', async () => {
    const api = client(); api.preview.mockImplementation(async (_id, selection) => shown(selection, ['CLEAR', 'UNCHANGED']));
    api.commit.mockResolvedValue({ employeeId: EMPLOYEE_ID, changedDayCount: 1, unchangedDayCount: 1 });
    const { user } = await setup(api);
    await user.click(screen.getByRole('radio', { name: 'Einträge entfernen' }));
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    expect(api.preview.mock.calls[0][1]).toEqual({ operation: 'CLEAR', fromDate: '2026-10-28', toDate: '2026-10-29' });
    expect((screen.getByRole('button', { name: 'Bestätigte Entfernung speichern' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Ich bestätige das Entfernen der angezeigten Einträge.' }));
    await user.click(screen.getByRole('button', { name: 'Bestätigte Entfernung speichern' }));
    expect(api.commit.mock.calls[0][1]).toMatchObject({ operation: 'CLEAR', confirmation: 'CLEAR' });
    expect(api.commit.mock.calls[0][1]).not.toHaveProperty('status');
  });
  it('editing a range invalidates preview and destructive confirmation', async () => {
    const api = client(); api.preview.mockImplementation(async (_id, selection) => shown(selection, ['CLEAR', 'UNCHANGED']));
    const { user } = await setup(api); await user.click(screen.getByRole('radio', { name: 'Einträge entfernen' }));
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await user.click(screen.getByRole('checkbox')); dates('2026-10-27');
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('button', { name: 'Bestätigte Entfernung speichern' })).toBeNull();
    expect(api.commit).not.toHaveBeenCalled();
  });
  it('stale preview retains input, closes confirmation, and requires a fresh preview', async () => {
    const api = client(); api.commit.mockRejectedValue(new ApiError('http', 409, 'AVAILABILITY_PREVIEW_STALE', 'synthetic-reference'));
    const { user } = await setup(api);
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await user.click(screen.getByRole('button', { name: 'Einträge speichern' }));
    expect(await screen.findByRole('heading', { name: 'Vorschau nicht mehr gültig' })).toBeTruthy();
    expect((screen.getByLabelText('Von einschließlich') as HTMLInputElement).value).toBe('2026-10-28');
    expect(screen.queryByRole('button', { name: 'Einträge speichern' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Denselben Vorgang erneut prüfen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' })); expect(api.preview).toHaveBeenCalledTimes(2);
  });
  it('lost response retries the identical body/key and never silently changes intent', async () => {
    const api = client(); api.commit.mockRejectedValueOnce(new ApiError('network', null, null, null));
    const { user } = await setup(api);
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await user.click(screen.getByRole('button', { name: 'Einträge speichern' }));
    const retry = await screen.findByRole('button', { name: 'Denselben Vorgang erneut prüfen' });
    // Disabled by the enclosing fieldset; HTMLInputElement.disabled only checks its own attribute.
    expect(screen.getByLabelText('Von einschließlich').matches(':disabled')).toBe(true);
    await user.click(retry); await screen.findByText(/2 Tage geändert/);
    expect(api.commit.mock.calls[0]).toEqual(api.commit.mock.calls[1]); expect(api.preview).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('a failed post-save refresh does not repeat an already acknowledged commit', async () => {
    const api = client(); const { user } = await setup(api); api.list.mockRejectedValueOnce(new ApiError('network', null, null, null));
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' })); await user.click(screen.getByRole('button', { name: 'Einträge speichern' }));
    await screen.findByText(/2 Tage geändert/); await screen.findByRole('alert');
    expect(api.commit).toHaveBeenCalledTimes(1); expect(screen.queryByRole('button', { name: 'Denselben Vorgang erneut prüfen' })).toBeNull();
  });
  it('rejects 94 days before preview and accepts the inclusive 93-day selection', async () => {
    const { user, api } = await setup(); dates('2026-10-01', '2027-01-02');
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' })); await screen.findByRole('alert'); expect(api.preview).not.toHaveBeenCalled();
    dates('2026-10-01', '2027-01-01'); await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' })); expect(api.preview).toHaveBeenCalledTimes(1);
  });
  it('ignores a preview completed after employment context changes and preserves dates', async () => {
    const api = client(); const pending = deferred<AvailabilityPreview>(); api.preview.mockReturnValueOnce(pending.promise);
    const { user, rerender } = await setup(api);
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    rerender(<EmployeeAvailabilitySection employee={employee({ employmentEnd: '2026-10-27' })} api={api} />);
    pending.resolve(shown({ operation: 'SET', fromDate: '2026-10-28', toDate: '2026-10-29', status: 'SICK' }));
    await screen.findByRole('heading', { name: 'Vorschau nicht mehr gültig' });
    expect(screen.queryByRole('button', { name: 'Einträge speichern' })).toBeNull();
    expect((screen.getByLabelText('Von einschließlich') as HTMLInputElement).value).toBe('2026-10-28');
  });
  it('expires an old preview without retaining confirmation', async () => {
    const api = client(); api.preview.mockImplementation(async (_id, input) => ({ ...shown(input), expiresAt: new Date(Date.now() - 1).toISOString() }));
    const { user } = await setup(api); await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await screen.findByText('Die Vorschau ist abgelaufen. Bitte erneut prüfen.'); expect(screen.queryByRole('button', { name: 'Einträge speichern' })).toBeNull();
  });
  it('never revives an approved CLEAR preview after employment A -> B -> A', async () => {
    const api = client(); api.preview.mockImplementation(async (_id, input) => shown(input, ['CLEAR', 'UNCHANGED']));
    const { user, rerender } = await setup(api);
    await user.click(screen.getByRole('radio', { name: 'Einträge entfernen' }));
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await user.click(screen.getByRole('checkbox'));
    rerender(<EmployeeAvailabilitySection employee={employee({ employmentEnd: '2026-10-27' })} api={api} />);
    rerender(<EmployeeAvailabilitySection employee={employee()} api={api} />);
    expect(screen.queryByRole('button', { name: 'Bestätigte Entfernung speichern' })).toBeNull();
    expect(api.commit).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Von einschließlich') as HTMLInputElement).value).toBe('2026-10-28');
  });
  it('ignores a late preview after a keyed employee switch', async () => {
    const api = client(); const pending = deferred<AvailabilityPreview>(); api.preview.mockReturnValueOnce(pending.promise);
    const { user, rerender } = await setup(api); await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    const nextId = '61588922-4ff5-496f-80e8-176d70ec96c4';
    rerender(<EmployeeAvailabilitySection key={nextId} employee={employee({ id: nextId })} api={api} />);
    pending.resolve(shown({ operation: 'SET', fromDate: '2026-10-28', toDate: '2026-10-29', status: 'SICK' }));
    await user.click(screen.getByRole('button', { name: 'Verfügbarkeit anzeigen' }));
    await screen.findByText('Keine Verfügbarkeitseinträge in diesem Monat.');
    expect(screen.queryByRole('heading', { name: /Vorschau:/ })).toBeNull(); expect(api.commit).not.toHaveBeenCalled();
  });
  it('a double click submits once and a fresh mount never resubmits an uncertain prior operation', async () => {
    const api = client(); const pending = deferred<Awaited<ReturnType<AvailabilityApi['commit']>>>(); api.commit.mockReturnValueOnce(pending.promise);
    const { user, unmount } = await setup(api); await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await user.dblClick(screen.getByRole('button', { name: 'Einträge speichern' })); expect(api.commit).toHaveBeenCalledTimes(1);
    pending.reject(new ApiError('network', null, null, null)); await screen.findByRole('button', { name: 'Denselben Vorgang erneut prüfen' });
    unmount(); render(<EmployeeAvailabilitySection employee={employee()} api={api} />);
    await user.click(screen.getByRole('button', { name: 'Verfügbarkeit anzeigen' }));
    await screen.findByText('Keine Verfügbarkeitseinträge in diesem Monat.');
    expect(api.commit).toHaveBeenCalledTimes(1); expect(screen.queryByRole('button', { name: 'Denselben Vorgang erneut prüfen' })).toBeNull();
  });
  it('cancel restores keyboard focus and removes destructive confirmation', async () => {
    const { user } = await setup(); await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' }));
    await user.click(screen.getByRole('button', { name: 'Vorschau verwerfen' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Verfügbarkeit ausblenden' }));
    expect(screen.queryByRole('heading', { name: /Vorschau:/ })).toBeNull();
  });
  it('production Employee Detail preserves unsaved master data while saving availability', async () => {
    const person = employee({ employmentStart: '2020-01-01' });
    const handler = (req: RecordedRequest) => {
      if (req.path.includes('/future-project-assignments?')) return { items: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } };
      if (req.path.includes('/availability?')) return { items: [] };
      if (req.path.endsWith('/availability/preview')) return shown(req.body as AvailabilitySelection);
      if (req.path.endsWith('/availability/batch')) return { employeeId: EMPLOYEE_ID, changedDayCount: 2, unchangedDayCount: 0 };
      return person;
    };
    const user = userEvent.setup(); const { requests } = renderEmployees(`/mitarbeitende/${EMPLOYEE_ID}`, handler);
    await user.click(await screen.findByRole('button', { name: 'Stammdaten bearbeiten' }));
    const code = screen.getByLabelText('Mitarbeiter-ID') as HTMLInputElement;
    await user.clear(code); await user.type(code, 'UNSAVED');
    await user.click(screen.getByRole('button', { name: 'Verfügbarkeit anzeigen' }));
    await screen.findByText('Keine Verfügbarkeitseinträge in diesem Monat.'); dates();
    await user.click(screen.getByRole('button', { name: 'Vorschau erstellen' })); await user.click(screen.getByRole('button', { name: 'Einträge speichern' }));
    await screen.findByText(/2 Tage geändert/); expect(code.value).toBe('UNSAVED'); expect(requests.some((req) => req.method === 'PATCH')).toBe(false);
    expect(requests.find((req) => req.path.endsWith('/availability/batch'))?.idempotencyKey).toBeTruthy();
  });
});
