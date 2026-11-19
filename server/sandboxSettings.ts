import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { SandboxCreateSpec } from './sandboxTypes';

const formatting = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;
export const runnerManagedSettingKeys = new Set([
  'editor.quickSuggestions',
  'editor.suggestOnTriggerCharacters',
  'editor.inlineSuggest.enabled',
  'editor.parameterHints.enabled',
  'editor.hover.enabled',
  'files.readonlyInclude',
  'typescript.tsserver.useSyntaxServer',
  'typescript.disableAutomaticTypeAcquisition',
]);
const interviewOverlay = (enabled: boolean) => ({
  'editor.quickSuggestions': !enabled,
  'editor.suggestOnTriggerCharacters': !enabled,
  'editor.inlineSuggest.enabled': !enabled,
  'editor.parameterHints.enabled': !enabled,
  'editor.hover.enabled': !enabled,
});
const readonlyOverlay = { '**/*.test.*': true, '**/test_*.py': true, '**/*.seed.*': true };
const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parsed(text: string, kind: 'settings' | 'keybindings'): Record<string, unknown> | unknown[] {
  const errors: ParseError[] = []; const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || (kind === 'settings' ? !plainObject(value) : !Array.isArray(value))) throw new Error(`Sandbox ${kind} must be valid JSONC ${kind === 'settings' ? 'object' : 'array'}`);
  return value;
}
const atPath = (value: unknown, path: (string | number)[]): unknown => path.reduce<unknown>((current, part) => plainObject(current) || Array.isArray(current) ? current[part as keyof typeof current] : undefined, value);

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const withNewline = (text: string) => text.endsWith('\n') ? text : `${text}\n`;

function mergeJsonc(baseText: string, incoming: Record<string, unknown>): string {
  let text = baseText;
  const merge = (path: (string | number)[], next: unknown): void => {
    const currentRoot = parsed(text, 'settings'); const current = atPath(currentRoot, path);
    if (plainObject(current) && plainObject(next)) {
      for (const key of Object.keys(current)) if (!Object.hasOwn(next, key) && !(path.length === 0 && runnerManagedSettingKeys.has(key))) text = applyEdits(text, modify(text, [...path, key], undefined, { formattingOptions: formatting }));
      for (const [key, value] of Object.entries(next)) if (!(path.length === 0 && runnerManagedSettingKeys.has(key))) merge([...path, key], value);
      return;
    }
    if (!same(current, next)) text = applyEdits(text, modify(text, path, next, { formattingOptions: formatting }));
  };
  merge([], incoming); parsed(text, 'settings'); return withNewline(text);
}

// Applies only what changed between the sandbox's provisioned copy and its current copy, so a sandbox started from an older base never reverts newer tracked entries.
export function settingsDeltaText(trackedText: string, originText: string, sandboxText: string): string {
  const origin = parsed(originText, 'settings') as Record<string, unknown>; const current = parsed(sandboxText, 'settings') as Record<string, unknown>;
  let text = trackedText; parsed(text, 'settings');
  for (const key of new Set([...Object.keys(origin), ...Object.keys(current)])) {
    if (runnerManagedSettingKeys.has(key) || same(origin[key], current[key])) continue;
    const tracked = parsed(text, 'settings') as Record<string, unknown>;
    if (!Object.hasOwn(current, key)) { if (Object.hasOwn(tracked, key)) text = applyEdits(text, modify(text, [key], undefined, { formattingOptions: formatting })); }
    else if (plainObject(tracked[key]) && plainObject(current[key])) text = mergeJsonc(text, { ...tracked, [key]: current[key] });
    else if (!same(tracked[key], current[key])) text = applyEdits(text, modify(text, [key], current[key], { formattingOptions: formatting }));
  }
  parsed(text, 'settings'); return withNewline(text);
}

