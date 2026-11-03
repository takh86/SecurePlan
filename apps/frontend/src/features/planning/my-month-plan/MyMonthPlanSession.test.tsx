// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { LoginScreen, type AuthenticatedSession } from '../../auth/LoginScreen';
import type { SessionSignal } from '../../auth/session-channel';
import { MyMonthPlanPage } from './MyMonthPlanPage';
import { employeeIdentity, personalPlan } from './my-month-plan.test-support';

const json = (value: unknown, token = 'a') => new Response(JSON.stringify(value), { status: 200, headers: { 'X-CSRF-Token': token.repeat(43) } });
function View(session: AuthenticatedSession) {
  return <><button onClick={session.logout}>Abmelden</button>{session.identity.role === 'EMPLOYEE' ? <Routes><Route path="/mein-monatsplan/:month?" element={<MyMonthPlanPage {...session} />} /></Routes> : <p>Administrationskonto</p>}</>;
}
function mount(openChannel?: Parameters<typeof LoginScreen>[0]['openChannel']) {
  return render(<MemoryRouter initialEntries={['/mein-monatsplan/2026-12']}><LoginScreen authenticatedView={View} openChannel={openChannel} /></MemoryRouter>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete document.documentElement.dataset.privateSessionHidden; });
it('R1 current real transport401 unmounts private schedule at the session boundary', async () => {
  let expire = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => expire ? new Response('{}', { status: 401 }) : json(path === '/api/v1/me' ? employeeIdentity : personalPlan())));
  mount(); await screen.findByText('Projekt: Synthetic Nord'); expire = true;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Aktualisieren' }));
  await screen.findByRole('heading', { name: 'Anmelden' }); expect(screen.queryByRole('article')).toBeNull();
});
it.each(['accountId','companyId','role'])('C2 mismatch in %s discards private data and invalidates old capability before trusted revalidation', async key => {
  let mismatch = false, confirm = false, resolve!: (value: Response) => void;
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== '/api/v1/me') return json(personalPlan());
    if (mismatch && !(init?.headers instanceof Headers)) { confirm=true; return new Promise<Response>(done => {resolve=done;}); }
    return json(mismatch ? {...employeeIdentity,[key]:key==='role'?'COMPANY_ADMIN':'99999999-9999-4999-8999-999999999999'} : employeeIdentity);
  });
  vi.stubGlobal('fetch',api); mount(); await screen.findByText('Projekt: Synthetic Nord'); mismatch=true;
  await userEvent.setup().click(screen.getByRole('button',{name:'Aktualisieren'}));
  await waitFor(()=>expect(confirm).toBe(true)); expect(screen.queryByRole('article')).toBeNull();
  const afterMismatch=api.mock.calls.length;
  await act(async()=>resolve(json({...employeeIdentity,role:'COMPANY_ADMIN'},'b')));
  await screen.findByText('Administrationskonto'); expect(screen.queryByRole('article')).toBeNull();
  expect(api.mock.calls.length).toBe(afterMismatch);
});
it.each([200,401])('C2 same-principal new generation ignores old response status %s',async status=>{
  let notify!: (signal: SessionSignal)=>void, held=false, release!: (value:Response)=>void;
  const fetcher=vi.fn(async(path:string)=>{
    if(path==='/api/v1/me')return json(employeeIdentity,held?'b':'a');
    if(held)return new Promise<Response>(done=>{release=done;});
    return json(personalPlan());
  });
  vi.stubGlobal('fetch',fetcher);
  mount(receive=>{notify=receive;return{post:vi.fn(),close:vi.fn()};});
  await screen.findByText('Projekt: Synthetic Nord');held=true;
  await userEvent.setup().click(screen.getByRole('button',{name:'Aktualisieren'}));
  await waitFor(()=>expect(release).toBeTypeOf('function'));
  const old=release;held=false;act(()=>notify('signed-in'));
  await screen.findByText('Projekt: Synthetic Nord');
  await act(async()=>old(status===401?new Response('{}',{status:401}):json({items:[]})));
  expect(screen.getByText('Projekt: Synthetic Nord')).toBeTruthy();expect(screen.queryByRole('heading',{name:'Anmelden'})).toBeNull();
});

it('R7 authenticating in an already hidden document conceals immediately and revalidates on foreground',async()=>{
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  const fetcher=vi.fn(async(path:string)=>json(path==='/api/v1/me'?employeeIdentity:personalPlan()));vi.stubGlobal('fetch',fetcher);
  mount();await waitFor(()=>expect(document.documentElement.dataset.privateSessionHidden).toBe('true'));
  visibility.mockReturnValue('visible');act(()=>document.dispatchEvent(new Event('visibilitychange')));
  await screen.findByText('Projekt: Synthetic Nord');expect(document.documentElement.dataset.privateSessionHidden).toBeUndefined();
});
