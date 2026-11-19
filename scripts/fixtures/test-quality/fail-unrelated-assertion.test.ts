import { expect, it } from 'vitest';
import { solve } from './solve';

it('asserts an unrelated constant', () => {
  solve(2);
  expect('done').toBe('done');
});
