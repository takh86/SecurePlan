import { editLeaseTtl, requireEditLeaseHeader } from './duty-edit-leases.js';

const previous = process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS;
afterEach(() => {
  if (previous === undefined) delete process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS;
  else process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS = previous;
});
it('defaults to the approved 120 second lease and supports an explicit positive technical setting', () => {
  delete process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS;
  expect(editLeaseTtl()).toBe(120);
  process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS = '180'; expect(editLeaseTtl()).toBe(180);
});
it.each(['0', '-1', '01', '1.5', '1e2', '2147483648', '', 'NaN'])('refuses unsafe lease TTL configuration %j', (value) => {
  process.env.SECUREPLAN_EDIT_LEASE_TTL_SECONDS = value;
  expect(() => editLeaseTtl()).toThrow('Invalid edit lease TTL configuration');
});
it('missing lease header is the approved structural 400; nonmissing tokens are authenticated after visibility', () => {
  expect(() => requireEditLeaseHeader(undefined)).toThrow(expect.objectContaining({ response: { code: 'EDIT_LEASE_TOKEN_REQUIRED' } }));
  expect(requireEditLeaseHeader('invalid')).toBe('invalid');
});
