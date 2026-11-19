import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile); const runner = process.cwd(); let temp = '';
async function repo(name: string, courseId?: string) {
  const root = join(temp, name); await mkdir(join(root, 'courses'), { recursive: true }); await mkdir(join(root, 'drills'), { recursive: true });
  await writeFile(join(root, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 }));
  if (courseId) await writeFile(join(root, 'courses', `${courseId}.json`), JSON.stringify({ id: courseId, title: courseId, chapters: [] }));
  return root;
}
async function state(courses: Record<string, string>, runnerPath = runner) {
  const home = join(temp, 'state'); await mkdir(join(home, 'interview-runner'), { recursive: true });
  await writeFile(join(home, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: runnerPath, supportedCourseSchema: 2 } }, courses: Object.fromEntries(Object.entries(courses).map(([id, path]) => [id, { path, runner: 'interview-runner/interview-runner', schema: 2 }])) })); return home;
}
async function command(code: string, home: string) { return run(resolve(runner, 'node_modules/.bin/tsx'), ['-e', code], { cwd: runner, env: { ...process.env, XDG_STATE_HOME: home } }); }
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = ''; });

describe('linked course repositories', () => {
  it('accepts schema 1 and 2 links and markers during the schema 2 migration but rejects other versions', async () => {
    temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const home = await state({ 'example/a': a });
    const path = join(home, 'interview-runner/links.json'); const links = JSON.parse(await readFile(path, 'utf8'));
    for (const runnerSchema of [1, 2]) for (const linkSchema of [1, 2]) for (const markerSchema of [1, 2]) {
      links.runners['interview-runner/interview-runner'].supportedCourseSchema = runnerSchema; links.courses['example/a'].schema = linkSchema;
      await writeFile(path, JSON.stringify(links)); await writeFile(join(a, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: markerSchema }));
      await expect(command("import('./server/courseRepos.ts')", home)).resolves.toBeDefined();
    }
    links.courses['example/a'].schema = 3; await writeFile(path, JSON.stringify(links));
    await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('invalid link') });
    links.courses['example/a'].schema = 2; links.runners['interview-runner/interview-runner'].supportedCourseSchema = 3; await writeFile(path, JSON.stringify(links));
    await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('does not describe this runner and schema') });
    links.runners['interview-runner/interview-runner'].supportedCourseSchema = 2; await writeFile(path, JSON.stringify(links)); await writeFile(join(a, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 3 }));
    await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('marker mismatch') });
  });
  it('accepts a symlink to the same runner but rejects another runner path', async () => {
    temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const alias = join(temp, 'runner-alias'); await symlink(runner, alias, 'dir');
    const home = await state({ 'example/a': a }, alias); await expect(command("import('./server/courseRepos.ts')", home)).resolves.toBeDefined();
    await state({ 'example/a': a }, a); await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('does not describe this runner and schema') });
  });
  it('requires --repo when behavioral validation uses --staged', async () => { temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const home = await state({ 'example/a': a }); await expect(run(resolve(runner, 'node_modules/.bin/tsx'), ['scripts/validate-course-tests-entry.ts', '--staged'], { cwd: runner, env: { ...process.env, XDG_STATE_HOME: home } })).rejects.toMatchObject({ stderr: expect.stringContaining('--staged requires --repo <path>') }); });
  it('names both repositories when duplicate course ids are refused', async () => { temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a', 'duplicate'); const b = await repo('b', 'duplicate'); const home = await state({ 'example/a': a, 'example/b': b }); await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('duplicate course id "duplicate" in example/a and example/b') }); });
  it('rejects duplicate cheatsheet ids across repositories, including course collisions', async () => { temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const b = await repo('b'); const home = await state({ 'example/a': a, 'example/b': b }); const sheet = JSON.stringify({ type: 'cheatsheet', id: 'duplicate', title: 'Sheet' }); await writeFile(join(a, 'courses/duplicate.json'), sheet); await writeFile(join(b, 'courses/duplicate.json'), sheet); await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('duplicate course id "duplicate" in example/a and example/b') }); await writeFile(join(b, 'courses/duplicate.json'), JSON.stringify({ id: 'duplicate', title: 'Course', chapters: [] })); await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('duplicate course id "duplicate" in example/a and example/b') }); });
  it('discovers a course added after the server module loads', async () => { temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const home = await state({ 'example/a': a }); const course = join(a, 'courses', 'new-course.json'); const { stdout } = await command(`void (async () => { const repos = await import('./server/courseRepos.ts'); await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(course)}, JSON.stringify({ id: 'new-course', title: 'New', chapters: [] }))); console.log(repos.requireRepoForCourse('new-course').id) })()`, home); expect(stdout.trim()).toBe('example/a'); });
  it('refuses a mismatched course marker', async () => { temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); await writeFile(join(a, 'interview-courses.json'), JSON.stringify({ kind: 'wrong', runner: 'interview-runner/interview-runner', schema: 1 })); const home = await state({ 'example/a': a }); await expect(command("import('./server/courseRepos.ts')", home)).rejects.toMatchObject({ stderr: expect.stringContaining('marker mismatch for example/a') }); });
  it('generates read-only roots, writable drills, and container link state in the requested directory', async () => { temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const b = await repo('b'); const home = await state({ 'example/a': a, 'example/b': b }); const output = join(temp, 'output'); await mkdir(output); await run(resolve(runner, 'node_modules/.bin/tsx'), ['scripts/compose-repos.ts', output], { cwd: runner, env: { ...process.env, XDG_STATE_HOME: home } }); const compose = await readFile(join(output, 'compose.repos.yaml'), 'utf8'); const links = JSON.parse(await readFile(join(output, 'course-repos.links.json'), 'utf8')); expect(compose).toContain(`${a}:/app/course-repos/example--a:ro`); expect(compose).toContain(`${a}/drills:${a}/drills:rw`); expect(compose).toContain(`${a}/drills:/app/course-repos/example--a/drills:rw`); expect(compose).toContain(`${output}/course-repos.links.json:/app/state/interview-runner/links.json:ro`); expect(compose).toContain(`${join(runner, 'sandbox')}:/app/sandbox-settings:rw`); expect(compose).toContain('SANDBOX_SETTINGS_HOST_DIR:'); expect(links.courses['example/b'].path).toBe('/app/course-repos/example--b'); });
  it('uses the existing settings bind for Podman history without a state-home mount', async () => {
    temp = await mkdtemp(join(tmpdir(), 'course-repos-')); const a = await repo('a'); const home = await state({ 'example/a': a }); const output = join(temp, 'output'); await mkdir(output);
    await run(resolve(runner, 'node_modules/.bin/tsx'), ['scripts/compose-repos.ts', output], { cwd: runner, env: { ...process.env, XDG_STATE_HOME: home } });
    const compose = await readFile(join(output, 'compose.repos.yaml'), 'utf8');
    expect(compose).toContain(`${join(runner, 'sandbox')}:/app/sandbox-settings:rw`);
    expect(compose).toContain(`SANDBOX_SETTINGS_HOST_DIR: ${JSON.stringify(join(runner, 'sandbox'))}`);
    expect(compose).not.toContain('workspace-git'); expect(compose).not.toContain('XDG_STATE_HOME');
    await expect(readFile(join(home, 'interview-runner/workspace-git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
