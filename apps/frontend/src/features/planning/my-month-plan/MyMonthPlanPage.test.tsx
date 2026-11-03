// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createSessionApi } from '../../auth/session-api';
import { MyMonthPlanPage } from './MyMonthPlanPage';
import { employeeIdentity, personalPlan } from './my-month-plan.test-support';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(path = '/mein-monatsplan/2026-12', result: unknown = personalPlan()) {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify(url === '/api/v1/me' ? employeeIdentity : result), {
        status: 200,
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const revalidate = vi.fn(),
    unauthorized = vi.fn(),
    api = createSessionApi('a'.repeat(43), unauthorized);
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/mein-monatsplan/:month?"
          element={
            <MyMonthPlanPage
              api={api}
              identity={employeeIdentity}
              requestSessionRevalidation={revalidate}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { fetcher, revalidate, unauthorized, view };
}
it('reads real API transport, saved overnight time and zone without preview/workflow content', async () => {
  const { fetcher } = setup();
  await screen.findByText('Projekt: Synthetic Nord');
  expect(screen.getByText('Nachtdienst')).toBeTruthy();
  expect(screen.getByText('Zeitzone: Europe/Berlin')).toBeTruthy();
  expect(screen.getByText(/01.01.2027/)).toBeTruthy();
  expect(screen.queryByText(/Absage beantragt|Vorschau|Beispielzeit/)).toBeNull();
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual([
    '/api/v1/me',
    '/api/v1/me/monthly-plans?monthStart=2026-12-01',
  ]);
});
it('bare route uses authoritative company month once, without redirect loop', async () => {
  const { fetcher } = setup('/mein-monatsplan');
  await screen.findByText('Projekt: Synthetic Nord');
  expect(screen.getByRole('heading', { name: 'Dezember 2026' })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  ['no plan', { items: [] }, 'Kein veröffentlichter Plan'],
  ['empty plan', { items: [{ ...personalPlan().items[0], duties: [] }] }, 'Keine Dienste geplant'],
] as const)('shows %s state', async (_label, body, text) => {
  setup(undefined, body);
  expect(await screen.findByText(text)).toBeTruthy();
  expect(screen.queryByRole('article')).toBeNull();
});
it('rejects malformed data with no partial/empty/fixture fallback', async () => {
  setup(undefined, { items: [personalPlan().items[0], { private: true }] });
  await screen.findByRole('alert');
  expect(screen.queryByRole('article')).toBeNull();
  expect(screen.queryByText('Keine Dienste geplant')).toBeNull();
});
it('refresh clears private data while loading and invokes the central 401 callback', async () => {
  const user = userEvent.setup(),
    { fetcher, unauthorized } = setup();
  await screen.findByText('Projekt: Synthetic Nord');
  fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ code: 'SESSION_EXPIRED' }), { status: 401 }),
  );
  await user.click(screen.getByRole('button', { name: 'Aktualisieren' }));
  await waitFor(() => expect(unauthorized).toHaveBeenCalledOnce());
  expect(screen.queryByRole('article')).toBeNull();
});
it('retains explicit selection and month navigation', async () => {
  const { fetcher } = setup();
  await screen.findByText('Projekt: Synthetic Nord');
  fetcher.mockImplementation(
    async (url: string) =>
      new Response(JSON.stringify(url === '/api/v1/me' ? employeeIdentity : { items: [] }), {
        status: 200,
      }),
  );
  await userEvent.setup().click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
  await screen.findByText('Kein veröffentlichter Plan');
  expect(screen.getByRole('heading', { name: 'Januar 2027' })).toBeTruthy();
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain('monthStart=2027-01-01');
});
it('invalid month makes no API request or browser-local fallback', async () => {
  const { fetcher } = setup('/mein-monatsplan/0000-01');
  await screen.findByRole('alert');
  expect(fetcher).not.toHaveBeenCalled();
});
it('ignores a real pending response after unmount', async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path === '/api/v1/me'
        ? new Response(JSON.stringify(employeeIdentity))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    ),
  );
  const api = createSessionApi('a'.repeat(43), vi.fn());
  const view = render(
    <MemoryRouter initialEntries={['/mein-monatsplan/2026-12']}>
      <Routes>
        <Route
          path="/mein-monatsplan/:month"
          element={
            <MyMonthPlanPage
              api={api}
              identity={employeeIdentity}
              requestSessionRevalidation={vi.fn()}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(release).toBeTypeOf('function'));
  view.unmount();
  await act(async () => release(new Response(JSON.stringify(personalPlan()))));
  expect(screen.queryByRole('article')).toBeNull();
});
