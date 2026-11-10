/** SP-21 S2: runtime validation of the decision command at the service boundary (no database). */
import { validateDecisionCommand } from './cancellation-decision.service.js';

const id = '11111111-1111-4111-8111-111111111111';
describe('validateDecisionCommand (fail closed)', () => {
  it.each([
    [{ decision: 'REJECT', requestId: id }, { decision: 'REJECT', requestId: id }],
    [{ decision: 'REJECT', requestId: id, replacementOfferId: null }, { decision: 'REJECT', requestId: id }],
    [{ decision: 'APPROVE', requestId: id, expectedNeedVersion: 3, expectedDutyVersion: 7 }, { decision: 'APPROVE', requestId: id, expectedNeedVersion: 3, expectedDutyVersion: 7 }],
    [{ decision: 'APPROVE', requestId: id, expectedNeedVersion: 1, expectedDutyVersion: 1, replacementOfferId: null }, { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1, expectedDutyVersion: 1 }],
  ])('accepts %j', (input, expected) => expect(validateDecisionCommand(input)).toEqual(expected));
  it.each([
    null, undefined, 'REJECT', [], {},
    { decision: 'CANCEL', requestId: id },
    { decision: 'reject', requestId: id },
    { decision: ['REJECT'], requestId: id },
    { requestId: id },
    { decision: 'REJECT' },
    { decision: 'REJECT', requestId: 42 },
    { decision: 'REJECT', requestId: id, replacementOfferId: id },
    { decision: 'REJECT', requestId: id, replacementOfferId: '' },
    { decision: 'REJECT', requestId: id, expectedNeedVersion: 1 },
    { decision: 'REJECT', requestId: id, expectedDutyVersion: 1 },
    { decision: 'REJECT', requestId: id, companyId: id },
    { decision: 'APPROVE', requestId: id },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1 },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: '1', expectedDutyVersion: 1 },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1, expectedDutyVersion: 0 },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1.5, expectedDutyVersion: 1 },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1, expectedDutyVersion: Number.MAX_SAFE_INTEGER + 1 },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1, expectedDutyVersion: 1, replacementOfferId: id },
    { decision: 'APPROVE', requestId: id, expectedNeedVersion: 1, expectedDutyVersion: 1, role: 'COMPANY_ADMIN' },
  ])('refuses %j with VALIDATION_FAILED', (input) => {
    expect(() => validateDecisionCommand(input)).toThrow(expect.objectContaining({ response: { code: 'VALIDATION_FAILED' } }));
  });
});
