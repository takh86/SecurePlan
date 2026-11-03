import { describe, expect, it, vi } from 'vitest';
import { parseMyMonthlyPlans, createMyMonthPlanSource } from './my-month-plan-api';
import { employeeIdentity, personalPlan } from './my-month-plan.test-support';
import { parseBaseIdentity, parseMeIdentity } from '../../auth/auth-api';
import { isCivilDate, isUtcSecond, parsePlanMonth, stepPlanMonth, planDateLabel, planMonthLabel, zonedDutyTime } from '../../../shared/time/civil-time';

function edit(value: unknown, path: (string | number)[], replacement: unknown) {
  let target = value as Record<string, unknown>;
  for (const part of path.slice(0, -1)) target = target[String(part)] as Record<string, unknown>;
  target[String(path.at(-1)!)] = replacement;
}
const duty = ['items', 0, 'duties', 0] as const;
describe('SP14 strict whole-response validation C3/U2-U3', () => {
  it('accepts exact snapshot and both approved empty states', () => {
    expect(parseMyMonthlyPlans(personalPlan(), '2026-12-01')).toEqual(personalPlan());
    expect(parseMyMonthlyPlans({ items: [] }, '2026-12-01')).toEqual({ items: [] });
    const value = personalPlan(); value.items[0].duties = [];
    expect(parseMyMonthlyPlans(value, '2026-12-01')).toEqual(value);
  });
  const mutations: [(string | number)[], unknown][] = [
    [['items'], null], [['items'], {}], [['items', 0], null], [['items', 0, 'project'], []],
    [['items', 0, 'planId'], 'not-an-id'], [['items', 0, 'project', 'id'], 12], [['items', 0, 'project', 'name'], {}],
    [['items', 0, 'monthStart'], '2026-11-01'], [['items', 0, 'monthStart'], '2026-12-02'],
    [[...duty, 'dutyId'], 'x'], [[...duty, 'dutyDate'], '2026-02-30'], [[...duty, 'dutyDate'], '2026-11-30'],
    [[...duty, 'dutyDate'], '0000-01-01'], [[...duty, 'shiftKind'], 'NACHT'], [[...duty, 'dutyRole'], 'SCHICHTLEITER'],
    [[...duty, 'timeZone'], '+01:00'], [[...duty, 'timeZone'], 'Unknown/Zone'], [[...duty, 'timeZone'], ' UTC'],
    [[...duty, 'startsAt'], '2026-02-30T17:00:00Z'], [[...duty, 'startsAt'], '2026-12-31T24:00:00Z'],
    [[...duty, 'startsAt'], '2026-12-31T17:60:00Z'], [[...duty, 'startsAt'], '2026-12-31T17:00:60Z'],
    [[...duty, 'startsAt'], '2026-12-31T17:00:00.000Z'], [[...duty, 'startsAt'], '2026-12-31T17:00:00+00:00'],
    [[...duty, 'endsAt'], '2026-12-31T17:00:00Z'], [[...duty, 'endsAt'], '2026-12-30T17:00:00Z'],
  ];
  it.each(mutations)('rejects invalid path %j and value %j', (path, replacement) => {
    const value = personalPlan(); edit(value, path, replacement);
    expect(() => parseMyMonthlyPlans(value, '2026-12-01')).toThrow();
  });
  for (const path of [[], ['items', 0], ['items', 0, 'project'], [...duty]]) {
    it(`rejects every unknown/missing key at ${JSON.stringify(path)}`, () => {
      const value = personalPlan();
      let target: Record<string, unknown> = value as unknown as Record<string, unknown>;
      for (const part of path) target = target[String(part)] as Record<string, unknown>;
      target.privateField = 'never rendered';
      expect(() => parseMyMonthlyPlans(value, '2026-12-01')).toThrow();
      delete target.privateField;
      for (const key of Object.keys(target)) {
        const saved = target[key]; delete target[key];
        expect(() => parseMyMonthlyPlans(value, '2026-12-01')).toThrow(); target[key] = saved;
      }
    });
  }
  it('rejects duplicate plans, project identities, duties and slots, including case-insensitive IDs', () => {
    for (const change of ['plan', 'project', 'duty', 'slot']) {
      const value = personalPlan(); const plan = value.items[0];
      if (change === 'plan') value.items.push(structuredClone(plan));
      if (change === 'project') value.items.push({ ...structuredClone(plan), planId: '10000000-0000-4000-8000-000000000002', duties: [] });
      if (change === 'duty') plan.duties.push(structuredClone(plan.duties[0]));
      if (change === 'slot') plan.duties.push({ ...plan.duties[0], dutyId: '30000000-0000-4000-8000-000000000002' });
      expect(() => parseMyMonthlyPlans(value, '2026-12-01')).toThrow();
    }
  });
  it('validates all late items and rejects ordering instead of sorting or returning partial data', () => {
    const value = personalPlan(); const other = structuredClone(value.items[0]);
    other.planId = '10000000-0000-4000-8000-000000000002'; other.project.id = '20000000-0000-4000-8000-000000000002'; other.duties = [];
    value.items.push(other); expect(parseMyMonthlyPlans(value, '2026-12-01').items).toHaveLength(2);
    value.items.reverse(); expect(() => parseMyMonthlyPlans(value, '2026-12-01')).toThrow();
    const days = personalPlan(); const first = { ...days.items[0].duties[0], dutyId: '30000000-0000-4000-8000-000000000002', dutyDate: '2026-12-01' };
    days.items[0].duties.push(first); expect(() => parseMyMonthlyPlans(days, '2026-12-01')).toThrow();
    const sparse = new Array(1); expect(() => parseMyMonthlyPlans({ items: sparse }, '2026-12-01')).toThrow();
  });
  it('accepts recognized zones, immutable snapshots and full valid year bounds', () => {
    for (const year of ['0001', '0099', '9999']) {
      const value = personalPlan(), plan = value.items[0]; plan.monthStart = `${year}-12-01`;
      Object.assign(plan.duties[0], { dutyDate: `${year}-12-30`, startsAt: `${year}-12-30T02:00:00Z`, endsAt: `${year}-12-30T03:00:00Z`, timeZone: 'UTC' });
      expect(parseMyMonthlyPlans(value, plan.monthStart)).toEqual(value);
    }
  });
});
describe('SP14 civil time U1/U3/C2', () => {
  it.each(['2026-02-30','1900-02-29','0000-01-01','2026-04-31','10000-01-01'])('rejects invalid date %s', (date) => expect(isCivilDate(date)).toBe(false));
  it.each(['2000-02-29','0001-01-01','0099-12-31','9999-12-31'])('accepts date %s', (date) => expect(isCivilDate(date)).toBe(true));
  it('formats and steps full-year boundaries without Date.UTC 1900 adjustment', () => {
    expect(stepPlanMonth('0001-01', -1)).toBeNull(); expect(stepPlanMonth('9999-12', 1)).toBeNull();
    expect(stepPlanMonth('0099-12', 1)).toBe('0100-01'); expect(parsePlanMonth('0099-01')).toBe('0099-01');
    expect(planDateLabel('0099-01-02')).toContain('02.01.0099'); expect(planMonthLabel('0001-01')).toBe('Januar 0001');
    expect(isUtcSecond('2026-02-30T00:00:00Z')).toBe(false);
  });
  it.each([
    ['2026-03-29T01:30:00Z','Europe/Berlin','03:30'], ['2026-10-25T00:30:00Z','Europe/Berlin','02:30'],
    ['2026-03-08T07:30:00Z','America/New_York','03:30'], ['2026-11-01T05:30:00Z','America/New_York','01:30'],
  ])('renders saved UTC %s in %s', (instant, zone, time) => expect(zonedDutyTime(instant, zone).time).toBe(time));
  it('separates login base parser from required me metadata', () => {
    const { companyTimeZone: _zone, currentCompanyMonth: _month, ...base } = employeeIdentity;
    expect(parseBaseIdentity(base)).toEqual(base); expect(() => parseMeIdentity(base)).toThrow();
    expect(parseMeIdentity(employeeIdentity)).toEqual(employeeIdentity);
    for (const field of ['companyTimeZone', 'currentCompanyMonth']) for (const value of [undefined, null, '+01:00', '2026-02-30']) {
      expect(() => parseMeIdentity({ ...employeeIdentity, [field]: value })).toThrow();
    }
  });
  it.each(['accountId','companyId','role'])('suspends on different %s before loading private data', async (key) => {
    const revalidate = vi.fn(); const api = { request: vi.fn().mockResolvedValue({ ...employeeIdentity, [key]: key === 'role' ? 'COMPANY_ADMIN' : '99999999-9999-4999-8999-999999999999' }) };
    await expect(createMyMonthPlanSource(api, employeeIdentity, revalidate).load('2026-12', new AbortController().signal)).rejects.toThrow();
    expect(revalidate).toHaveBeenCalledOnce(); expect(api.request).toHaveBeenCalledOnce();
  });
});


