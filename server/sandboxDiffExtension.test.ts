import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sandbox Git diff-to-side extension', () => {
  it('is pinned, offline, and reuses one right-hand diff group', async () => {
    const manifest = JSON.parse(await readFile('sandbox/extensions/ir-diff-to-side/package.json', 'utf8')) as Record<string, any>; const source = await readFile('sandbox/extensions/ir-diff-to-side/extension.js', 'utf8'); const containerfile = await readFile('Containerfile', 'utf8');
    expect(manifest).toMatchObject({ name: 'interview-runner-diff-to-side', version: '1.0.0', activationEvents: ['onStartupFinished'], extensionDependencies: ['vscode.git'], main: './extension.js' });
    expect(source).toContain('IR_SAVED_LAYOUT'); expect(source).toContain('IR_SAVED_EDITORS'); expect(source).toContain('IR_EDITABLE_PATHS'); expect(source).toContain('IR_UI_STATE_PATH'); expect(source).toContain('registerCommand(id'); expect(source).toContain("'interview-runner.viewSourceControl'"); expect(source).toContain('workspace.openTextDocument'); expect(source).toContain("input.original.scheme !== 'git'"); expect(source).toContain('tab.input instanceof vscode.TabInputTextDiff'); expect(source).toContain('tabGroups.onDidChangeTabs'); expect(source).toContain("executeCommand('workbench.action.moveEditorToNextGroup')"); expect(source).toContain('showTextDocument(input.modified'); expect(source).not.toMatch(/https?:|fetch\(|WebSocket/);
    expect(containerfile).toContain('COPY sandbox/extensions/ir-diff-to-side /opt/ir/extensions/interview-runner.interview-runner-diff-to-side-1.0.0'); expect(containerfile).toContain("identifier:{id:'interview-runner.interview-runner-diff-to-side'}");
  });
});
