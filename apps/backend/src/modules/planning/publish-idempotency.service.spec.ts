import { publishIdempotencySettings } from './publish-idempotency.service.js';

const names = ['SECUREPLAN_PUBLISH_IDEMPOTENCY_RETENTION_SECONDS', 'SECUREPLAN_PUBLISH_IDEMPOTENCY_STALE_SECONDS'] as const;
const original = names.map((name) => process.env[name]);
beforeEach(() => { for (const name of names) delete process.env[name]; });
afterEach(() => { names.forEach((name, i) => { if (original[i] === undefined) delete process.env[name]; else process.env[name] = original[i]; }); });

it('uses the approved 24-hour replay and five-minute stale defaults', () => {
  expect(publishIdempotencySettings()).toEqual({ retention: 86400, stale: 300 });
});
for (const name of names) {
  it.each(['', '0', '-1', '1.5', 'Infinity', '2147483648'])(`${name}=%s fails startup configuration`, (raw) => {
    process.env[name] = raw;
    expect(() => publishIdempotencySettings()).toThrow('Invalid publish idempotency configuration');
  });
}
