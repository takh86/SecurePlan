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

describe('A1 (#90) — operating calendar and one-shift-per-day texts', () => {
  const A1_CODES = ['PROJECT_CALENDAR_MISSING', 'PROJECT_CLOSED_WEEKDAY', 'EMPLOYEE_DAILY_SHIFT_CONFLICT'] as const;
  const OUTCOME = { 'create-duty': 'Es wurde nichts gespeichert.', 'update-duty': 'Es wurde nichts geändert.', 'publish-plan': 'Der Plan wurde nicht veröffentlicht.' } as const;

  it.each(Object.entries(OUTCOME))('%s: every A1 refusal has a German text that states its outcome and names no person, duty or date', (write, outcome) => {
    for (const code of A1_CODES) {
      const text = planningErrorText(http(409, code), write as keyof typeof OUTCOME);
      expect(text, code).toBeDefined();
      expect(text!.title, code).not.toBe('Konflikt');
      expect(text!.description, code).toContain(outcome);
      // Privacy: the server reports the first violated rule only; the text adds no person, duty, date or reason.
      expect(`${text!.title} ${text!.description}`, code).not.toMatch(/Mira|Jonas|\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|krank|urlaub|abwesen|sick|leave/i);
    }
  });

  it('a missing calendar points the admin to the project page section that sets operating days (F-A1-2)', () => {
    for (const write of ['create-duty', 'update-duty', 'publish-plan'] as const) {
      const description = planningErrorText(http(409, 'PROJECT_CALENDAR_MISSING'), write)!.description;
      expect(description, write).toContain('Betriebstage legen Sie unter „Projekte“ im jeweiligen Projekt im Abschnitt „Betriebstage“ für den Monat fest.');
      expect(description, write).not.toContain('gibt es in dieser Ausbaustufe noch nicht');
    }
    expect(planningErrorText(http(409, 'PROJECT_CALENDAR_MISSING'), 'publish-plan')!.description).toContain('auch ein Plan ohne Dienste');
  });

  it('the start date decides for night duties; edits keep removal as the correction path', () => {
    expect(planningErrorText(http(409, 'PROJECT_CLOSED_WEEKDAY'), 'create-duty')!.description).toContain('bei Nachtdiensten also der Starttag');
    expect(planningErrorText(http(409, 'PROJECT_CLOSED_WEEKDAY'), 'update-duty')!.description).toContain('Austragen und Löschen schon');
    expect(planningErrorText(http(409, 'PROJECT_CALENDAR_MISSING'), 'update-duty')!.description).toContain('Austragen und Löschen bleiben möglich');
    expect(planningErrorText(http(409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT'), 'update-duty')!.description).toContain('Austragen bleibt möglich');
    expect(planningErrorText(http(409, 'EMPLOYEE_DAILY_SHIFT_CONFLICT'), 'publish-plan')!.description).toContain('aus einem der beiden Dienste aus');
  });

  it('untrusted (unknown-status) A1 codes keep the shared default text', () => {
    for (const code of A1_CODES) expect(planningErrorText(http(409, null), 'create-duty'), code).toBeUndefined();
    // Removal is not refused by the A1 guards: no removal text exists for them.
    for (const code of A1_CODES) expect(planningErrorText(http(409, code), 'remove-duty'), code).toBeUndefined();
  });
});

describe('SP-13 — First Publish error texts', () => {
  it('every definitive refusal says the plan was not published', () => {
    const codes: [number, KnownErrorCode][] = [
      [409, 'PLAN_CONCURRENT_MODIFICATION'],
      [409, 'PROJECT_INACTIVE'],
      [409, 'SHIFT_CONFIGURATION_MISSING'],
      [404, 'RESOURCE_NOT_FOUND'],
      [409, 'EMPLOYEE_INACTIVE'],
      [409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'],
      [409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH'],
      [409, 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT'],
      [409, 'EMPLOYEE_UNAVAILABLE'],
      [409, 'DUTY_ASSIGNMENT_CONFLICT'],
      [409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST'],
      [400, 'IDEMPOTENCY_KEY_REQUIRED'],
      [400, 'IDEMPOTENCY_KEY_INVALID'],
      [400, 'INVALID_REQUEST_BODY'],
    ];
    for (const [status, code] of codes) {
      const text = planningErrorText(http(status, code), 'publish-plan');
      expect(text, code).toBeDefined();
      expect(text!.description, code).toContain('Der Plan wurde nicht veröffentlicht.');
      // Staffing refusals never name a duty or a person (the server reports neither).
      expect(text!.description, code).not.toMatch(/Mira|Jonas|\d{2}\.\d{2}\.\d{4}/);
    }
  });

  it('already published: no re-publish is offered; CR-03 direct changes are named', () => {
    const text = planningErrorText(http(409, 'MONTHLY_PLAN_ALREADY_PUBLISHED'), 'publish-plan')!;
    expect(text.title).toBe('Bereits veröffentlicht');
    expect(text.description).toContain('Ein erneutes Veröffentlichen gibt es nicht');
    expect(text.description).not.toContain('nicht veröffentlicht');
  });

  it('in progress and lost answers claim neither success nor failure', () => {
    const inProgress = planningErrorText(http(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS'), 'publish-plan')!;
    expect(inProgress.description).toContain('mit demselben Vorgang');
    expect(inProgress.description).not.toContain('nicht veröffentlicht');
    for (const kind of ['network', 'invalid-response'] as const) {
      const text = planningErrorText(new ApiError(kind, null, null, null), 'publish-plan')!;
      expect(text.description).toContain('Ob der Monatsplan veröffentlicht wurde, ist unklar.');
      expect(text.description).toContain('keine doppelte Veröffentlichung');
    }
  });

  it('a 400 without a known code is a client defect; unavailability stays neutral', () => {
    expect(planningErrorText(http(400, null), 'publish-plan')!.title).toBe('Veröffentlichung nicht angenommen');
    const text = planningErrorText(http(409, 'EMPLOYEE_UNAVAILABLE'), 'publish-plan')!;
    expect(`${text.title} ${text.description}`).not.toMatch(/krank|urlaub|abwesen|grund|sick|leave/i);
    // Shared session/permission codes keep the shared default text.
    expect(planningErrorText(http(401, 'SESSION_EXPIRED'), 'publish-plan')).toBeUndefined();
    expect(planningErrorText(http(403, 'ACTION_FORBIDDEN'), 'publish-plan')).toBeUndefined();
  });
});
