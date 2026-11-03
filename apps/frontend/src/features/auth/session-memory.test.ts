import { describe, expect, it } from 'vitest';
import { createSessionMemory } from './session-memory';

const identity = { accountId: 'actor-a', companyId: 'company-a', role: 'COMPANY_ADMIN' as const, email: 'a@example.invalid' };

describe('principal-bound session memory', () => {
  it('retains input through suspension only for the same validated principal', () => {
    const boundary = createSessionMemory();
    const first = boundary.activate(identity);
    const draft = { choices: ['private selection'], key: 'frozen-intent' };
    first.write('plan:person', draft);
    boundary.suspend();
    expect(first.read('plan:person')).toBeUndefined();
    first.write('plan:person', 'late response');
    first.remove('plan:person');
    const restored = boundary.activate(identity);
    expect(restored.read('plan:person')).toBe(draft);
    first.write('plan:person', 'obsolete callback');
    expect(restored.read('plan:person')).toBe(draft);
    expect(restored.read('other-plan:person')).toBeUndefined();
  });

  it.each([
    { accountId: 'actor-b' }, { companyId: 'company-b' }, { role: 'EMPLOYEE' as const },
  ])('discards the old draft when the validated principal changes: %j', (change) => {
    const boundary = createSessionMemory();
    const first = boundary.activate(identity);
    first.write('resource', 'private draft');
    boundary.suspend();
    expect(boundary.activate({ ...identity, ...change }).read('resource')).toBeUndefined();
    expect(boundary.activate(identity).read('resource')).toBeUndefined();
  });

  it('clears on deliberate logout and isolates independent login boundaries', () => {
    const boundary = createSessionMemory();
    const scope = boundary.activate(identity);
    scope.write('resource', 'draft');
    expect(createSessionMemory().activate(identity).read('resource')).toBeUndefined();
    boundary.clear();
    scope.write('resource', 'late callback');
    expect(boundary.activate(identity).read('resource')).toBeUndefined();
  });
});
