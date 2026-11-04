import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  assertCancellationEligible,
  type CancellationContext,
} from '../planning/cancellation-context.js';
import { cancellationFingerprint } from './cancellation-requests.service.js';
import { CreateCancellationDto } from './cancellation.types.js';
const own = {
  state: 'ACTIVE',
  removed_at: null,
  duty_removed_at: null,
  plan_status: 'PUBLISHED',
  project_status: 'ACTIVE',
  version: '7',
} as CancellationContext;
it('binds canonical assignment and displayed duty version to the cancellation fingerprint', () => {
  const id = randomUUID();
  expect(cancellationFingerprint(id, 7)).toEqual(
    cancellationFingerprint(id.toUpperCase(), 7),
  );
  expect(cancellationFingerprint(id, 8)).not.toEqual(
    cancellationFingerprint(id, 7),
  );
  expect(cancellationFingerprint(randomUUID(), 7)).not.toEqual(
    cancellationFingerprint(id, 7),
  );
});
it.each([
  [{ state: 'REMOVED' }, 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE'],
  [{ removed_at: new Date() }, 'CANCELLATION_ASSIGNMENT_NOT_ACTIVE'],
  [
    { state: 'REMOVED', duty_removed_at: new Date(), version: '9' },
    'CANCELLATION_ASSIGNMENT_NOT_ACTIVE',
  ],
  [{ duty_removed_at: new Date(), version: '9' }, 'CANCELLATION_PLAN_CHANGED'],
  [{ plan_status: 'UNPUBLISHED', version: '9' }, 'CANCELLATION_PLAN_CHANGED'],
  [{ version: '8' }, 'PLAN_CONCURRENT_MODIFICATION'],
] as const)('enforces conflict precedence %j', (change, code) => {
  try {
    assertCancellationEligible({ ...own, ...change }, 7);
    throw new Error('expected conflict');
  } catch (error) {
    expect(error).toHaveProperty('response.code', code);
  }
});
it.each(['0', '-1', '1.5', '9007199254740992', 'broken'])(
  'fails technically for corrupt stored version %s',
  (version) => {
    expect(() => assertCancellationEligible({ ...own, version }, 7)).toThrow(
      'Invalid duty version',
    );
  },
);
it('accepts a current own published assignment even with inactive project (historical visibility)', () => {
  expect(() =>
    assertCancellationEligible({ ...own, project_status: 'INACTIVE' }, 7),
  ).not.toThrow();
});
it.each([
  {},
  { assignmentId: 'broken' },
  { assignmentId: randomUUID(), companyId: randomUUID() },
  { assignmentId: null },
])('rejects invalid/extra command fields %j', async (value) => {
  expect(
    await validate(plainToInstance(CreateCancellationDto, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  ).not.toEqual([]);
});
it('accepts only the exact assignment command', async () => {
  expect(
    await validate(
      plainToInstance(CreateCancellationDto, { assignmentId: randomUUID() }),
      { whitelist: true, forbidNonWhitelisted: true },
    ),
  ).toEqual([]);
});
