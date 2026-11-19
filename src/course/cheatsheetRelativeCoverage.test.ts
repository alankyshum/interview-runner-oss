import { describe, expect, it } from 'vitest';
import { coverageIntensity, emptyCoverageSignals, relativeCoverage } from '../../shared/cheatsheetCoverage';

const attention = (selection: number, dwellMs = 0) => ({ ...emptyCoverageSignals(), selection, dwellMs });

describe('relative cheatsheet attention', () => {
  it('uses continuous, diminishing intensity and weights intentional interactions above a minute of dwell', () => {
    expect(coverageIntensity()).toBe(0);
    expect(coverageIntensity(attention(0, 1000))).toBeGreaterThan(0);
    expect(coverageIntensity(attention(1))).toBeGreaterThan(coverageIntensity(attention(0, 60_000)));
    expect(coverageIntensity(attention(20))).toBeGreaterThan(coverageIntensity(attention(10)));
    expect(coverageIntensity(attention(20)) - coverageIntensity(attention(10))).toBeLessThan(coverageIntensity(attention(10)));
  });
  it('handles unvisited, a single visit, equal attention and tied ranks', () => {
    expect(relativeCoverage([undefined, attention(0)])).toEqual([0, 0]);
    expect(relativeCoverage([undefined, attention(1)])).toEqual([0, 1]);
    expect(relativeCoverage([attention(1), attention(1), undefined])).toEqual([0.5, 0.5, 0]);
    const scores = relativeCoverage([attention(1), attention(3), attention(3), attention(10)]);
    expect(scores[0]).toBeGreaterThan(0); expect(scores[1]).toBe(scores[2]);
    expect(scores[1]).toBeGreaterThan(scores[0]); expect(scores[3]).toBe(1);
  });
  it('moves the only hot spot when another region overtakes it', () => {
    const before = relativeCoverage([attention(12), attention(5), attention(1)]);
    const after = relativeCoverage([attention(12), attention(5), attention(30)]);
    expect(before.map((score) => score >= 0.7)).toEqual([true, false, false]);
    expect(after.map((score) => score >= 0.7)).toEqual([false, false, true]);
  });
});
