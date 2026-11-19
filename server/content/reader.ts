import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { parseCourse, removedDrillErrors, safePath, type Course } from '../../shared/courseSchema';
import { isLegacyReading } from '../../shared/legacyReading';
import { courseRepos, pathInRepo, repoForCourse, requireRepoForCourse } from '../courseRepos';
import { openContentDb, type ContentDb } from './contentDb';
import { bundleFromDirectory, type CourseBundle } from './bundle';

export type ContentSource = 'files' | 'db';
export type ContentOwner = { kind: 'repo'; id: string } | { kind: 'namespace'; id: string };
export type CourseFileEntry = { path: string; mode: number | null };
export type ContentBlob = { bytes: Uint8Array; sha256: string };
export interface ContentReader {
  readCourseFile(courseId: string, path: string): Promise<Uint8Array | undefined>;
  readCourseBlob(courseId: string, path: string): Promise<ContentBlob | undefined>;
  readCourseFileAtRevision(courseId: string, path: string, revision?: number): Promise<Uint8Array | undefined>;
  courseAtRevision(courseId: string, revision?: number): Promise<Course | undefined>;
  courseFileExists(courseId: string, path: string): Promise<boolean>;
  listCourseFiles(courseId: string, prefix?: string): Promise<string[]>;
  listCourseFileEntries(courseId: string, prefix?: string): Promise<CourseFileEntry[]>;
  courseOwner(courseId: string): Promise<ContentOwner>;
  readImage(path: string): Promise<ContentBlob | undefined>;
}

const source = process.env.INTERVIEW_RUNNER_CONTENT_SOURCE ?? 'db';
if (source !== 'files' && source !== 'db') throw new Error('INTERVIEW_RUNNER_CONTENT_SOURCE must be files or db');
export function contentSource(): ContentSource { return source as ContentSource; }
let database: Promise<ContentDb> | undefined;
export function contentDatabase(): Promise<ContentDb> { return database ??= openContentDb().catch((error: unknown) => { database = undefined; throw error; }); }
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const validate = (path: string) => { safePath('content', path, 'path'); if (path.includes('\0')) throw new Error('Invalid content path'); };

/** Old immutable revisions may contain retired reading drills unrelated to a pinned coding attempt. */
export function parseHistoricalCourse(file: string, value: unknown): { course: Course; removedIds: Set<string> } {
  const removedIds = new Set<string>();
  let projected = value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'chapters' in value && Array.isArray(value.chapters)) {
    const courseId = 'id' in value && typeof value.id === 'string' ? value.id : undefined;
    const seen = new Set<string>();
    const chapters = value.chapters.map((chapter: unknown) => {
      if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter) || !('drills' in chapter) || !Array.isArray(chapter.drills)) return chapter;
      const drills = chapter.drills.filter((drill: unknown) => {
        if (!drill || typeof drill !== 'object' || Array.isArray(drill) || !('id' in drill) || typeof drill.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(drill.id)) return true;
        if (seen.has(drill.id)) throw new Error(`Invalid course manifest ${file}: duplicate drill id ${drill.id}`);
        seen.add(drill.id);
        if ('contentType' in drill && drill.contentType === 'reading' && (removedDrillErrors(drill as Record<string, unknown>, drill.id).length || (courseId !== undefined && !isLegacyReading(courseId, drill.id)))) { removedIds.add(drill.id); return false; }
        return true;
      });
      return { ...chapter, drills };
    });
    projected = { ...value, chapters };
  }
  return { course: parseCourse(file, projected), removedIds };
}

