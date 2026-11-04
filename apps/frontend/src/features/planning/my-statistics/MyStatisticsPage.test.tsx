// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createSessionApi } from '../../auth/session-api';
import { MyStatisticsPage } from './MyStatisticsPage';
import { employeeIdentity } from '../my-month-plan/my-month-plan.test-support';
const statistics = () => ({
  monthStart: '2026-12-01',
  plannedWorkdays: 2,
  dayShiftCount: 1,
  nightShiftCount: 1,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  path = '/meine-statistik/2026-12',
  result: unknown = statistics(),
) {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(url === '/api/v1/me' ? employeeIdentity : result),
        {
          status: 200,
        },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const revalidate = vi.fn(),
    unauthorized = vi.fn(),
    api = createSessionApi('a'.repeat(43), unauthorized);
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/meine-statistik/:month?"
          element={
            <MyStatisticsPage
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
it('shows only the three validated German statistics cards through the real transport', async () => {
  const { fetcher } = setup();
  await screen.findByText('Geplante Arbeitstage');
  expect(screen.getAllByRole('definition').map((el) => el.textContent)).toEqual(
    ['2', '1', '1'],
  );
  expect(screen.getByText('Tagdienste')).toBeTruthy();
  expect(screen.getByText('Nachtdienste')).toBeTruthy();
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual([
    '/api/v1/me',
    '/api/v1/me/planning-statistics?monthStart=2026-12-01',
  ]);
});
it('bare route uses authoritative company month once, without redirect loop', async () => {
  const { fetcher } = setup('/meine-statistik');
  await screen.findByText('Geplante Arbeitstage');
  expect(screen.getByRole('heading', { name: 'Dezember 2026' })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('shows neutral authorized zeros without publication-status disclosure', async () => {
  setup(undefined, {
    monthStart: '2026-12-01',
    plannedWorkdays: 0,
    dayShiftCount: 0,
    nightShiftCount: 0,
  });
  expect(
    await screen.findByText(
      'F\u00fcr diesen Monat liegen keine eigenen ver\u00f6ffentlichten Dienste vor.',
    ),
  ).toBeTruthy();
  expect(screen.getAllByRole('definition').map((el) => el.textContent)).toEqual(
    ['0', '0', '0'],
  );
});
it('rejects malformed data with no partial/empty/fixture fallback', async () => {
  setup(undefined, { ...statistics(), extra: true });
  await screen.findByRole('alert');
  expect(screen.queryByRole('definition')).toBeNull();
  expect(screen.queryByText('Keine eigenen Dienste')).toBeNull();
});
it('refresh clears private data while loading and invokes the central 401 callback', async () => {
  const user = userEvent.setup(),
    { fetcher, unauthorized } = setup();
  await screen.findByText('Geplante Arbeitstage');
  fetcher.mockImplementation(
    async () =>
      new Response(JSON.stringify({ code: 'SESSION_EXPIRED' }), {
        status: 401,
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Aktualisieren' }));
  await waitFor(() => expect(unauthorized).toHaveBeenCalledOnce());
  expect(screen.queryByRole('definition')).toBeNull();
});
it('retains explicit selection and month navigation', async () => {
  const { fetcher } = setup();
  await screen.findByText('Geplante Arbeitstage');
  fetcher.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === '/api/v1/me'
            ? employeeIdentity
            : {
                monthStart: '2027-01-01',
                plannedWorkdays: 0,
                dayShiftCount: 0,
                nightShiftCount: 0,
              },
        ),
        {
          status: 200,
        },
      ),
  );
  await userEvent
    .setup()
    .click(screen.getByRole('link', { name: 'Nächster Monat: Januar 2027' }));
  await screen.findByText('Keine eigenen Dienste');
  expect(screen.getByRole('heading', { name: 'Januar 2027' })).toBeTruthy();
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain('monthStart=2027-01-01');
});
it('invalid month makes no API request or browser-local fallback', async () => {
  const { fetcher } = setup('/meine-statistik/0000-01');
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
    <MemoryRouter initialEntries={['/meine-statistik/2026-12']}>
      <Routes>
        <Route
          path="/meine-statistik/:month"
          element={
            <MyStatisticsPage
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
  await act(async () => release(new Response(JSON.stringify(statistics()))));
  expect(screen.queryByRole('definition')).toBeNull();
});

it('month input navigates and boundary months disable previous/next', async () => {
  const { fetcher } = setup('/meine-statistik/0001-01', {
    monthStart: '0001-01-01',
    plannedWorkdays: 0,
    dayShiftCount: 0,
    nightShiftCount: 0,
  });
  await screen.findByText('Keine eigenen Dienste');
  expect(
    (
      screen.getByRole('button', {
        name: 'Vorheriger Monat',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fetcher.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/v1/me'
            ? employeeIdentity
            : {
                monthStart: '9999-12-01',
                plannedWorkdays: 0,
                dayShiftCount: 0,
                nightShiftCount: 0,
              },
        ),
      ),
  );
  const input = screen.getByLabelText('Monat ausw\u00e4hlen');
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(input, { target: { value: '9999-12' } });
  await screen.findByRole('heading', { name: 'Dezember 9999' });
  expect(
    (
      screen.getByRole('button', {
        name: 'N\u00e4chster Monat',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it('delayed old query cannot restore values after navigation, retry or source replacement', async () => {
  const { fetcher } = setup();
  await screen.findByText('Geplante Arbeitstage');
  let release!: (r: Response) => void;
  fetcher.mockImplementation(async (url) =>
    url === '/api/v1/me'
      ? new Response(JSON.stringify(employeeIdentity))
      : new Promise<Response>((done) => {
          release = done;
        }),
  );
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Aktualisieren' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  const old = release;
  expect(screen.queryByRole('definition')).toBeNull();
  fetcher.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/v1/me'
            ? employeeIdentity
            : {
                monthStart: '2027-01-01',
                plannedWorkdays: 0,
                dayShiftCount: 0,
                nightShiftCount: 0,
              },
        ),
      ),
  );
  await userEvent
    .setup()
    .click(
      screen.getByRole('link', { name: 'N\u00e4chster Monat: Januar 2027' }),
    );
  await screen.findByText('Keine eigenen Dienste');
  await act(async () => old(new Response(JSON.stringify(statistics()))));
  expect(screen.getAllByRole('definition').map((el) => el.textContent)).toEqual(
    ['0', '0', '0'],
  );
});
