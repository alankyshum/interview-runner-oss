// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: async (from: string, to: string) => {
    if (race.enabled && basename(from).startsWith('.workspace-')) {
      race.enabled = false;
      await fs.mkdir(to); await fs.writeFile(join(to, 'learner.ts'), 'concurrent work');
    }
    return fs.rename(from, to);
  } };
});

it('reports a lost workspace publish race without overwriting learner work', async () => {
  const { seedLinkedCodingWorkspace } = await import('./materialize');
  const root = await mkdtemp(join(tmpdir(), 'workspace-race-')); const source = join(root, 'source');
  try {
    await mkdir(source); await writeFile(join(source, 'learner.ts'), 'old work'); race.enabled = true;
    expect(await seedLinkedCodingWorkspace('course', 'drill', source, join(root, 'managed'))).toBe('skipped-raced');
    expect(await readFile(join(root, 'managed/workspaces/course/drill/learner.ts'), 'utf8')).toBe('concurrent work');
  } finally { race.enabled = false; await rm(root, { recursive: true, force: true }); }
});