export function keybindingsDeltaText(trackedText: string, originText: string, sandboxText: string): string {
  const origin = parsed(originText, 'keybindings') as unknown[]; const current = parsed(sandboxText, 'keybindings') as unknown[];
  const unmatched = (from: unknown[], against: unknown[]) => { const pool = against.map((entry) => JSON.stringify(entry)); return from.filter((entry) => { const index = pool.indexOf(JSON.stringify(entry)); if (index < 0) return true; pool.splice(index, 1); return false; }); };
  let text = trackedText; parsed(text, 'keybindings');
  for (const entry of unmatched(origin, current)) {
    const index = (parsed(text, 'keybindings') as unknown[]).findIndex((candidate) => same(candidate, entry));
    if (index >= 0) text = applyEdits(text, modify(text, [index], undefined, { formattingOptions: formatting }));
  }
  for (const entry of unmatched(current, origin)) {
    const tracked = parsed(text, 'keybindings') as unknown[];
    if (!tracked.some((candidate) => same(candidate, entry))) text = applyEdits(text, modify(text, [tracked.length], entry, { formattingOptions: formatting, isArrayInsertion: true }));
  }
  parsed(text, 'keybindings'); return withNewline(text);
}

export function effectiveSettingsText(baseText: string, kind: SandboxCreateSpec['kind'], interviewMode = false): string {
  parsed(baseText, 'settings'); let text = baseText;
  for (const key of runnerManagedSettingKeys) text = applyEdits(text, modify(text, [key], undefined, { formattingOptions: formatting }));
  const overlay = { ...interviewOverlay(interviewMode), 'typescript.tsserver.useSyntaxServer': 'never', 'typescript.disableAutomaticTypeAcquisition': true, ...(kind === 'coding' ? { 'files.readonlyInclude': readonlyOverlay } : {}) };
  for (const [key, value] of Object.entries(overlay)) text = applyEdits(text, modify(text, [key], value, { formattingOptions: formatting }));
  parsed(text, 'settings'); return text.endsWith('\n') ? text : `${text}\n`;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

type SyncedFile = 'settings.json' | 'keybindings.json';
type WatchState = { directory: string; settings: string; keybindings: string; timer?: ReturnType<typeof setInterval>; syncing?: Promise<void>; initializing?: Promise<void>; stopping: boolean; ready: boolean };
const originPath = (directory: string, name: SyncedFile) => join(directory, '.ir-origin', name);
async function writeOrigin(directory: string, name: SyncedFile, text: string): Promise<void> {
  await mkdir(join(directory, '.ir-origin'), { recursive: true }); await atomicWrite(originPath(directory, name), text);
}
export class SandboxSettingsSync {
  private readonly watches = new Map<string, WatchState>();
  constructor(private readonly trackedDirectory: string, private readonly fallbackDirectory = trackedDirectory) {}
  private async base(name: 'settings.json' | 'keybindings.json', kind: 'settings' | 'keybindings'): Promise<string> {
    for (const directory of [this.trackedDirectory, this.fallbackDirectory]) {
      try { const text = await readFile(join(directory, name), 'utf8'); parsed(text, kind); return text; } catch { /* use the image copy when the live checkout is absent or invalid */ }
    }
    throw new Error(`No valid sandbox ${kind} base is available`);
  }
  async prepare(directory: string, kind: SandboxCreateSpec['kind']): Promise<void> {
    const user = join(directory, 'User'); await mkdir(user, { recursive: true });
    const [settings, keybindings] = await Promise.all([this.base('settings.json', 'settings'), this.base('keybindings.json', 'keybindings')]);
    const settingsPath = join(user, 'settings.json'); const keybindingsPath = join(user, 'keybindings.json');
    const effectiveSettings = effectiveSettingsText(settings, kind); const effectiveKeybindings = withNewline(keybindings);
    await Promise.all([atomicWrite(settingsPath, effectiveSettings), atomicWrite(keybindingsPath, effectiveKeybindings), writeOrigin(directory, 'settings.json', effectiveSettings), writeOrigin(directory, 'keybindings.json', effectiveKeybindings)]);
    await Promise.all([chmod(directory, 0o777), chmod(user, 0o777), chmod(settingsPath, 0o666), chmod(keybindingsPath, 0o666)]);
  }
  private async syncFile(state: WatchState, name: SyncedFile, current: string): Promise<void> {
    const kind = name === 'settings.json' ? 'settings' : 'keybindings';
    try {
      const origin = await readFile(originPath(state.directory, name), 'utf8'); const trackedPath = join(this.trackedDirectory, name); const tracked = await readFile(trackedPath, 'utf8');
      const next = kind === 'settings' ? settingsDeltaText(tracked, origin, current) : keybindingsDeltaText(tracked, origin, current);
      if (next !== tracked) await atomicWrite(trackedPath, next);
      await writeOrigin(state.directory, name, current);
    } catch (error) { console.error(`Sandbox ${kind} writeback rejected: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private sync(state: WatchState): Promise<void> {
    if (state.syncing) return state.syncing;
    const task = (async () => {
      let settings: string; let keybindings: string;
      try { [settings, keybindings] = await Promise.all([readFile(join(state.directory, 'User/settings.json'), 'utf8'), readFile(join(state.directory, 'User/keybindings.json'), 'utf8')]); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (state.stopping) return;
        try { await lstat(state.directory); } catch (directoryError) { if ((directoryError as NodeJS.ErrnoException).code === 'ENOENT') return; throw directoryError; }
        throw error;
      }
      if (settings !== state.settings) { state.settings = settings; await this.syncFile(state, 'settings.json', settings); }
      if (keybindings !== state.keybindings) { state.keybindings = keybindings; await this.syncFile(state, 'keybindings.json', keybindings); }
    })();
    state.syncing = task;
    return task.finally(() => { if (state.syncing === task) state.syncing = undefined; });
  }
  // A sandbox without a provisioned origin (created before origins existed) adopts its current copy, so reattaching never replays a stale file over the tracked base.
  async watch(id: string, directory: string): Promise<void> {
    const existing = this.watches.get(id); if (existing) { await existing.initializing; return; }
    const state: WatchState = { directory, settings: '', keybindings: '', stopping: false, ready: false }; this.watches.set(id, state);
    state.initializing = (async () => {
      const names: SyncedFile[] = ['settings.json', 'keybindings.json'];
      const [settings, keybindings] = await Promise.all(names.map((name) => readFile(join(directory, 'User', name), 'utf8')));
      const origins = await Promise.all(names.map(async (name, index) => { try { return await readFile(originPath(directory, name), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const current = index === 0 ? settings : keybindings; await writeOrigin(directory, name, current); return current; } }));
      state.settings = origins[0]; state.keybindings = origins[1]; state.ready = true;
      if (state.stopping) return;
      state.timer = setInterval(() => { if (!state.stopping) void this.sync(state).catch((error: unknown) => console.error('Sandbox settings sync failed', error)); }, 400); state.timer.unref?.();
      await this.sync(state);
    })();
    try { await state.initializing; } catch (error) { if (state.timer) clearInterval(state.timer); if (this.watches.get(id) === state) this.watches.delete(id); if (!state.stopping || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async stop(id: string, removeDirectory = false): Promise<void> {
    const state = this.watches.get(id); if (!state) return; state.stopping = true; if (state.timer) clearInterval(state.timer);
    try { try { await state.initializing; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } if (state.syncing) await state.syncing; if (state.ready) await this.sync(state); }
    finally { if (this.watches.get(id) === state) this.watches.delete(id); }
    if (removeDirectory) await rm(state.directory, { recursive: true, force: true });
  }
  async flush(id: string): Promise<void> { const state = this.watches.get(id); if (state) { await state.initializing; if (!state.stopping) await this.sync(state); } }
  close(): void { for (const state of this.watches.values()) { state.stopping = true; if (state.timer) clearInterval(state.timer); } this.watches.clear(); }
}
