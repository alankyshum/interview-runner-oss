import { expect, it } from 'vitest';
import { solve } from './solve';

it.skip('checks learner behavior after the learner starts', () => {
  expect(solve(2)).toBe(2);
});
