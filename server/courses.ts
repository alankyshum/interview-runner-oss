import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { courseRepos, requireRepoForCourse } from './courseRepos';
import { parseCourse, parseCheatsheet, invalid, stringField, unknownFields, type Course, type Cheatsheet, type Drill } from '../shared/courseSchema';
import { contentDatabase, contentSource, parseHistoricalCourse } from './content/reader';
export { parseCourse, invalid, stringField, unknownFields, normalizeTags, safePath } from '../shared/courseSchema';
export type { Course, Chapter, Drill, DrillKind, DrillScaffold, StageUnlock } from '../shared/courseSchema';

export type MilestoneHint = { title: string; approach: string; solution: string };
export type CourseHints = { courseId: string; drills: Record<string, MilestoneHint[]> };
const manifestFiles = async (dir: string) => (await readdir(dir)).filter((file) => file.endsWith('.json') && !file.endsWith('.hints.json')).sort();
async function sheetDirectory(dir: string, file: string): Promise<boolean> {
  const id = file.slice(0, -5); if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return false;
  try { return (await stat(join(dirname(dir), 'cheatsheets', id))).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
const isSheet = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'type' in value && value.type === 'cheatsheet');
export async function loadDirectory(dir: string): Promise<(Course | Cheatsheet)[]> {
  const files = await manifestFiles(dir);
  return Promise.all(files.map(async (file) => {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    return raw && typeof raw === 'object' && 'type' in raw && raw.type === 'cheatsheet' ? parseCheatsheet(file, raw) : parseCourse(file, raw);
  }));
}
type CatalogEntry = { file: string; sheetDirectory: boolean; digest?: string; raw: unknown; syntaxError?: SyntaxError; readError?: unknown; validationError?: unknown; course?: Course; courseError?: unknown; sheet?: { id: string; title: string } };
type DirectoryCatalog = { fingerprint: string; loadedAt: number; entries: CatalogEntry[]; courses: Course[]; byId: Map<string, Course>; courseError?: unknown };
const catalogMaxAgeMs = 2_000;

class CourseCatalog {
  private directories = new Map<string, DirectoryCatalog>();
  private inflight = new Map<string, Promise<DirectoryCatalog>>();
  private combined?: { directories: DirectoryCatalog[]; courses: Course[]; byId: Map<string, Course> };
  private generation = 0;

  invalidate(): void { this.generation++; this.directories.clear(); this.inflight.clear(); this.combined = undefined; }
  evict(dir: string): void { this.directories.delete(resolve(dir)); this.combined = undefined; }

  directory(dir: string): Promise<DirectoryCatalog> {
    dir = resolve(dir);
    const pending = this.inflight.get(dir); if (pending) return pending;
    const generation = this.generation;
    const task = this.loadDirectory(dir, generation);
    this.inflight.set(dir, task);
    void task.then(() => { if (this.inflight.get(dir) === task) this.inflight.delete(dir); }, () => { if (this.inflight.get(dir) === task) this.inflight.delete(dir); });
    return task;
  }

  private async loadDirectory(dir: string, generation: number): Promise<DirectoryCatalog> {
    const fingerprintDirectory = async () => {
      const files = await manifestFiles(dir);
      return Promise.all(files.map(async (file) => {
        const info = await stat(join(dir, file));
        const sheet = await sheetDirectory(dir, file);
        return { file, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, size: info.size, sheet };
      }));
    };
    let metadata: Awaited<ReturnType<typeof fingerprintDirectory>>;
    try { metadata = await fingerprintDirectory(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      metadata = await fingerprintDirectory();
    }
    const fingerprint = JSON.stringify(metadata);
    const persistent = courseRepos.some((repo) => resolve(repo.root, 'courses') === dir);
    const cached = persistent ? this.directories.get(dir) : undefined;
    const age = cached ? Date.now() - cached.loadedAt : 0;
    if (cached?.fingerprint === fingerprint && age >= 0 && age < catalogMaxAgeMs) return cached;
    const previousEntries = new Map(cached?.entries.map((entry) => [entry.file, entry]));
    const entries = await Promise.all(metadata.map(async ({ file, sheet }): Promise<CatalogEntry> => {
      let bytes: Buffer;
      try { bytes = await readFile(join(dir, file)); }
      catch (readError) { return { file, sheetDirectory: sheet, raw: undefined, readError, courseError: readError }; }
      const digest = createHash('sha256').update(bytes).digest('hex');
      const previous = previousEntries.get(file);
      if (previous?.digest === digest && previous.sheetDirectory === sheet) return previous;
      let raw: unknown; let syntaxError: SyntaxError | undefined; let validationError: unknown; let course: Course | undefined;
      if (previous?.digest === digest) {
        ({ raw, syntaxError, validationError, course } = previous);
      } else {
        try { raw = JSON.parse(bytes.toString('utf8')); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; syntaxError = error; }
        if (!syntaxError && !isSheet(raw)) {
          try { course = parseCourse(file, raw); } catch (error) { validationError = error; }
        }
      }
      const courseError = sheet ? undefined : syntaxError ?? validationError;
      const id = file.slice(0, -5);
      const isSummary = (isSheet(raw) || (sheet && !course)) && /^[a-z0-9][a-z0-9-]*$/.test(id);
      const title = raw && typeof raw === 'object' && 'title' in raw && typeof raw.title === 'string' && raw.title.trim() ? raw.title : id;
      return { file, sheetDirectory: sheet, digest, raw, syntaxError, validationError, course, courseError, ...(isSummary ? { sheet: { id, title } } : {}) };
    }));
    if (cached && entries.length === cached.entries.length && entries.every((entry, index) => entry === cached.entries[index])) {
      cached.fingerprint = fingerprint; cached.loadedAt = Date.now(); return cached;
    }
    const courses = entries.flatMap((entry) => entry.course ? [entry.course] : []);
    const result = { fingerprint, loadedAt: Date.now(), entries, courses, byId: new Map(courses.map((course) => [course.id, course])), courseError: entries.find((entry) => entry.courseError)?.courseError };
    // Failed course loads are deliberately retried even when metadata has not changed.
    if (generation === this.generation) {
      if (persistent && !entries.some((entry) => entry.courseError || entry.syntaxError)) this.directories.set(dir, result);
      else this.directories.delete(dir);
    }
    return result;
  }

  async all(): Promise<{ courses: Course[]; byId: Map<string, Course> }> {
    const directories = await Promise.all(courseRepos.map((repo) => this.directory(join(repo.root, 'courses'))));
    for (const directory of directories) this.check(directory);
    if (!this.combined || directories.some((directory, index) => this.combined!.directories[index] !== directory) || directories.length !== this.combined.directories.length) {
      const courses = directories.flatMap((directory) => directory.courses);
      const byId = new Map<string, Course>(); for (const course of courses) if (!byId.has(course.id)) byId.set(course.id, course);
      this.combined = { directories, courses, byId };
    }
    return this.combined;
  }

  check(directory: DirectoryCatalog): void { if (directory.courseError) throw directory.courseError; }
}
const catalog = new CourseCatalog();
type DbCatalog = { revision: string; courses: Course[]; byId: Map<string, Course>; sheets: Array<Cheatsheet & { repo: string }> };
let dbCatalog: DbCatalog | undefined;
async function databaseCatalog(): Promise<DbCatalog> {
  const db = await contentDatabase();
  const { value: revision } = db.prepare("SELECT value FROM content_meta WHERE key='revision'").get() as { value: string };
  if (dbCatalog?.revision === revision) return dbCatalog;
  const previousRevision = dbCatalog?.revision;
  const rows = db.prepare('SELECT id, type, namespace_id, manifest_json FROM course WHERE deleted_at IS NULL ORDER BY id').all() as Array<{ id: string; type: string; namespace_id: string; manifest_json: string }>;
  const courses: Course[] = []; const sheets: DbCatalog['sheets'] = [];
  for (const row of rows) {
    const raw: unknown = JSON.parse(row.manifest_json);
    if (row.type === 'cheatsheet') sheets.push({ ...parseCheatsheet(`${row.id}.json`, raw), repo: row.namespace_id });
    else courses.push(parseCourse(`${row.id}.json`, raw));
  }
  const snapshot = dbCatalog = { revision, courses, byId: new Map(courses.map((course) => [course.id, course])), sheets };
  if (previousRevision !== undefined && previousRevision !== revision) notifyCourseCatalogInvalidated();
  return snapshot;
}
const catalogInvalidationListeners = new Set<() => void>();
export function onCourseCatalogInvalidated(listener: () => void): () => void {
  catalogInvalidationListeners.add(listener); return () => { catalogInvalidationListeners.delete(listener); };
}
function notifyCourseCatalogInvalidated(): void {
  for (const listener of catalogInvalidationListeners) try { listener(); } catch (error) { console.error('Course catalog invalidation listener failed', error); }
}
export function invalidateCourseCatalog(): void { catalog.invalidate(); dbCatalog = undefined; notifyCourseCatalogInvalidated(); }
export async function loadCourses(dir?: string): Promise<Course[]> {
  if (!dir) return structuredClone((await (contentSource() === 'db' ? databaseCatalog() : catalog.all())).courses);
  const directory = await catalog.directory(dir); catalog.check(directory); return structuredClone(directory.courses);
}
export async function listCheatsheets(): Promise<Array<{ id: string; title: string; repo: string }>> {
  if (contentSource() === 'db') return (await databaseCatalog()).sheets.map(({ id, title, repo }) => ({ id, title, repo }));
  return (await Promise.all(courseRepos.map(async (repo) => {
    const directory = await catalog.directory(join(repo.root, 'courses'));
    for (const entry of directory.entries) if (entry.readError) throw entry.readError;
    return directory.entries.flatMap((entry) => entry.sheet ? [{ ...entry.sheet, repo: repo.id }] : []);
  }))).flat();
}
export async function loadCheatsheet(id: string): Promise<(Cheatsheet & { repo: string }) | undefined> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return undefined;
  if (contentSource() === 'db') { const sheet = (await databaseCatalog()).sheets.find((item) => item.id === id); return sheet && structuredClone(sheet); }
  const file = `${id}.json`; const found: Array<{ dir: string; entry: CatalogEntry; repo: string }> = [];
  for (const repo of courseRepos) {
    const dir = join(repo.root, 'courses');
    const entry = (await catalog.directory(dir)).entries.find((candidate) => candidate.file === file);
    if (entry?.sheetDirectory) found.push({ dir, entry, repo: repo.id });
  }
  if (found.length > 1) throw new Error(`Duplicate cheatsheet id ${id}`);
  if (!found[0]) return undefined;
  try {
    if (found[0].entry.readError) throw found[0].entry.readError;
    if (found[0].entry.syntaxError) throw new Error(`Invalid cheatsheet ${id}: malformed JSON`);
    return { ...parseCheatsheet(file, found[0].entry.raw), repo: found[0].repo };
  } catch (error) { catalog.evict(found[0].dir); throw error; }
}
export async function loadCourse(courseId: string): Promise<Course | undefined> { const course = (await (contentSource() === 'db' ? databaseCatalog() : catalog.all())).byId.get(courseId); return course && structuredClone(course); }
export async function loadCourseHints(courseId: string, dir?: string, revision?: number): Promise<CourseHints | undefined> {
  if (!/^[a-z0-9-]+$/.test(courseId)) return undefined;
  const file = `${courseId}.hints.json`; let raw: unknown; let removedIds = new Set<string>();
  let course: Course | undefined;
  if (!dir && contentSource() === 'db') {
    const db = await contentDatabase();
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Invalid content revision');
    const row = (revision === undefined ? db.prepare('SELECT r.bundle_json FROM course c JOIN course_revision r ON r.course_id=c.id AND r.revision=c.revision WHERE c.id=? AND c.deleted_at IS NULL').get(courseId) : db.prepare('SELECT bundle_json FROM course_revision WHERE course_id=? AND revision=?').get(courseId, revision)) as { bundle_json: string } | undefined;
    if (revision !== undefined && !row) throw new Error(`Unknown content revision: ${courseId}/${revision}`);
    const bundle = row && JSON.parse(row.bundle_json) as { hints?: unknown; manifest: unknown } | undefined;
    raw = bundle?.hints;
    if (raw === undefined) return undefined;
    if (revision === undefined) course = (await databaseCatalog()).byId.get(courseId);
    else ({ course, removedIds } = parseHistoricalCourse(`${courseId}@${revision}`, bundle!.manifest));
  } else {
    dir ??= join(requireRepoForCourse(courseId).root, 'courses');
    try { raw = JSON.parse(await readFile(join(dir, file), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(file, 'root'); const root = raw as Record<string, unknown>;
  unknownFields(root, new Set(['courseId', 'drills']), file, 'root'); if (root.courseId !== courseId || !root.drills || typeof root.drills !== 'object' || Array.isArray(root.drills)) invalid(file, 'courseId/drills');
  if (dir) { const directory = await catalog.directory(dir); catalog.check(directory); course = directory.byId.get(courseId); }
  if (!course) invalid(file, 'unknown course');
  const expected = new Map(course.chapters.flatMap((chapter) => chapter.drills).map((drill) => [drill.id, [...drill.instructions.matchAll(/^## (Milestone[^\n]*)/gm)].map((match) => match[1])]));
  const drills: Record<string, MilestoneHint[]> = {};
  for (const [drillId, value] of Object.entries(root.drills as Record<string, unknown>)) {
    if (removedIds.has(drillId)) continue;
    const milestones = expected.get(drillId); if (!milestones || !Array.isArray(value)) invalid(file, `drills.${drillId}`);
    const seen = new Set<string>(); drills[drillId] = value.map((item, index) => {
      if (!item || typeof item !== 'object') invalid(file, `drills.${drillId}[${index}]`); const hint = item as Record<string, unknown>;
      unknownFields(hint, new Set(['title', 'approach', 'solution']), file, `drills.${drillId}[${index}]`);
      const result = { title: stringField(hint.title, file, 'hint.title'), approach: stringField(hint.approach, file, 'hint.approach'), solution: stringField(hint.solution, file, 'hint.solution') };
      if (!milestones.includes(result.title) || seen.has(result.title)) invalid(file, `drills.${drillId}[${index}].title`); seen.add(result.title); return result;
    });
    if (milestones.some((title) => !seen.has(title))) invalid(file, `drills.${drillId}: missing milestone hint`);
  }
  for (const [drillId, milestones] of expected) if (milestones.length && !drills[drillId]) invalid(file, `drills.${drillId}: missing milestone hints`);
  return { courseId, drills };
}
export function loadCourseHintsAtRevision(courseId: string, revision?: number): Promise<CourseHints | undefined> { return loadCourseHints(courseId, undefined, revision); }
export function drillInCourse(course: Course, drillId: string): Drill | undefined { return course.chapters.flatMap((chapter) => chapter.drills).find((drill) => drill.id === drillId); }
export function chapterDrillIds(course: Course, chapterId: string): string[] | undefined { return course.chapters.find((chapter) => chapter.id === chapterId)?.drills.map((drill) => drill.id); }
