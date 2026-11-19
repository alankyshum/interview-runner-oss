import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editableSandboxPaths, SandboxUiStateSync, type SandboxLayoutState } from './sandboxUiState';
import type { SandboxCreateSpec } from './sandboxTypes';

const roots: string[] = []; const workspace = '/workspace/drills/course/one';
const spec = (drillId = 'one', source = `drills/course/${drillId}/answer.py`): SandboxCreateSpec => ({ id: `${drillId}-sandbox`, repoId: 'repo', courseId: 'course', drillId, kind: 'coding', workspacePath: `drills/course/${drillId}`, sourcePath: source, testPath: `drills/course/${drillId}/test_answer.py` });
const scmLayout: SandboxLayoutState = { primarySidebarVisible: true, primaryView: 'scm', secondarySidebarVisible: false, panelVisible: true };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('sandbox UI state persistence', () => {
  it('captures global layout and restores drill editors without sharing them with another drill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-ui-state-')); roots.push(root); const stateRoot = join(root, 'state'); const live = join(root, 'live'); await mkdir(live); const sync = new SandboxUiStateSync(stateRoot); await sync.watch('sandbox-one', live, spec(), workspace);
    await writeFile(join(live, 'ui-state.json'), JSON.stringify({ version: 1, layout: scmLayout, editors: [{ path: 'answer.py', viewColumn: 1, active: true }] })); await sync.flush('sandbox-one'); await sync.stop('sandbox-one');
    expect(await sync.prepare(join(root, 'other'), spec('two'), '/workspace/drills/course/two')).toEqual({ layout: scmLayout }); expect(await sync.prepare(join(root, 'reopened'), spec(), workspace)).toEqual({ layout: scmLayout, editors: [{ path: 'answer.py', viewColumn: 1, active: true }] }); sync.close();
  });
  it('uses defaults when no state has been saved', async () => { const root = await mkdtemp(join(tmpdir(), 'ir-ui-default-')); roots.push(root); const sync = new SandboxUiStateSync(join(root, 'missing')); expect(await sync.prepare(join(root, 'user-data'), spec(), workspace)).toEqual({}); sync.close(); });
  it('falls back to defaults for corrupt saved or captured state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-ui-corrupt-')); roots.push(root); const state = join(root, 'state'); const live = join(root, 'live'); await Promise.all([mkdir(join(state, 'drills/course'), { recursive: true }), mkdir(live)]); await Promise.all([writeFile(join(state, 'layout.json'), '{broken'), writeFile(join(state, 'drills/course/one.json'), JSON.stringify({ workspace, editors: [{ path: '../test.ts', viewColumn: 1, active: true }] }))]);
    const sync = new SandboxUiStateSync(state); expect(await sync.prepare(join(root, 'user-data'), spec(), workspace)).toEqual({}); const error = vi.spyOn(console, 'error').mockImplementation(() => {}); await sync.watch('sandbox-one', live, spec(), workspace); await writeFile(join(live, 'ui-state.json'), '{bad'); await sync.flush('sandbox-one'); expect(error).toHaveBeenCalledWith(expect.stringContaining('capture skipped')); expect(await readFile(join(state, 'layout.json'), 'utf8')).toBe('{broken'); sync.close();
  });
  it('selects only the manifest editable source regardless of extension', () => { expect(editableSandboxPaths(spec('python', 'drills/course/python/solution.py'))).toEqual(['solution.py']); expect(editableSandboxPaths({ ...spec('docs', 'drills/course/docs/README.md'), kind: 'ai-coding', workspacePath: 'drills/course/docs', testPath: undefined })).toEqual(['README.md']); expect(editableSandboxPaths({ ...spec(), sourcePath: 'drills/course/elsewhere.ts' })).toEqual([]); });
});
