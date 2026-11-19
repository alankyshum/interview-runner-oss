// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('generates managed-only sandbox mounts in db mode', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'compose-managed-'));
  try {
    const state = join(temp, 'state'); const repo = join(temp, 'repo'); const output = join(temp, 'output');
    await mkdir(join(state, 'interview-runner'), { recursive: true }); await mkdir(join(repo, 'courses'), { recursive: true }); await mkdir(output);
    await writeFile(join(repo, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 }));
    await mkdir(join(repo, 'drills/course/drill'), { recursive: true });
    await writeFile(join(repo, 'drills/course/drill/source.ts'), 'in-progress learner edits');
    await writeFile(join(repo, 'courses/course.json'), JSON.stringify({ id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'drill', title: 'Drill', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/course/drill/source.ts', testPath: 'drills/course/drill/source.test.ts', instructions: 'Implement it.' }] }] }));
    await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: { 'test/repo': { path: repo, runner: 'interview-runner/interview-runner', schema: 2 } } }));
    await promisify(execFile)(resolve('node_modules/.bin/tsx'), ['scripts/compose-repos.ts', output], { env: { ...process.env, XDG_STATE_HOME: state, INTERVIEW_RUNNER_CONTENT_SOURCE: 'db' } });
    const root = join(state, 'interview-runner/managed'); const compose = await readFile(join(output, 'compose.repos.yaml'), 'utf8');
    expect(compose).toContain(`${root}:/app/state/interview-runner/managed:rw`); expect(compose).toContain(`${root}:${root}:ro`); expect(compose).toContain(`${root}/workspaces:${root}/workspaces:rw`); expect(compose).not.toContain(repo);
    expect(JSON.parse(await readFile(join(output, 'course-repos.sandbox.json'), 'utf8'))).toEqual({ managed: { hostRoot: root, containerRoot: '/app/state/interview-runner/managed' } });
    expect(JSON.parse(await readFile(join(output, 'course-repos.links.json'), 'utf8')).courses).toEqual({});
    expect(await readFile(join(root, 'workspaces/course/drill/source.ts'), 'utf8')).toBe('in-progress learner edits');
    await writeFile(join(repo, 'drills/course/drill/source.ts'), 'later repo edit');
    await promisify(execFile)(resolve('node_modules/.bin/tsx'), ['scripts/compose-repos.ts', output], { env: { ...process.env, XDG_STATE_HOME: state, INTERVIEW_RUNNER_CONTENT_SOURCE: 'db' } });
    expect(await readFile(join(root, 'workspaces/course/drill/source.ts'), 'utf8')).toBe('in-progress learner edits');
    await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
    const env = { ...process.env, XDG_STATE_HOME: state }; delete env.INTERVIEW_RUNNER_CONTENT_SOURCE;
    await promisify(execFile)(resolve('node_modules/.bin/tsx'), ['scripts/compose-repos.ts', output], { env });
    expect(await readFile(join(output, 'compose.repos.yaml'), 'utf8')).not.toContain(repo);
    expect(JSON.parse(await readFile(join(output, 'course-repos.links.json'), 'utf8')).courses).toEqual({});
    const lint = await promisify(execFile)(resolve('node_modules/.bin/tsx'), ['scripts/lint-seeds.ts'], { env });
    expect(lint.stdout).toContain('Seed lint skipped: no linked course repositories.');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
