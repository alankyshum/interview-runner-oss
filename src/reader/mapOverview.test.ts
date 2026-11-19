import { expect, it } from 'vitest';
import { overviewNeedsFolding } from './mapOverview';

it('retains authored expansion when first-level branches fit, and compacts only when needed', () => {
  const nodes = [{ x: 0, y: 0, width: 140, height: 24 }, { x: 200, y: -400, width: 150, height: 24 }, { x: 200, y: 400, width: 150, height: 24 }];
  expect(overviewNeedsFolding({ width: 800, height: 900 }, nodes, 0.95, 1)).toBe(false);
  expect(overviewNeedsFolding({ width: 286, height: 478 }, nodes, 0.95, 1)).toBe(true);
  expect(overviewNeedsFolding({ width: 800, height: 900 }, nodes, 0.95, 0.5)).toBe(false);
  expect(overviewNeedsFolding({ width: 0, height: 0 }, nodes, 0.95, 1)).toBe(false);
});