/** Preserve sirv's file-mode lookup and headers, but never let it follow an escaping image symlink. */
export async function fileImageRepository(path: string): Promise<string | undefined> {
  // Match sirv's index/extension lookup without changing the URL passed to it.
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path.includes('\0')) return undefined;
  const candidates = ['', '.html', '.htm'].flatMap((extension) => [...(path ? [`${path}${extension}`] : []), `${path}/index${extension}`]);
  for (const repo of courseRepos) {
    let root: string; let images: string;
    try { root = await realpath(repo.root); images = await realpath(pathInRepo(repo, 'images')); }
    catch (error) { if (missing(error)) continue; throw error; }
    if (!images.startsWith(`${root}${sep}`)) continue;
    for (const candidate of candidates) {
      try {
        const imageRoot = resolve(repo.root, 'images'); const requested = resolve(imageRoot, `.${sep}${candidate}`);
        if (!requested.startsWith(`${imageRoot}${sep}`)) continue;
        const target = await realpath(requested);
        if (!(await stat(target)).isFile()) continue;
        if (target.startsWith(`${images}${sep}`)) return repo.id;
        break; // sirv would pick this escaping candidate before any later one.
      } catch (error) { if (!missing(error)) throw error; }
    }
  }
  return undefined;
}

export function createContentReader(kind: ContentSource, db: () => Promise<ContentDb> = contentDatabase): ContentReader {
  const bundleAtRevision = async (courseId: string, revision: number): Promise<CourseBundle | undefined> => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid content revision');
    const row = (await db()).prepare('SELECT bundle_json FROM course_revision WHERE course_id=? AND revision=?').get(courseId, revision) as { bundle_json: string } | undefined;
    return row ? JSON.parse(row.bundle_json) as CourseBundle : undefined;
  };
  const readCourseFile = async (courseId: string, path: string): Promise<Uint8Array | undefined> => {
    validate(path);
    if (kind === 'db') {
      const row = (await db()).prepare('SELECT b.bytes FROM lesson_file f JOIN blob b ON b.sha256=f.blob_sha256 JOIN course c ON c.id=f.course_id WHERE c.deleted_at IS NULL AND f.course_id=? AND f.path=? LIMIT 1').get(courseId, path) as { bytes: Uint8Array } | undefined;
      return row?.bytes;
    }
    const repo = requireRepoForCourse(courseId); const target = pathInRepo(repo, path);
    try {
      const root = await realpath(repo.root); const actual = await realpath(target);
      if (!actual.startsWith(`${root}${sep}`) || !(await stat(actual)).isFile()) throw new Error('Course content path escapes its repository');
      const [tree] = path.split('/');
      if (tree === 'mindmaps' || tree === 'recall' || tree === 'cheatsheets') {
        const treeRoot = await realpath(resolve(root, tree));
        const base = await realpath(resolve(root, tree, courseId));
        if (!treeRoot.startsWith(`${root}${sep}`) || !base.startsWith(`${treeRoot}${sep}`) || !actual.startsWith(`${base}${sep}`)) throw new Error('Course content path escapes its directory');
        if ((tree === 'mindmaps' || tree === 'recall') && (base !== resolve(root, tree, courseId) || actual !== resolve(root, path))) throw new Error('Course content path is a symlink');
      }
      return await readFile(actual);
    } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const readCourseBlob = async (courseId: string, path: string): Promise<ContentBlob | undefined> => {
    validate(path);
    if (kind === 'db') return (await db()).prepare('SELECT b.bytes, f.blob_sha256 AS sha256 FROM lesson_file f JOIN blob b ON b.sha256=f.blob_sha256 JOIN course c ON c.id=f.course_id WHERE c.deleted_at IS NULL AND f.course_id=? AND f.path=? LIMIT 1').get(courseId, path) as ContentBlob | undefined;
    const bytes = await readCourseFile(courseId, path); return bytes ? { bytes, sha256: createHash('sha256').update(bytes).digest('hex') } : undefined;
  };
  const listCourseFileEntries = async (id: string, prefix = ''): Promise<CourseFileEntry[]> => {
    const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix; if (prefix && !trimmed) throw new Error('Invalid content path'); if (trimmed) validate(trimmed);
    if (kind === 'db') return (await db()).prepare('SELECT DISTINCT f.path, f.mode FROM lesson_file f JOIN course c ON c.id=f.course_id WHERE c.deleted_at IS NULL AND f.course_id=? AND substr(f.path,1,?)=? ORDER BY f.path').all(id, prefix.length, prefix) as CourseFileEntry[];
    const { bundle } = await bundleFromDirectory(requireRepoForCourse(id).root, id);
    return Object.keys(bundle.files).filter((path) => path.startsWith(prefix)).sort().map((path) => ({ path, mode: bundle.files[path]!.mode ?? null }));
  };
  return {
    readCourseFile,
    readCourseBlob,
    async courseAtRevision(courseId, revision) {
      if (kind === 'files') { const repo = repoForCourse(courseId); return repo ? (await (await import('../courses')).loadCourses(join(repo.root, 'courses'))).find((course) => course.id === courseId) : undefined; }
      if (revision === undefined) return (await import('../courses')).loadCourse(courseId);
      const bundle = await bundleAtRevision(courseId, revision);
      return bundle ? parseHistoricalCourse(`${courseId}@${revision}`, bundle.manifest).course : undefined;
    },
    async readCourseFileAtRevision(courseId, path, revision) {
      validate(path);
      if (kind === 'files' || revision === undefined) return readCourseFile(courseId, path);
      const bundle = await bundleAtRevision(courseId, revision);
      if (!bundle) throw new Error(`Unknown content revision: ${courseId}/${revision}`);
      const entry = Object.hasOwn(bundle.files, path) ? bundle.files[path] : undefined;
      if (!entry) return undefined;
      const blob = (await db()).prepare('SELECT bytes FROM blob WHERE sha256=?').get(entry.sha256) as { bytes: Uint8Array } | undefined;
      if (!blob) throw new Error(`Missing content blob: ${path}`);
      return blob.bytes;
    },
    async courseFileExists(id, path) { return (await readCourseFile(id, path)) !== undefined; },
    async listCourseFiles(id, prefix) { return [...new Set((await listCourseFileEntries(id, prefix)).map(({ path }) => path))]; },
    listCourseFileEntries,
    async courseOwner(id) {
      if (kind === 'files') return { kind: 'repo', id: requireRepoForCourse(id).id };
      const row = (await db()).prepare('SELECT namespace_id FROM course WHERE id=? AND deleted_at IS NULL').get(id) as { namespace_id: string } | undefined;
      if (!row) throw new Error(`Unknown course: ${id}`);
      return { kind: 'namespace', id: row.namespace_id };
    },
    async readImage(path) {
      validate(path); const full = `images/${path}`;
      if (kind === 'db') {
        return (await db()).prepare('SELECT b.bytes, f.blob_sha256 AS sha256 FROM lesson_file f JOIN blob b ON b.sha256=f.blob_sha256 JOIN course c ON c.id=f.course_id WHERE c.deleted_at IS NULL AND f.path=? ORDER BY c.id LIMIT 1').get(full) as ContentBlob | undefined;
      }
      for (const repo of courseRepos) {
        try { const root = await realpath(repo.root); const images = await realpath(pathInRepo(repo, 'images')); const file = await realpath(pathInRepo(repo, full)); if (!images.startsWith(`${root}${sep}`) || !file.startsWith(`${images}${sep}`) || !(await stat(file)).isFile()) continue; const bytes = await readFile(file); return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }; }
        catch (error) { if (!missing(error)) throw error; }
      }
      return undefined;
    },
  };
}
const reader = createContentReader(contentSource());
export function contentReader(): ContentReader { return reader; }
export function courseAtRevision(courseId: string, revision?: number): Promise<Course | undefined> { return reader.courseAtRevision(courseId, revision); }
export function readCourseFileAtRevision(courseId: string, path: string, revision?: number): Promise<Uint8Array | undefined> { return reader.readCourseFileAtRevision(courseId, path, revision); }
