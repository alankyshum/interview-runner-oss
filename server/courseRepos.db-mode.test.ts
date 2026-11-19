// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('permits an empty link registry only for database-backed content', async () => {
  const state = await mkdtemp(join(tmpdir(), 'repos-db-'));
  try {
    await mkdir(join(state, 'interview-runner'));
    await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
    const run = promisify(execFile); const executable = resolve('node_modules/.bin/tsx');
    const args = ['-e', "import('./server/courseRepos.ts').then(m => console.log(m.courseRepos.length))"];
    await expect(run(executable, args, { env: { ...process.env, XDG_STATE_HOME: state, INTERVIEW_RUNNER_CONTENT_SOURCE: 'db' } })).resolves.toMatchObject({ stdout: '0\n' });
    const env = { ...process.env, XDG_STATE_HOME: state }; delete env.INTERVIEW_RUNNER_CONTENT_SOURCE;
    await expect(run(executable, ['-e', "import('./server/content/reader.ts').then(m => console.log(m.contentSource()))"], { env })).resolves.toMatchObject({ stdout: 'db\n' });
    await expect(run(executable, args, { env: { ...process.env, XDG_STATE_HOME: state, INTERVIEW_RUNNER_CONTENT_SOURCE: 'files' } })).rejects.toMatchObject({ stderr: expect.stringContaining('no course repositories are linked') });
  } finally { await rm(state, { recursive: true, force: true }); }
});
