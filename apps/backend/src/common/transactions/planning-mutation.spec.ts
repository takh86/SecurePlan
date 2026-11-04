import { Test } from '@nestjs/testing';
import { PlanningMutationDispatcher } from './planning-mutation.js';

it('refuses composition without the required handler provider', async () => {
  await expect(
    Test.createTestingModule({
      providers: [PlanningMutationDispatcher],
    }).compile(),
  ).rejects.toThrow();
});

it('refuses a broken handler at startup and command dispatch', async () => {
  const dispatcher = new PlanningMutationDispatcher(undefined as never);
  expect(() => dispatcher.onModuleInit()).toThrow(
    'Required planning mutation handler',
  );
  await expect(dispatcher.dispatch({} as never, {} as never)).rejects.toThrow(
    'Required planning mutation handler',
  );
});
