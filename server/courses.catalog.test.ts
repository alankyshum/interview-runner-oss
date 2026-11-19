// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});
vi.mock('./courseRepos', () => ({ courseRepos: [{ id: 'fixture/repo', root: '' }], requireRepoForCourse: () => ({ root: '' }) }));
vi.mock('../shared/courseSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/courseSchema')>();
  return { ...actual, parseCourse: vi.fn(actual.parseCourse) };
});

import { courseRepos } from './courseRepos';
import { invalidateCourseCatalog, listCheatsheets, loadCheatsheet, loadCourse, loadCourseHints, loadCourses } from './courses';
import { parseCourse } from '../shared/courseSchema';

let root: string; let dir: string;
const manifest = (id: string, title = id) => JSON.stringify({ id, title, chapters: [] });
const write = (name: string, value: string) => writeFile(join(dir, name), value);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'catalog-')); dir = join(root, 'courses'); await mkdir(dir);
  courseRepos[0].root = root; invalidateCourseCatalog(); vi.mocked(readFile).mockClear(); vi.mocked(stat).mockClear();
});
afterEach(async () => { vi.restoreAllMocks(); invalidateCourseCatalog(); await rm(root, { recursive: true, force: true }); });

it('coalesces concurrent loads, uses cached manifests, and explicitly invalidates', async () => {
  await write('one.json', manifest('one'));
  await Promise.all([loadCourses(), loadCourse('one'), listCheatsheets(), loadCourses(dir)]);
  expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  expect((await loadCourse('one'))?.title).toBe('one');
  expect(await loadCourse('missing')).toBeUndefined();
  const course = (await loadCourse('one'))!; course.title = 'Mutated';
  const courses = await loadCourses(); courses[0].title = 'Also mutated';
  expect((await loadCourse('one'))?.title).toBe('one');
  expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  invalidateCourseCatalog(); await loadCourses(); expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
});

it('notices edited, added and removed manifests', async () => {
  await write('one.json', manifest('one')); expect((await loadCourse('one'))?.title).toBe('one');
  await write('one.json', manifest('one', 'Edited title')); expect((await loadCourse('one'))?.title).toBe('Edited title');
  await write('two.json', manifest('two')); expect((await loadCourses()).map((course) => course.id)).toEqual(['one', 'two']);
  await unlink(join(dir, 'one.json')); expect(await loadCourse('one')).toBeUndefined(); expect((await loadCourses()).map((course) => course.id)).toEqual(['two']);
});

it('detects an atomic replacement with the same size and preserved mtime', async () => {
  const file = join(dir, 'one.json'); await write('one.json', manifest('one', 'First'));
  await utimes(file, 1_700_000_000, 1_700_000_000);
  const before = await stat(file); expect((await loadCourse('one'))?.title).toBe('First');
  const replacement = join(root, 'replacement'); await writeFile(replacement, manifest('one', 'Other'));
  await utimes(replacement, before.atime, before.mtime); await rename(replacement, file);
  const after = await stat(file); expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
  expect((await loadCourse('one'))?.title).toBe('Other');
});

it('forces a reload after the max age even if all fingerprint metadata collides', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const file = join(dir, 'one.json'); await write('one.json', manifest('one', 'First'));
  const unchanged = await stat(file); expect((await loadCourse('one'))?.title).toBe('First');
  await write('one.json', manifest('one', 'Other'));
  vi.mocked(stat).mockResolvedValueOnce(unchanged);
  expect((await loadCourse('one'))?.title).toBe('First'); expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  now.mockReturnValue(12_000); vi.mocked(stat).mockResolvedValueOnce(unchanged);
  expect((await loadCourse('one'))?.title).toBe('Other'); expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
});

it('revalidates steady traffic by digest and parses only changed manifests', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const jsonParse = vi.spyOn(JSON, 'parse');
  for (let index = 0; index < 6; index++) await write(`course-${index}.json`, manifest(`course-${index}`, 'First'));
  const changed = join(dir, 'course-0.json'); await utimes(changed, 1_700_000_000, 1_700_000_000);
  const original = await stat(changed); await loadCourses();
  jsonParse.mockClear(); vi.mocked(parseCourse).mockClear(); vi.mocked(readFile).mockClear();
  for (const time of [12_000, 14_000, 16_000, 18_000, 20_000]) {
    now.mockReturnValue(time); await loadCourse('course-0');
  }
  expect(vi.mocked(readFile)).toHaveBeenCalledTimes(30);
  expect(jsonParse).not.toHaveBeenCalled(); expect(vi.mocked(parseCourse)).not.toHaveBeenCalled();
  await write('course-0.json', manifest('course-0', 'Other')); await utimes(changed, original.atime, original.mtime);
  const updated = await stat(changed); expect(updated.size).toBe(original.size); expect(updated.mtimeMs).toBe(original.mtimeMs);
  vi.mocked(stat).mockResolvedValueOnce(original); now.mockReturnValue(22_000);
  expect((await loadCourse('course-0'))?.title).toBe('Other');
  expect(jsonParse).toHaveBeenCalledTimes(1); expect(vi.mocked(parseCourse)).toHaveBeenCalledTimes(1);
});

