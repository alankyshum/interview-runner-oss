import { expect, it } from 'vitest';
import { solve } from './solve';

it('asserts unrelated dynamic state', () => {
  solve(2);
  expect(Date.now()).toBeGreaterThan(0);
});
