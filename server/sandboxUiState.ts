import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { SandboxCreateSpec } from './sandboxTypes';

const intervalMs = 400;
type SandboxUiDrill = Pick<SandboxCreateSpec, 'courseId' | 'drillId'>;
export type SandboxLayoutState = { primarySidebarVisible: boolean; primaryView: 'explorer' | 'scm'; secondarySidebarVisible: boolean; panelVisible: boolean };
export type SandboxEditorState = { path: string; viewColumn: number; active: boolean };
type SandboxUiPayload = { version: 1; layout: SandboxLayoutState; editors: SandboxEditorState[] };
type PreparedUiState = { layout?: SandboxLayoutState; editors?: SandboxEditorState[] };
type WatchState = { directory: string; spec: SandboxUiDrill; workspace: string; timer: ReturnType<typeof setInterval>; syncing: boolean; signature?: string };

function defaultStateDirectory(): string { return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'interview-runner', 'sandbox-ui'); }
function drillState(root: string, spec: SandboxUiDrill): string { return join(root, 'drills', spec.courseId, `${spec.drillId}.json`); }
function safeEditorPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..'); }
function layout(value: unknown): SandboxLayoutState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'panelVisible,primarySidebarVisible,primaryView,secondarySidebarVisible' || typeof raw.primarySidebarVisible !== 'boolean' || !['explorer', 'scm'].includes(String(raw.primaryView)) || typeof raw.secondarySidebarVisible !== 'boolean' || typeof raw.panelVisible !== 'boolean') return undefined;
  return raw as SandboxLayoutState;
}
function editors(value: unknown): SandboxEditorState[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined; const output: SandboxEditorState[] = [];
  for (const item of value) { if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined; const raw = item as Record<string, unknown>; if (Object.keys(raw).sort().join(',') !== 'active,path,viewColumn' || !safeEditorPath(raw.path) || !Number.isSafeInteger(raw.viewColumn) || Number(raw.viewColumn) < 1 || Number(raw.viewColumn) > 9 || typeof raw.active !== 'boolean') return undefined; output.push({ path: raw.path, viewColumn: Number(raw.viewColumn), active: raw.active }); }
  return output;
}
function payload(value: unknown): SandboxUiPayload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const raw = value as Record<string, unknown>; if (Object.keys(raw).sort().join(',') !== 'editors,layout,version' || raw.version !== 1) return undefined;
  const parsedLayout = layout(raw.layout); const parsedEditors = editors(raw.editors); return parsedLayout && parsedEditors ? { version: 1, layout: parsedLayout, editors: parsedEditors } : undefined;
}
async function json(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } }
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8'); try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; } }
async function fileSignature(path: string): Promise<{ value: string; changedAt: number } | undefined> { try { const value = await stat(path); return { value: `${value.size}:${value.mtimeMs}`, changedAt: value.mtimeMs }; } catch { return undefined; } }

export function editableSandboxPaths(spec: SandboxCreateSpec): string[] { const editable = posix.relative(spec.workspacePath, spec.sourcePath); return editable && editable !== '..' && !editable.startsWith('../') ? [editable] : []; }

export class SandboxUiStateSync {
  private readonly watches = new Map<string, WatchState>(); private mutation = Promise.resolve(); private globalCommittedAt = 0; private readonly drillCommittedAt = new Map<string, number>();
  constructor(readonly stateDirectory = process.env.SANDBOX_UI_STATE_DIR ?? defaultStateDirectory()) {}
  async prepare(_directory: string, spec: SandboxUiDrill, workspace: string): Promise<PreparedUiState> {
    const savedLayout = layout(await json(join(this.stateDirectory, 'layout.json'))); const savedDrill = await json(drillState(this.stateDirectory, spec));
    if (!savedDrill || typeof savedDrill !== 'object' || Array.isArray(savedDrill) || (savedDrill as Record<string, unknown>).workspace !== workspace) return { ...(savedLayout ? { layout: savedLayout } : {}) };
    const savedEditors = editors((savedDrill as Record<string, unknown>).editors); return { ...(savedLayout ? { layout: savedLayout } : {}), ...(savedEditors ? { editors: savedEditors } : {}) };
  }
  private enqueue(operation: () => Promise<void>): Promise<void> { const next = this.mutation.then(operation, operation); this.mutation = next.catch(() => {}); return next; }
  private async sync(state: WatchState): Promise<void> {
    if (state.syncing) return; state.syncing = true;
    try {
      await this.enqueue(async () => {
        const path = join(state.directory, 'ui-state.json'); const next = await fileSignature(path); if (!next || next.value === state.signature) return; state.signature = next.value; const parsed = payload(await json(path)); if (!parsed) throw new Error('sandbox UI state is invalid');
        if (next.changedAt >= this.globalCommittedAt) { await atomicJson(join(this.stateDirectory, 'layout.json'), parsed.layout); this.globalCommittedAt = next.changedAt; }
        const key = `${state.spec.courseId}/${state.spec.drillId}`; if (next.changedAt >= (this.drillCommittedAt.get(key) ?? 0)) { await atomicJson(drillState(this.stateDirectory, state.spec), { workspace: state.workspace, editors: parsed.editors }); this.drillCommittedAt.set(key, next.changedAt); }
      });
    } catch (error) { console.error(`Sandbox UI state capture skipped: ${error instanceof Error ? error.message : String(error)}`); } finally { state.syncing = false; }
  }
  async watch(id: string, directory: string, spec: SandboxUiDrill, workspace: string): Promise<void> { if (this.watches.has(id)) return; const state = { directory, spec, workspace, syncing: false } as WatchState; state.timer = setInterval(() => { void this.sync(state); }, intervalMs); state.timer.unref?.(); this.watches.set(id, state); await this.sync(state); }
  private async settledSync(state: WatchState): Promise<void> { while (state.syncing) await new Promise((resolve) => setTimeout(resolve, 10)); await this.sync(state); }
  async flush(id: string): Promise<void> { const state = this.watches.get(id); if (state) await this.settledSync(state); }
  async stop(id: string): Promise<void> { const state = this.watches.get(id); if (!state) return; clearInterval(state.timer); await this.settledSync(state); this.watches.delete(id); }
  close(): void { for (const state of this.watches.values()) clearInterval(state.timer); this.watches.clear(); }
}
