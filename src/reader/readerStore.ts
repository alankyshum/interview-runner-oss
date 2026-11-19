import type { ReaderNodeState } from './outlineProgress';

export type ReaderStore = {
  load(courseId: string, drillId: string): Promise<Record<string, ReaderNodeState> | undefined>;
  set(courseId: string, drillId: string, nodeId: string, patch: ReaderNodeState): Promise<void>;
};
function validState(value: unknown): Record<string, ReaderNodeState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, state]) => state && typeof state === 'object' && !Array.isArray(state)).map(([id, state]) => {
    const candidate = state as Record<string, unknown>;
    return [id, { ...(typeof candidate.folded === 'boolean' ? { folded: candidate.folded } : {}), ...(typeof candidate.checked === 'boolean' ? { checked: candidate.checked } : {}) }];
  }));
}
async function fetchState(courseId: string, drillId: string): Promise<Record<string, ReaderNodeState> | undefined> {
  try { const response = await fetch(`/api/outline-state/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}`); if (!response.ok) return undefined; return validState(await response.json()); } catch { return undefined; }
}
export const serverReaderStore: ReaderStore = {
  load: fetchState,
  async set(courseId, drillId, nodeId, patch) {
    const response = await fetch(`/api/outline-state/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}/${encodeURIComponent(nodeId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!response.ok) throw new Error(`Unable to save reader state (${response.status})`);
  },
};
