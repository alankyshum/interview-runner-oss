import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const runWorkspaceFiles = (workspace: string) => new Promise<{ code: number | null; output: string }>((resolveRun) => { const child = spawn(process.execPath, ['sandbox/workspace-files.mjs'], { env: { ...process.env, IR_WORKSPACE: workspace }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.on('close', (code) => resolveRun({ code, output })); });
describe('workspace file limits', () => {
  it('excludes dependencies and detects oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-workspace-files-')); try { await writeFile(join(root, 'ok.ts'), 'export {}'); await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/hidden.js'), 'hidden'); const okay = await runWorkspaceFiles(root); expect(okay.code).toBe(0); expect(okay.output).toContain('ok.ts'); expect(okay.output).not.toContain('hidden.js'); await writeFile(join(root, 'huge.bin'), Buffer.alloc(1024 * 1024 + 1)); const huge = await runWorkspaceFiles(root); expect(huge.code).not.toBe(0); expect(huge.output).toContain('Workspace file limit exceeded'); } finally { await rm(root, { recursive: true, force: true }); }
  });
});
