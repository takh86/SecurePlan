import { expect, test } from 'vitest';

test('SP-03 intentional CI failure', () => {
  expect(true).toBe(false);
});
