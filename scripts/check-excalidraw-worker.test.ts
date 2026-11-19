// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('rejects a worker graph that reaches application code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'excalidraw-worker-'));
  try {
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await mkdir(join(root, 'dist/excalidraw-assets'), { recursive: true });
    for (const file of ['subset-worker.chunk.js', 'chunk-EIO257PC.js', 'chunk-ZUYEQ4TG.js', 'chunk-SRAX5OIU.js']) await cp(resolve('node_modules/@excalidraw/excalidraw/dist/prod', file), join(root, 'dist/excalidraw-assets', file));
    await writeFile(join(root, 'dist/assets/app.js'), 'import("/excalidraw-assets/subset-worker.chunk.js")');
    const script = resolve('scripts/check-excalidraw-worker.mjs');
    expect(execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })).toContain('worker graph isolated');
    await writeFile(join(root, 'dist/excalidraw-assets/subset-worker.chunk.js'), 'import "./app.js";');
    await expect(async () => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
