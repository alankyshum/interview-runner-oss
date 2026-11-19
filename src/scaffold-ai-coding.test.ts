// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('ai-coding scaffold', () => {
  it.each([
    ['vitest', 'ts', ['package.json', 'tsconfig.json', 'vitest.config.ts', 'src/pair.ts', 'tests/pair.test.ts']],
    ['pytest', 'py', ['pyproject.toml', 'src/pair.py', 'tests/test_pair.py']],
  ] as const)('creates missing %s workspace and interviewer files without overwriting', async (testRunner, extension, files) => {
    root = await mkdtemp(join(tmpdir(), `ai-scaffold-${testRunner}-`));
    await mkdir(join(root, 'courses'), { recursive: true });
    const drill = { id: 'pair', title: 'Pairing change', contentType: 'ai-coding', kind: 'logic', estMinutes: 30, workspacePath: 'drills/demo/pair/workspace', sourcePath: `drills/demo/pair/workspace/src/pair.${extension}`, testRunner, handoffPath: 'drills/demo/pair/handoff.md', rubricPath: 'drills/demo/pair/rubric.md', instructions: '## Milestone 1\nStart.\n## Milestone 2\nChange.' };
    await writeFile(join(root, 'courses/demo.json'), JSON.stringify({ id: 'demo', title: 'Demo', chapters: [{ id: 'one', title: 'One', drills: [drill] }] }));
    const command = join(process.cwd(), 'node_modules/.bin/tsx');
    await run(command, ['scripts/scaffold-course.ts', 'demo', '--repo', root], { cwd: process.cwd() });
    for (const file of files) await expect(readFile(join(root, 'drills/demo/pair/workspace', file), 'utf8')).resolves.toBeTruthy();
    const handoff = await readFile(join(root, 'drills/demo/pair/handoff.md'), 'utf8');
    expect(handoff).toContain('{{drillTitle}}'); expect(handoff).toContain('{{fileTree}}'); expect(handoff).toContain('AI-produced diff');
    expect(await readFile(join(root, 'drills/demo/pair/rubric.md'), 'utf8')).toContain('**Diff review**');
    await writeFile(join(root, drill.sourcePath), 'do not overwrite\n');
    const second = await run(command, ['scripts/scaffold-course.ts', 'demo', '--repo', root], { cwd: process.cwd() });
    expect(second.stdout).toContain('SKIPPED (exists)');
    expect(await readFile(join(root, drill.sourcePath), 'utf8')).toBe('do not overwrite\n');
  });
});
