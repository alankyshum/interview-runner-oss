import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile); const runner = process.cwd(); let temp = '';
async function courseRepo(id: string, courseId: string, image: string) {
  const root = join(temp, id); const drill = join(root, 'drills', courseId, 'save'); const outline = join(root, 'outlines', courseId);
  await Promise.all([mkdir(join(root, 'courses'), { recursive: true }), mkdir(drill, { recursive: true }), mkdir(outline, { recursive: true }), mkdir(join(root, 'reading', courseId), { recursive: true }), mkdir(join(root, 'images'), { recursive: true })]);
  await writeFile(join(root, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 })); await writeFile(join(root, 'images/collision.txt'), image); await writeFile(join(root, 'reading', courseId, 'read.md'), 'read');
  await writeFile(join(outline, 'read.json'), JSON.stringify({ courseId, drillId: 'read', title: `${id} outline`, nodes: [{ id: 'claim', type: 'claim', text: id }] })); await writeFile(join(drill, 'save.ts'), 'export const owner = "initial";\n'); await writeFile(join(drill, 'save.test.ts'), "import { expect, it } from 'vitest'; import { owner } from './save'; it('owns',()=>expect(owner).toBeTruthy());\n");
  await mkdir(join(root, 'mindmaps', courseId), { recursive: true }); await writeFile(join(root, 'mindmaps', courseId, 'read.md'), '# Read');
  await writeFile(join(root, 'courses', `${courseId}.json`), JSON.stringify({ id: courseId, title: id, book: true, chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'save', title: 'Save', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: `drills/${courseId}/save/save.ts`, testPath: `drills/${courseId}/save/save.test.ts`, instructions: 'Save.' }, { id: 'read', title: 'Read', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: `mindmaps/${courseId}/read.md`, instructions: 'Read.' }] }] })); return root;
}
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = ''; });
it('routes APIs, files, images, outlines and books across two repositories', async () => {
  temp = await mkdtemp(join(tmpdir(), 'multi-repo-api-')); const first = await courseRepo('first', 'fixture-first', 'first'); const second = await courseRepo('second', 'fixture-second', 'second'); const empty = join(temp, 'empty'); await mkdir(join(empty, 'courses'), { recursive: true }); await writeFile(join(empty, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 }));
  await mkdir(join(first, 'cheatsheets', 'fixture-first'), { recursive: true });
  for (const [root, id] of [[first, 'sheet-first'], [second, 'sheet-second']]) {
    await mkdir(join(root, 'cheatsheets', id, 'assets'), { recursive: true });
    await mkdir(join(root, 'cheatsheets', id, 'sections'), { recursive: true });
    await writeFile(join(root, 'courses', `${id}.json`), JSON.stringify({ type: 'cheatsheet', id, title: id, chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: `cheatsheets/${id}/sections/one.html` }] }] }));
    await writeFile(join(root, 'cheatsheets', id, 'sections', 'one.html'), `<h2>${id}</h2>`);
    await writeFile(join(root, 'cheatsheets', id, 'assets', 'sample.png'), id);
  }
  const state = join(temp, 'state/interview-runner'); await mkdir(state, { recursive: true });
  await writeFile(join(state, 'links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: runner, supportedCourseSchema: 2 } }, courses: { 'aaa/first': { path: first, runner: 'interview-runner/interview-runner', schema: 2 }, 'mmm/empty': { path: empty, runner: 'interview-runner/interview-runner', schema: 2 }, 'zzz/second': { path: second, runner: 'interview-runner/interview-runner', schema: 2 } } }));
  const { stdout } = await exec(resolve(runner, 'node_modules/.bin/tsx'), ['server/multiRepo.integration.child.ts'], { cwd: runner, env: { ...process.env, XDG_STATE_HOME: join(temp, 'state'), VITEST: '1', INTERVIEW_RUNNER_STATE_ORIGIN: '' }, maxBuffer: 10 * 1024 * 1024 });
  const line = stdout.split('\n').find((value) => value.startsWith('MULTI_REPO_RESULT=')); expect(line).toBeTruthy(); const result = JSON.parse(line!.slice('MULTI_REPO_RESULT='.length));
  expect(result.library.body.courseRepos).toEqual(['aaa/first', 'mmm/empty', 'zzz/second']); expect(result.library.body.items.filter((item: any) => item.kind === 'course').map((item: any) => [item.id, item.repo])).toEqual([['fixture-first', 'aaa/first'], ['fixture-second', 'zzz/second']]); expect(result.courses.body.map((item: any) => [item.id, item.repo])).toEqual([['fixture-first', 'aaa/first'], ['fixture-second', 'zzz/second']]);
  expect(result.library.body.items.filter((item: any) => item.kind === 'cheatsheet').map((item: any) => [item.id, item.repo])).toEqual([['sheet-first', 'aaa/first'], ['sheet-second', 'zzz/second']]);
  expect(result.sheets.map((item: any) => item.repo)).toEqual(['aaa/first', 'zzz/second']);
  expect(result.sheetManifest.body.chapters[0].drills[0].sourcePath).toBe('cheatsheets/sheet-second/sections/one.html');
  expect(result.sheetHtml).toBe('<h2>sheet-second</h2>'); expect(result.sheetAsset).toBe('sheet-second');
  expect(result.live.before.body.sections[0].html).toBe('<h2>sheet-second</h2>');
  expect(result.live.after.body.sections[0].html).toContain('LIVE EDIT'); expect(result.live.reverted.body.sections[0].html).toBe('<h2>sheet-second</h2>');
  expect(result.live.after.cache).toBe('no-store');
  expect(result.live.changedCourse.body.title).toBe('Live course title'); expect(result.live.revertedCourse.body.title).toBe('second');
  expect(result.live.invalidSheet.status).toBe(400); expect(result.live.invalidSheet.body.error).toContain('Invalid cheatsheet sheet-second');
  expect(result.live.coursesWhileInvalid.status).toBe(200); expect(result.live.libraryWhileInvalid.status).toBe(200); expect(result.live.otherSheet.status).toBe(200);
  expect(result.live.libraryWhileInvalid.body.items.some((item: any) => item.kind === 'cheatsheet' && item.id === 'sheet-second')).toBe(true);
  expect(result.live.invalidSchema.status).toBe(400); expect(result.live.invalidSchema.body.error).toContain('chapters'); expect(result.live.libraryWithInvalidSchema.status).toBe(200);
  expect(result.live.invalidIdentity.status).toBe(400); expect(result.live.invalidIdentity.body.error).toContain('must match the filename'); expect(result.live.libraryWithInvalidIdentity.status).toBe(200);
  expect(result.live.missingSection.status).toBe(400); expect(result.live.missingSection.body.error).toContain('Unable to read cheatsheet section'); expect(result.live.otherWithMissingSection.status).toBe(200);
  expect(result.save).toMatchObject({ status: 405, body: { error: 'Method not allowed' } }); expect(result.saved).toContain('initial'); expect(result.escape).toContain('path escapes zzz/second'); expect(result.image).toBe('first'); expect(result.firstOutline.body.title).toBe('first outline'); expect(result.secondOutline.body.title).toBe('second outline'); expect(result.books.body.map((book: any) => book.id)).toEqual(['fixture-first', 'fixture-second']);
});
