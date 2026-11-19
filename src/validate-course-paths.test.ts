import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findMissingPaths } from '../scripts/validate-course-paths';

vi.mock('../shared/legacyReading', async (original) => { const actual = await original<typeof import('../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'course' && drill === 'one' || course === 'one' && drill === 'a' || course === 'two' && drill === 'c' }; });

const validDrill = (id: string, paths: Record<string, unknown> = {}) => ({ contentType: 'coding', id, title: id, kind: 'logic', estMinutes: 10, sourcePath: `drills/course/${id}/${id}.ts`, testPath: `drills/course/${id}/${id}.test.ts`, instructions: 'Do it.', ...paths });
const manifest = (id: string, drills: unknown[]) => ({ id, title: id, chapters: [{ id: 'chapter', title: 'Chapter', drills }] });

let root: string;
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(id: string, drills: unknown[], paths: string[] = []) {
  root = await mkdtemp(join(tmpdir(), 'course-paths-'));
  await mkdir(join(root, 'courses'), { recursive: true });
  for (const path of paths) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'fixture'); }
  await writeFile(join(root, 'courses', `${id}.json`), JSON.stringify(manifest(id, drills)));
  return join(root, 'courses');
}

describe('course manifest path validation', () => {
  it('requires the section files of a cheatsheet manifest', async () => {
    const dir = await fixture('course', []);
    await writeFile(join(dir, 'sheet.json'), JSON.stringify({ type: 'cheatsheet', id: 'sheet', title: 'Sheet', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/sheet/sections/one.html' }] }] }));
    expect(await findMissingPaths(dir)).toEqual([{ courseId: 'sheet', chapterId: 'chapter', drillId: 'one', field: 'sourcePath', path: 'cheatsheets/sheet/sections/one.html' }]);
    await mkdir(join(root, 'cheatsheets/sheet/sections'), { recursive: true });
    await writeFile(join(root, 'cheatsheets/sheet/sections/one.html'), '<p>Section</p>');
    expect(await findMissingPaths(dir)).toEqual([]);
  });
  it('requires a declared cheatsheet mind map source', async () => {
    const dir = await fixture('course', []);
    const sourcePath = 'cheatsheets/sheet/sections/one.html';
    const mindmapPath = 'cheatsheets/sheet/diagrams/mindmaps/one.md';
    await writeFile(join(dir, 'sheet.json'), JSON.stringify({ type: 'cheatsheet', id: 'sheet', title: 'Sheet', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath, mindmapPath }] }] }));
    await mkdir(join(root, 'cheatsheets/sheet/sections'), { recursive: true }); await writeFile(join(root, sourcePath), '<h2>One</h2>');
    expect(await findMissingPaths(dir)).toEqual([{ courseId: 'sheet', chapterId: 'chapter', drillId: 'one', field: 'mindmapPath', path: mindmapPath }]);
    await mkdir(join(root, 'cheatsheets/sheet/diagrams/mindmaps'), { recursive: true }); await writeFile(join(root, mindmapPath), '# One');
    expect(await findMissingPaths(dir)).toEqual([]);
  });
  it('validates ai-coding workspace structure, acceptance stages, and sandbox dependencies', async () => {
    const ai = { id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 30, workspacePath: 'drills/course/pair/workspace', sourcePath: 'drills/course/pair/workspace/src/pair.ts', testRunner: 'vitest', handoffPath: 'drills/course/pair/handoff.md', rubricPath: 'drills/course/pair/rubric.md', acceptancePath: 'drills/course/pair/acceptance', instructions: '## Milestone 1\nStart.\n## Milestone 2\nChange.' };
    const paths = ['drills/course/pair/workspace/src/pair.ts', 'drills/course/pair/workspace/package.json', 'drills/course/pair/handoff.md', 'drills/course/pair/rubric.md', 'drills/course/pair/acceptance/stage-1.test.ts', 'drills/course/pair/acceptance/stage-2.test.ts'];
    const dir = await fixture('course', [ai], paths);
    await writeFile(join(root, 'drills/course/pair/workspace/package.json'), JSON.stringify({ devDependencies: { vitest: '4.1.12' } }));
    expect(await findMissingPaths(dir)).toEqual([]);
    await writeFile(join(root, 'drills/course/pair/workspace/package.json'), JSON.stringify({ dependencies: { 'not-in-sandbox': '1.0.0' } }));
    await expect(findMissingPaths(dir)).rejects.toThrow('dependencies unavailable in sandbox');
  });

  it('rejects symlinks in an ai-coding template', async () => {
    const ai = { id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 30, workspacePath: 'drills/course/pair/workspace', sourcePath: 'drills/course/pair/workspace/src/pair.ts', testRunner: 'vitest', handoffPath: 'drills/course/pair/handoff.md', rubricPath: 'drills/course/pair/rubric.md', instructions: '## Milestone 1\nStart.\n## Milestone 2\nChange.' };
    const dir = await fixture('course', [ai], ['drills/course/pair/workspace/src/pair.ts', 'drills/course/pair/workspace/package.json', 'drills/course/pair/handoff.md', 'drills/course/pair/rubric.md']);
    await writeFile(join(root, 'drills/course/pair/workspace/package.json'), '{}');
    await symlink('src/pair.ts', join(root, 'drills/course/pair/workspace/link.ts'));
    await expect(findMissingPaths(dir)).rejects.toThrow('symlinks are forbidden');
  });
  it('finds no paths missing when every declared path exists', async () => {
    const dir = await fixture('course', [validDrill('one')], ['drills/course/one/one.ts', 'drills/course/one/one.test.ts']);
    expect(await findMissingPaths(dir)).toEqual([]);
  });

  it('reports a missing sourcePath', async () => {
    const dir = await fixture('course', [validDrill('one')], ['drills/course/one/one.test.ts']);
    expect(await findMissingPaths(dir)).toEqual([{ courseId: 'course', chapterId: 'chapter', drillId: 'one', field: 'sourcePath', path: 'drills/course/one/one.ts' }]);
  });

  it('reports a missing testPath', async () => {
    const dir = await fixture('course', [validDrill('one', { testPath: 'drills/course/one/one.test.ts' })], ['drills/course/one/one.ts']);
    expect((await findMissingPaths(dir)).map((item) => item.field)).toEqual(['testPath']);
  });

  it('reports a missing declared reading outline', async () => {
    const dir = await fixture('course', [validDrill('one', { contentType: 'reading', testPath: undefined, outlinePath: 'outlines/course/one.json' })], ['drills/course/one/one.ts']);
    expect((await findMissingPaths(dir)).map((item) => item.field)).toEqual(['outlinePath']);
  });

  it('rejects an outline with mismatched identity before publishing', async () => {
    const path = 'outlines/course/one.json';
    const dir = await fixture('course', [validDrill('one', { contentType: 'reading', testPath: undefined, outlinePath: path })], ['drills/course/one/one.ts', path]);
    await writeFile(join(root, path), JSON.stringify({ courseId: 'other', drillId: 'one', title: 'Wrong course', nodes: [{ id: 'claim', type: 'claim', text: 'Read.' }] }));
    await expect(findMissingPaths(dir)).rejects.toThrow('courseId must match path');
  });

  it('reports a missing scaffold seedPath', async () => {
    const dir = await fixture('course', [validDrill('one', { scaffold: { seedPath: 'drills/course/one/one.seed.ts' } })], ['drills/course/one/one.ts', 'drills/course/one/one.test.ts']);
    expect((await findMissingPaths(dir)).map((item) => item.field)).toEqual(['scaffold.seedPath']);
  });

  it('rejects a removed evaluation before checking paths', async () => {
    const dir = await fixture('course', [validDrill('one', { evaluation: { mode: 'critique', rubricPath: 'drills/course/one/one.json' } })], ['drills/course/one/one.ts']);
    await expect(findMissingPaths(dir)).rejects.toThrow('evaluation is no longer supported');
  });

  it('reports every missing path across multiple courses and drills', async () => {
    root = await mkdtemp(join(tmpdir(), 'course-paths-'));
    const courses = join(root, 'courses'); await mkdir(courses, { recursive: true });
    await writeFile(join(courses, 'one.json'), JSON.stringify(manifest('one', [validDrill('a', { contentType: 'reading', testPath: undefined, outlinePath: 'outlines/one/a.json', sourcePath: 'drills/one/a/a.ts' }), validDrill('b', { sourcePath: 'drills/one/b/b.ts', testPath: 'drills/one/b/b.test.ts' })])));
    await writeFile(join(courses, 'two.json'), JSON.stringify(manifest('two', [validDrill('c', { contentType: 'reading', testPath: undefined, outlinePath: 'outlines/two/c.json', sourcePath: 'drills/two/c/c.ts' })])));
    const missing = await findMissingPaths(courses);
    expect(missing).toHaveLength(6);
    expect(missing.map((item) => `${item.courseId}:${item.drillId}:${item.field}`).sort()).toEqual(['one:a:outlinePath', 'one:a:sourcePath', 'one:b:sourcePath', 'one:b:testPath', 'two:c:outlinePath', 'two:c:sourcePath']);
  });
});
