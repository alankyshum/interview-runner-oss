// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const interruption = vi.hoisted(() => ({ path: '', attempts: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (path: string) => {
    if (path === interruption.path && interruption.attempts++ === 0) throw Object.assign(new Error('revision temporarily unavailable'), { code: 'ENOENT' });
    return fs.lstat(path);
  } };
});

it('retries a transient missing managed revision during publication', async () => {
  vi.resetModules();
  const { validateSandboxSpec } = await import('./sandboxd');
  const root = await mkdtemp(join(tmpdir(), 'managed-retry-')); const drill = 'drills/course/drill';
  try {
    const material = join(root, 'materialized/course/1', drill); const workspace = join(root, 'workspaces/course/drill');
    await mkdir(material, { recursive: true }); await mkdir(workspace, { recursive: true });
    await writeFile(join(material, 'source.test.ts'), 'test'); await writeFile(join(workspace, 'source.ts'), 'source');
    interruption.path = join(await realpath(root), 'materialized/course/1'); interruption.attempts = 0;
    const spec = { id: '12345678', repoId: 'managed', courseId: 'course', drillId: 'drill', kind: 'coding' as const, workspacePath: drill, sourcePath: `${drill}/source.ts`, testPath: `${drill}/source.test.ts`, contentRevision: 1 };
    await expect(validateSandboxSpec(spec, { managed: { hostRoot: root, containerRoot: '/app/state/interview-runner/managed' } })).resolves.toEqual(spec);
    expect(interruption.attempts).toBeGreaterThanOrEqual(2);
  } finally { interruption.path = ''; await rm(root, { recursive: true, force: true }); }
});
