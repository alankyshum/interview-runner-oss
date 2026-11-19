import { describe, expect, it } from 'vitest';
import { maxWindowSum } from './max-window-sum';

describe('maxWindowSum', () => {
  it('finds the best window in the middle of the list', () => {
    expect(maxWindowSum([1, 4, 2, 10, 2, 3, 1, 0, 20], 4)).toBe(24);
  });

  it('handles a window as long as the list', () => {
    expect(maxWindowSum([3, -1, 5], 3)).toBe(7);
  });

  it('handles a window of one', () => {
    expect(maxWindowSum([-4, -2, -9], 1)).toBe(-2);
  });

  it('keeps the best earlier window when later numbers are negative', () => {
    expect(maxWindowSum([5, 5, -10, -10, 1], 2)).toBe(10);
  });

  it('returns null when no window fits', () => {
    expect(maxWindowSum([1, 2], 3)).toBeNull();
    expect(maxWindowSum([1, 2], 0)).toBeNull();
    expect(maxWindowSum([], 1)).toBeNull();
  });
});
