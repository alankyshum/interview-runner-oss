// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadCourseHints } from './courses';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

it('validates hints against inline ai-coding milestone headings', async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-hints-')); const courses = join(root, 'courses'); await mkdir(courses);
  const drill = { id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 30, workspacePath: 'drills/demo/pair/workspace', sourcePath: 'drills/demo/pair/workspace/src/pair.ts', testRunner: 'vitest', handoffPath: 'drills/demo/pair/handoff.md', rubricPath: 'drills/demo/pair/rubric.md', instructions: '## Milestone 1 — baseline\nStart.\n## Milestone 2 — change\nAdapt.' };
  await writeFile(join(courses, 'demo.json'), JSON.stringify({ id: 'demo', title: 'Demo', chapters: [{ id: 'one', title: 'One', drills: [drill] }] }));
  await writeFile(join(courses, 'demo.hints.json'), JSON.stringify({ courseId: 'demo', drills: { pair: [{ title: 'Milestone 1 — baseline', approach: 'A', solution: 'B' }, { title: 'Milestone 2 — change', approach: 'C', solution: 'D' }] } }));
  await expect(loadCourseHints('demo', courses)).resolves.toMatchObject({ drills: { pair: [{ title: 'Milestone 1 — baseline' }, { title: 'Milestone 2 — change' }] } });
});
