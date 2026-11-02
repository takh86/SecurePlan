import { describe, expect, it } from 'vitest';
import { ApiError, type KnownErrorCode } from '../../../shared/api/api-error';
import { outcomeUnknown, planningErrorText } from './planning-errors';

const http = (status: number, code: KnownErrorCode | null) => new ApiError('http', status, code, 'req-11');

describe('SP-11 PR-2 — planning error texts', () => {
  it('has a German text for every duty-creation code; each says that nothing was saved', () => {
    const codes: [number, KnownErrorCode][] = [
      [409, 'DUTY_ALREADY_EXISTS'],
      [409, 'SHIFT_CONFIGURATION_MISSING'],
      [409, 'DUTY_TIME_RANGE_INVALID'],
      [400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH'],
      [400, 'INVALID_DATE'],
      [409, 'PROJECT_INACTIVE'],
      [404, 'RESOURCE_NOT_FOUND'],
      [409, 'EMPLOYEE_INACTIVE'],
      [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
      [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
      [409, 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'],
      [409, 'EMPLOYEE_UNAVAILABLE'],
      [409, 'DUTY_ASSIGNMENT_CONFLICT'],
    ];
    for (const [status, code] of codes) {
      const text = planningErrorText(http(status, code), 'create-duty');
      expect(text, code).toBeDefined();
      expect(text!.description, code).toContain('Es wurde nichts gespeichert.');
    }
  });

  it('keeps unavailability neutral: no reason, no sickness or leave wording', () => {
    const text = planningErrorText(http(409, 'EMPLOYEE_UNAVAILABLE'), 'create-duty')!;
    expect(`${text.title} ${text.description}`).not.toMatch(/krank|urlaub|abwesen|grund|sick|leave/i);
  });

  it('uses the plan context for shared codes', () => {
    expect(planningErrorText(http(409, 'PROJECT_INACTIVE'), 'create-plan')!.description).toContain('kein Monatsplan');
    expect(planningErrorText(http(409, 'MONTHLY_PLAN_ALREADY_EXISTS'), 'create-plan')!.title).toBe('Monatsplan existiert bereits');
    // Not a plan-creation code: the shared default text applies.
    expect(planningErrorText(http(409, 'DUTY_ALREADY_EXISTS'), 'create-plan')).toBeUndefined();
    expect(planningErrorText(http(409, null), 'create-duty')).toBeUndefined();
    expect(planningErrorText(new Error('x'), 'create-duty')).toBeUndefined();
  });

  it('never claims success or failure when the response is lost or unreadable', () => {
    for (const kind of ['network', 'invalid-response'] as const) {
      const error = new ApiError(kind, null, null, null);
      expect(outcomeUnknown(error)).toBe(true);
      expect(planningErrorText(error, 'create-duty')!.description).toContain('ist unklar');
      expect(planningErrorText(error, 'create-plan')!.description).toContain('ist unklar');
    }
    expect(outcomeUnknown(http(409, 'DUTY_ALREADY_EXISTS'))).toBe(false);
    expect(outcomeUnknown(null)).toBe(false);
  });
});

describe('SP-12 — edit and removal error texts', () => {
  it('every refusal of an edit says that nothing was changed (not the creation wording)', () => {
    const codes: [number, KnownErrorCode][] = [
      [409, 'DUTY_ALREADY_EXISTS'],
      [409, 'SHIFT_CONFIGURATION_MISSING'],
      [409, 'DUTY_TIME_RANGE_INVALID'],
      [400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH'],
      [409, 'PROJECT_INACTIVE'],
      [404, 'RESOURCE_NOT_FOUND'],
      [409, 'EMPLOYEE_INACTIVE'],
      [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
      [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
      [409, 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'],
      [409, 'EMPLOYEE_UNAVAILABLE'],
      [409, 'DUTY_ASSIGNMENT_CONFLICT'],
      [409, 'EDIT_LEASE_NOT_HELD'],
      [409, 'PLAN_CONCURRENT_MODIFICATION'],
    ];
    for (const [status, code] of codes) {
      const text = planningErrorText(http(status, code), 'update-duty');
      expect(text, code).toBeDefined();
      expect(text!.description, code).toContain('Es wurde nichts geändert.');
      expect(text!.description, code).not.toContain('Es wurde nichts gespeichert.');
    }
  });

  it('an inactive project still allows removal; edit texts say so', () => {
    expect(planningErrorText(http(409, 'PROJECT_INACTIVE'), 'update-duty')!.description).toContain('Löschen bleibt möglich');
  });

  it('removal texts: lease, version and not-found; nothing removed is stated where it is known', () => {
    expect(planningErrorText(http(409, 'EDIT_LEASE_NOT_HELD'), 'remove-duty')!.description).toContain('Es wurde nichts gelöscht.');
    expect(planningErrorText(http(409, 'PLAN_CONCURRENT_MODIFICATION'), 'remove-duty')!.description).toContain('Es wurde nichts gelöscht.');
    expect(planningErrorText(http(404, 'RESOURCE_NOT_FOUND'), 'remove-duty')!.title).toBe('Dienst nicht mehr vorhanden');
  });

  it('a 400 without a known code (missing Expected-Version or lease header) is a client defect, not the input', () => {
    expect(planningErrorText(http(400, null), 'update-duty')!.title).toBe('Änderung nicht angenommen');
    expect(planningErrorText(http(400, null), 'remove-duty')!.description).toContain('Es wurde nichts gelöscht.');
    expect(planningErrorText(http(400, null), 'create-duty')).toBeUndefined();
  });

  it('lost responses of edits and removals claim neither success nor failure', () => {
    const error = new ApiError('network', null, null, null);
    expect(planningErrorText(error, 'update-duty')!.description).toContain('Ob die Änderungen gespeichert wurden, ist unklar.');
    expect(planningErrorText(error, 'remove-duty')!.description).toContain('Ob der Dienst gelöscht wurde, ist unklar.');
  });

  it('keeps unavailability neutral in edits too', () => {
    const text = planningErrorText(http(409, 'EMPLOYEE_UNAVAILABLE'), 'update-duty')!;
    expect(`${text.title} ${text.description}`).not.toMatch(/krank|urlaub|abwesen|grund|sick|leave/i);
  });
});