it('retries a read error during digest revalidation instead of returning stale content', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  await write('one.json', manifest('one')); await loadCourses();
  now.mockReturnValue(12_000); vi.mocked(readFile).mockRejectedValueOnce(new Error('unreadable manifest'));
  await expect(loadCourses()).rejects.toThrow('unreadable manifest');
  expect((await loadCourses()).map((course) => course.id)).toEqual(['one']);
});

it('does not persist cache entries for many explicit unlinked directories', async () => {
  const directories = Array.from({ length: 100 }, (_, index) => join(root, 'external', String(index)));
  for (const directory of directories) {
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'one.json'), manifest('one'));
    await loadCourses(directory);
  }
  expect(vi.mocked(readFile)).toHaveBeenCalledTimes(100);
  await loadCourses(directories[0]); expect(vi.mocked(readFile)).toHaveBeenCalledTimes(101);
});

it('ignores dangling hints and retries when a manifest vanishes during fingerprinting', async () => {
  await write('one.json', manifest('one')); await symlink('missing', join(dir, 'one.hints.json'));
  expect((await loadCourses()).map((course) => course.id)).toEqual(['one']);
  invalidateCourseCatalog(); vi.mocked(stat).mockClear();
  vi.mocked(stat).mockImplementationOnce(async (path) => {
    await unlink(String(path)); throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
  });
  expect(await loadCourses()).toEqual([]); expect(vi.mocked(stat)).toHaveBeenCalledTimes(1);
});

it('reloads only the repository whose fingerprint changed', async () => {
  const second = join(root, 'second'); await mkdir(join(second, 'courses'), { recursive: true });
  courseRepos.push({ id: 'fixture/second', name: 'second', root: second });
  try {
    await write('one.json', manifest('one')); await writeFile(join(second, 'courses', 'two.json'), manifest('two'));
    await loadCourses(); expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
    await writeFile(join(second, 'courses', 'two.json'), manifest('two', 'Changed'));
    expect((await loadCourse('two'))?.title).toBe('Changed');
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(3);
  } finally { courseRepos.pop(); }
});

it('retries invalid course errors even when the fingerprint is unchanged', async () => {
  await write('bad.json', '{');
  await expect(loadCourses()).rejects.toThrow(); await expect(loadCourses()).rejects.toThrow();
  expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
  await write('bad.json', manifest('bad')); expect((await loadCourse('bad'))?.id).toBe('bad');
});

it('isolates malformed cheatsheets and tracks changes to sheet directory existence', async () => {
  await write('sheet.json', '{'); await mkdir(join(root, 'cheatsheets', 'sheet'), { recursive: true });
  expect(await loadCourses()).toEqual([]);
  expect(await listCheatsheets()).toEqual([{ id: 'sheet', title: 'sheet', repo: 'fixture/repo' }]);
  await expect(loadCheatsheet('sheet')).rejects.toThrow('Invalid cheatsheet sheet: malformed JSON');
  await rm(join(root, 'cheatsheets', 'sheet'), { recursive: true });
  await expect(loadCourses()).rejects.toThrow(); expect(await listCheatsheets()).toEqual([]);
  await mkdir(join(root, 'cheatsheets', 'sheet'));
  await write('sheet.json', JSON.stringify({ type: 'cheatsheet', id: 'sheet', title: 'Reference', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/sheet/sections/one.html' }] }] }));
  expect((await loadCheatsheet('sheet'))?.title).toBe('Reference');
  expect((await listCheatsheets())[0].title).toBe('Reference');
});

it('invalidates a cached malformed-sheet fallback when its sheet directory disappears', async () => {
  await write('sheet.json', JSON.stringify({ id: 'sheet', title: 'Broken', chapters: 'bad' }));
  await mkdir(join(root, 'cheatsheets', 'sheet'), { recursive: true });
  expect(await loadCourses()).toEqual([]); expect(await loadCourses()).toEqual([]);
  expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  vi.mocked(parseCourse).mockClear();
  await rm(join(root, 'cheatsheets', 'sheet'), { recursive: true });
  await expect(loadCourses()).rejects.toThrow('chapters');
  expect(vi.mocked(parseCourse)).not.toHaveBeenCalled();
});

it('allows a sheet to load despite an unrelated manifest read error', async () => {
  await write('bad.json', manifest('bad')); await mkdir(join(root, 'cheatsheets', 'sheet'), { recursive: true });
  await write('sheet.json', JSON.stringify({ type: 'cheatsheet', id: 'sheet', title: 'Reference', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/sheet/sections/one.html' }] }] }));
  vi.mocked(readFile).mockRejectedValueOnce(new Error('unreadable manifest'));
  expect((await loadCheatsheet('sheet'))?.title).toBe('Reference');
  expect((await loadCourses()).map((course) => course.id)).toEqual(['bad']);
});

it('reads hints live and validates against updated courses', async () => {
  await write('one.json', manifest('one')); expect(await loadCourseHints('one', dir)).toBeUndefined();
  await write('one.hints.json', JSON.stringify({ courseId: 'one', drills: {} }));
  expect(await loadCourseHints('one', dir)).toEqual({ courseId: 'one', drills: {} });
  await write('one.hints.json', JSON.stringify({ courseId: 'wrong', drills: {} }));
  await expect(loadCourseHints('one', dir)).rejects.toThrow('courseId/drills');
  await unlink(join(dir, 'one.hints.json')); expect(await loadCourseHints('one', dir)).toBeUndefined();
});