describe('C3 complete nested semantic regressions',()=>{
  it('rejects null or wrong primitives for every field, and malformed envelopes',()=>{
    for(const envelope of [null,[],{},'payload',{items:null},{items:{}},{items:[null]}])expect(()=>parseMyMonthlyPlans(envelope,'2026-12-01')).toThrow();
    for(const path of [['items',0],['items',0,'project'],['items',0,'duties',0]]){
      const valid=personalPlan();let target=valid as unknown as Record<string,unknown>;
      for(const part of path)target=target[String(part)] as Record<string,unknown>;
      for(const key of Object.keys(target))for(const invalid of [null,false,12]){
        const value=personalPlan();edit(value,[...path,key],invalid);expect(()=>parseMyMonthlyPlans(value,'2026-12-01')).toThrow();
      }
    }
  });
  it('rejects invalid precision, calendar/time and enum/UUID variants for both instants and all identities',()=>{
    for(const field of ['startsAt','endsAt'])for(const timestamp of ['0000-12-31T17:00:00Z','10000-12-31T17:00:00Z','2026-12-31T17:00:00','Infinity','2026-12-31T17:00:00.1Z','1900-02-29T17:00:00Z']){
      const value=personalPlan();edit(value,[...duty,field],timestamp);expect(()=>parseMyMonthlyPlans(value,'2026-12-01')).toThrow();
    }
    for(const path of [['items',0,'planId'],['items',0,'project','id'],[...duty,'dutyId']])for(const id of [' 10000000-0000-4000-8000-000000000001','10000000000040008000000000000001','zzzzzzzz-0000-4000-8000-000000000001']){
      const value=personalPlan();edit(value,path,id);expect(()=>parseMyMonthlyPlans(value,'2026-12-01')).toThrow();
    }
    for(const [field,values] of [['shiftKind',['day','night','CANCELLATION_REQUESTED']],['dutyRole',['employee','shift_lead','ADMIN']]] as const)for(const item of values){const value=personalPlan();edit(value,[...duty,field],item);expect(()=>parseMyMonthlyPlans(value,'2026-12-01')).toThrow();}
  });
  it('rejects NIGHT-before-DAY and cross-plan duplicate duty IDs; accepts UUID case and recognized aliases',()=>{
    const value=personalPlan();const night=value.items[0].duties[0];value.items[0].duties.push({...night,shiftKind:'DAY',dutyId:'30000000-0000-4000-8000-000000000002'});
    expect(()=>parseMyMonthlyPlans(value,'2026-12-01')).toThrow();value.items[0].duties.reverse();expect(parseMyMonthlyPlans(value,'2026-12-01')).toEqual(value);
    const other=structuredClone(value.items[0]);other.planId='10000000-0000-4000-8000-000000000002';other.project.id='20000000-0000-4000-8000-000000000002';value.items.push(other);expect(()=>parseMyMonthlyPlans(value,'2026-12-01')).toThrow();
    const upper=personalPlan();upper.items[0].planId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'.toUpperCase();upper.items[0].duties[0].timeZone='US/Eastern';expect(parseMyMonthlyPlans(upper,'2026-12-01')).toEqual(upper);
  });
});

it('C2 principal mismatch invalidates capability even when enriched metadata is malformed',async()=>{
  const revalidate=vi.fn();const api={request:vi.fn().mockResolvedValue({...employeeIdentity,companyId:'99999999-9999-4999-8999-999999999999',companyTimeZone:null})};
  await expect(createMyMonthPlanSource(api,employeeIdentity,revalidate).load('2026-12',new AbortController().signal)).rejects.toThrow();
  expect(revalidate).toHaveBeenCalledOnce();expect(api.request).toHaveBeenCalledOnce();
});
