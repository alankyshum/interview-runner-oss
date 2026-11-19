// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('does not load the TypeScript compiler until behavioral validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-validation-'));
  try {
    await mkdir(join(root, 'interview-runner'));
    await writeFile(join(root, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url); const compiler = require.resolve('@typescript/typescript6');
      await import('./server/content/writer.ts');
      if (require.cache[compiler]) throw new Error('writer eagerly loaded TypeScript');
      const { behavioralTestIssues } = await import('./scripts/test-quality.ts');
      if (require.cache[compiler]) throw new Error('validator eagerly loaded TypeScript');
      const issues = await behavioralTestIssues('drills/a/solve.test.ts', 'drills/a/solve.ts', "import {it,expect} from 'vitest'; it('bad',()=>expect(1).toBe(1));");
      if (!require.cache[compiler]) throw new Error('validation did not load TypeScript');
      console.log(JSON.stringify(issues));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: root, INTERVIEW_RUNNER_CONTENT_SOURCE: 'db', VITEST: '1' } });
    expect(JSON.parse(stdout.trim())).toEqual(['does not import the learner source module', 'test "bad" never exercises an export from the learner source module', 'test "bad" contains a literal-only assertion']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
