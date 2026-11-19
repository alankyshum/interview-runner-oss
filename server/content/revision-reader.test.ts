// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContentDb } from './contentDb';
import { createContentReader } from './reader';
import { sha256 } from './bundle';
import { courseRepos } from '../courseRepos';
import { invalidateCourseCatalog } from '../courses';
import { parseCourse } from '../../shared/courseSchema';

describe('historical content reader', () => {
  it('omits retired reading drills only from immutable revisions while retaining strict validation', async () => {
    const db = await openContentDb(':memory:');
    try {
      const ai = { id: 'ai', title: 'AI', contentType: 'ai-coding', kind: 'logic', estMinutes: 10, sourcePath: 'drills/course/ai/workspace/main.ts', workspacePath: 'drills/course/ai/workspace', testRunner: 'vitest', handoffPath: 'guides/course/handoff.md', rubricPath: 'guides/course/rubric.md', instructions: '## Milestone 1\nStart.\n## Milestone 2\nFinish.' };
      const reading = { id: 'old', title: 'Old', contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: 'reading/course/old.md', instructions: 'Reflect.', evaluation: { mode: 'critique' } };
      const current = { id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [ai] }] };
      const historical = { ...current, chapters: [{ ...current.chapters[0], drills: [reading, ai] }] };
      expect(() => parseCourse('course.json', historical)).toThrow('reading is deprecated');
      db.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run('course', 'ns', 'course', 'Course', 'now', 'now', 2, JSON.stringify(current));
      db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run('course', 1, JSON.stringify({ manifest: historical, files: {} }), 'now');
      const reader = createContentReader('db', async () => db);
      expect((await reader.courseAtRevision('course', 1))?.chapters[0].drills).toEqual([{ ...ai, stageUnlock: { mode: 'manual' } }]);
      const { parseHistoricalCourse } = await import('./reader');
      const formerlyValid = { ...reading, evaluation: undefined, outlinePath: 'outlines/course/old.json' };
      expect(parseHistoricalCourse('course@1', { ...historical, chapters: [{ ...historical.chapters[0], drills: [formerlyValid, ai] }] }).removedIds.has('old')).toBe(true);
      expect(() => parseHistoricalCourse('course@1', { ...historical, chapters: [{ ...historical.chapters[0], drills: [reading, { ...ai, sourcePath: '../escape' }] }] })).toThrow();
      expect(() => parseHistoricalCourse('course@1', { ...historical, chapters: [{ ...historical.chapters[0], drills: [reading, reading] }] })).toThrow('duplicate drill id');
    } finally { db.close(); }
  });
  it('resolves manifests and files from the requested immutable bundle', async () => {
    const db = await openContentDb(':memory:');
    try {
      const manifest = (title: string) => ({ id: 'course', title, chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'drill', title: 'Drill', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/course/drill/source.ts', testPath: 'drills/course/drill/source.test.ts', instructions: 'Implement it.' }] }] });
      db.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run('course', 'ns', 'course', 'new', 'now', 'now', 2, JSON.stringify(manifest('new')));
      for (const [revision, content] of [[1, 'old rubric'], [2, 'new rubric']] as const) {
        const bytes = Buffer.from(content); const hash = sha256(bytes);
        db.prepare('INSERT INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now');
        db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run('course', revision, JSON.stringify({ manifest: manifest(revision === 1 ? 'old' : 'new'), files: { 'guides/course/rubric.md': { sha256: hash, size: bytes.length } } }), 'now');
      }
      const reader = createContentReader('db', async () => db);
      expect((await reader.courseAtRevision('course', 1))?.title).toBe('old'); expect((await reader.courseAtRevision('course', 2))?.title).toBe('new');
      expect(Buffer.from((await reader.readCourseFileAtRevision('course', 'guides/course/rubric.md', 1))!).toString()).toBe('old rubric');
      expect(await reader.readCourseFileAtRevision('course', 'guides/course/missing.md', 1)).toBeUndefined();
      await expect(reader.readCourseFileAtRevision('course', '../secret', 1)).rejects.toThrow();
      await expect(reader.readCourseFileAtRevision('course', 'guides/course/rubric.md', 3)).rejects.toThrow('Unknown content revision');
      await expect(reader.courseAtRevision('course', 0)).rejects.toThrow('Invalid content revision');
    } finally { db.close(); }
  });
  it('uses the live manifest and file in files mode even with a revision supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revision-reader-files-')); const repo = { id: 'test/revision', name: 'revision', root }; courseRepos.push(repo);
    try {
      await mkdir(join(root, 'courses')); await mkdir(join(root, 'guides/rev-file-course'), { recursive: true });
      const manifest = { id: 'rev-file-course', title: 'Current', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'drill', title: 'Drill', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/rev-file-course/drill/source.ts', testPath: 'drills/rev-file-course/drill/source.test.ts', instructions: 'Implement it.' }] }] };
      await writeFile(join(root, 'courses/rev-file-course.json'), JSON.stringify(manifest)); await writeFile(join(root, 'guides/rev-file-course/rubric.md'), 'current'); invalidateCourseCatalog();
      const reader = createContentReader('files'); expect((await reader.courseAtRevision('rev-file-course', 1))?.title).toBe('Current');
      expect(Buffer.from((await reader.readCourseFileAtRevision('rev-file-course', 'guides/rev-file-course/rubric.md', 1))!).toString()).toBe('current');
    } finally { courseRepos.splice(courseRepos.indexOf(repo), 1); invalidateCourseCatalog(); await rm(root, { recursive: true, force: true }); }
  });
});
