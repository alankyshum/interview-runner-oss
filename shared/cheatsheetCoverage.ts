/** Single build-time kill switch: set false and redeploy to disable coverage. */
export const CHEATSHEET_COVERAGE_ENABLED = true;
export const COVERAGE_REGION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
export const COVERAGE_WRITER = /^[a-f0-9]{32}$/;
export const COVERAGE_MAX_REGIONS = 2048;
export const COVERAGE_SIGNALS = ['selection', 'deep', 'map', 'link', 'copy', 'dwellMs'] as const;
export type CoverageSignals = Record<typeof COVERAGE_SIGNALS[number], number>;
export type CoverageRecord = CoverageSignals & { updatedAt: number };
export type CoverageSnapshot = { generation: number; revision: number; regions: Record<string, CoverageRecord> };
export const emptyCoverageSignals = (): CoverageSignals => ({ selection: 0, deep: 0, map: 0, link: 0, copy: 0, dwellMs: 0 });
/** Preserve the unread navigation rule: intentional interactions mark a region read. */
export function coverageScore(value?: CoverageRecord | CoverageSignals): number {
  if (!value) return 0;
  if (value.selection + value.deep + value.map + value.link + value.copy > 0) return 1;
  return Math.min(0.25, value.dwellMs / 120_000);
}

/** Weighted attention with diminishing returns; one interaction outweighs one minute of dwell. */
export function coverageIntensity(value?: CoverageRecord | CoverageSignals): number {
  if (!value) return 0;
  return Math.log1p(2 * (value.selection + value.deep + value.map + value.link + value.copy) + value.dwellMs / 60_000);
}

/** Curved rank among visited regions. Equal attention is neutral, except a sole visit is hottest. */
export function relativeCoverage(values: Array<CoverageRecord | CoverageSignals | undefined>): number[] {
  const intensities = values.map(coverageIntensity);
  const visited = intensities.filter((value) => value > 0);
  const levels = [...new Set(visited)].sort((a, b) => a - b);
  if (levels.length <= 1) return intensities.map((value) => value === 0 ? 0 : visited.length === 1 ? 1 : 0.5);
  const ranks = new Map(levels.map((value, index) => [value, (index / (levels.length - 1)) ** 1.5]));
  // Keep the least-attended visited region distinct from unvisited.
  return intensities.map((value) => value === 0 ? 0 : 0.01 + 0.99 * ranks.get(value)!);
}
