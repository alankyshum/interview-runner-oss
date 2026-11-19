import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheatsheet, parseCourse, type Course, type Cheatsheet } from '../../shared/courseSchema';
import { invalidateCourseCatalog, loadCourseHints } from '../courses';
import type { Missing } from '../../scripts/validate-course-paths';
import { checkBundlePath, imageReferences, sha256, writeBundleToDirectory, type BlobSource, type CourseBundle } from './bundle';
import { ContentValidationError } from './errors';
import type { ContentDb } from './contentDb';
import { assetText } from './assetIndex';

export { ContentValidationError } from './errors';
export class ContentConflictError extends Error { constructor() { super('Content revision conflict'); } }

export function validationIssue(error: unknown): { field: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const field = /^Invalid course manifest [^:]+: ([\s\S]+)$/.exec(message)?.[1] ?? 'bundle';
  return { field, message };
}

export function blobsMissing(db: ContentDb, hashes: string[]): string[] {
  const query = db.prepare('SELECT 1 FROM blob WHERE sha256 = ?');
  return hashes.filter((hash) => !query.get(hash));
}
export function putBlob(db: ContentDb, bytes: Uint8Array, expectedSha256?: string): string {
  const hash = sha256(bytes);
  if (expectedSha256 !== undefined && hash !== expectedSha256) throw new ContentValidationError([{ field: 'sha256', message: 'Blob hash does not match' }]);
  db.prepare('INSERT OR IGNORE INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, new Date().toISOString());
  return hash;
}
export function getCourseBundle(db: ContentDb, courseId: string, revision?: number): CourseBundle | undefined {
  const row = (revision === undefined
    ? db.prepare('SELECT r.bundle_json FROM course c JOIN course_revision r ON r.course_id=c.id AND r.revision=c.revision WHERE c.id=? AND c.deleted_at IS NULL').get(courseId)
    : db.prepare('SELECT bundle_json FROM course_revision WHERE course_id=? AND revision=?').get(courseId, revision)) as { bundle_json: string } | undefined;
  return row ? JSON.parse(row.bundle_json) as CourseBundle : undefined;
}
export function listCourses(db: ContentDb, options: { namespace?: string } = {}): unknown[] {
  return options.namespace === undefined ? db.prepare('SELECT * FROM course WHERE deleted_at IS NULL ORDER BY id').all() : db.prepare('SELECT * FROM course WHERE deleted_at IS NULL AND namespace_id=? ORDER BY id').all(options.namespace);
}
export function deleteCourse(db: ContentDb, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare('UPDATE course SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(new Date().toISOString(), id) as { changes: number | bigint };
    if (Number(result.changes)) db.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    db.exec('COMMIT'); invalidateCourseCatalog();
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function putCourseBundle(db: ContentDb, bundle: CourseBundle, blobs: BlobSource, options: { namespace: string; actorUserId?: string; actorApiKeyId?: string; expectedRevision?: number; message?: string }): Promise<number> {
  const [{ findMissingPaths }, { findTestQualityIssues }, { findCodingExampleIssues }] = await Promise.all([import('../../scripts/validate-course-paths'), import('../../scripts/validate-course-tests'), import('../../scripts/coding-examples')]);
  let manifest: Course | Cheatsheet;
  const available = new Map<string, Uint8Array>();
  try {
    if (!options.namespace.trim()) throw new Error('Namespace is required');
    const raw = bundle.manifest as Record<string, unknown> | null;
    manifest = raw?.type === 'cheatsheet' ? parseCheatsheet('bundle', raw) : parseCourse('bundle', raw);
    const fileIssues: Array<{ field: string; message: string }> = [];
    for (const [path, file] of Object.entries(bundle.files)) {
      try { checkBundlePath(path); } catch { fileIssues.push({ field: path, message: `Invalid bundle path: ${path}` }); continue; }
      if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777))) { fileIssues.push({ field: path, message: `Invalid file metadata: ${path}` }); continue; }
      const stored = db.prepare('SELECT bytes FROM blob WHERE sha256=?').get(file.sha256) as { bytes: Uint8Array } | undefined;
      const bytes = blobs.get(file.sha256) ?? stored?.bytes;
      if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256) { fileIssues.push({ field: path, message: `Missing or invalid blob: ${path}` }); continue; }
      available.set(file.sha256, bytes);
    }
    if (fileIssues.length) throw new ContentValidationError(fileIssues);
    const manifestFile = bundle.files[`courses/${manifest.id}.json`];
    if (!manifestFile || JSON.stringify(JSON.parse(Buffer.from(available.get(manifestFile.sha256)!).toString('utf8'))) !== JSON.stringify(bundle.manifest)) throw new Error('Manifest file does not match bundle manifest');
    const hintsFile = bundle.files[`courses/${manifest.id}.hints.json`];
    if (Boolean(hintsFile) !== (bundle.hints !== undefined) || (hintsFile && JSON.stringify(JSON.parse(Buffer.from(available.get(hintsFile.sha256)!).toString('utf8'))) !== JSON.stringify(bundle.hints))) throw new Error('Hints file does not match bundle hints');
    const issues: Array<{ field: string; message: string }> = [];
    for (const [path, file] of Object.entries(bundle.files)) {
      if (path.startsWith('images/')) continue;
      for (const image of imageReferences(available.get(file.sha256)!)) {
        try { checkBundlePath(image); } catch { issues.push({ field: path, message: `Invalid image path: ${image}` }); continue; }
        if (!Object.hasOwn(bundle.files, image)) issues.push({ field: path, message: `Missing referenced image: ${image}` });
      }
    }
    const temp = await mkdtemp(join(tmpdir(), 'content-validate-'));
    try {
      await writeBundleToDirectory(bundle, available, temp);
      const dir = join(temp, 'courses');
      if (bundle.hints !== undefined) try { await loadCourseHints(manifest.id, dir); } catch (error) { issues.push(validationIssue(error)); }
      let missing: Missing[] = [];
      let pathsValid = true;
      try { missing = await findMissingPaths(dir); } catch (error) { pathsValid = false; issues.push(validationIssue(error)); }
      for (const item of missing) {
        const ci = manifest.chapters.findIndex((chapter) => chapter.id === item.chapterId);
        const di = manifest.chapters[ci]?.drills.findIndex((drill) => drill.id === item.drillId) ?? -1;
        issues.push({ field: `chapters[${ci}].drills[${di}].${item.field}`, message: `Missing ${item.path}` });
      }
      // Access-based directory validation can mistake a directory for a referenced file.
      for (const [ci, chapter] of manifest.chapters.entries()) for (const [di, lesson] of chapter.drills.entries()) {
        const drill = lesson as unknown as Record<string, unknown>;
        const paths: Array<[string, unknown, boolean]> = [['sourcePath', drill.sourcePath, false], ['testPath', drill.testPath, false], ['outlinePath', drill.outlinePath, false], ['scaffold.seedPath', (drill.scaffold as { seedPath?: string } | undefined)?.seedPath, false], ['evaluation.rubricPath', (drill.evaluation as { rubricPath?: string } | undefined)?.rubricPath, false], ['handoffPath', drill.handoffPath, false], ['rubricPath', drill.rubricPath, false], ['workspacePath', drill.workspacePath, true], ['acceptancePath', drill.acceptancePath, true]];
        for (const [name, path, directory] of paths) if (typeof path === 'string' && !(directory ? Object.keys(bundle.files).some((file) => file.startsWith(`${path}/`)) : Object.hasOwn(bundle.files, path))) {
          const field = `chapters[${ci}].drills[${di}].${name}`;
          if (!issues.some((issue) => issue.field === field)) issues.push({ field, message: `Missing ${path}` });
        }
      }
      if (pathsValid && !issues.some((issue) => issue.field.startsWith('chapters['))) {
        const quality = await findTestQualityIssues(dir);
        issues.push(...quality.findings.map((item) => ({ field: item.testPath, message: item.issue })));
      }
      if (!issues.length && manifest.type !== 'cheatsheet') {
        const examples = await findCodingExampleIssues(dir, [manifest.id]);
        issues.push(...examples.map(({ field, message }) => ({ field, message })));
      }
      if (issues.length) throw new ContentValidationError(issues);
    } finally { await rm(temp, { recursive: true, force: true }); }
  } catch (error) {
    if (error instanceof ContentValidationError) throw error;
    throw new ContentValidationError([validationIssue(error)]);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT revision,namespace_id FROM course WHERE id=?').get(manifest.id) as { revision: number; namespace_id: string } | undefined;
    if (options.expectedRevision !== undefined && options.expectedRevision !== (current?.revision ?? 0)) throw new ContentConflictError();
    if (current && current.namespace_id !== options.namespace) throw new ContentConflictError();
    const revision = (current?.revision ?? 0) + 1; const now = new Date().toISOString();
    const course = manifest as Course; const raw = bundle.manifest as Record<string, unknown>;
    db.prepare(`INSERT INTO course(id,namespace_id,type,title,company,tier,role,interview_date,deadline,tags_json,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,title=excluded.title,company=excluded.company,tier=excluded.tier,role=excluded.role,interview_date=excluded.interview_date,deadline=excluded.deadline,tags_json=excluded.tags_json,updated_at=excluded.updated_at,revision=excluded.revision,deleted_at=NULL,manifest_json=excluded.manifest_json`).run(manifest.id, options.namespace, manifest.type ?? 'course', manifest.title, course.company ?? null, course.tier ?? null, course.role ?? null, course.interviewDate ?? null, course.deadline ?? null, course.tags ? JSON.stringify(course.tags) : null, course.createdAt ?? now, course.updatedAt ?? now, revision, JSON.stringify(raw));
    db.prepare('DELETE FROM chapter WHERE course_id=?').run(manifest.id);
    db.prepare('DELETE FROM lesson_file WHERE course_id=?').run(manifest.id);
    db.prepare('DELETE FROM asset_fts WHERE course_id=?').run(manifest.id);
    const fileRoles = new Map<string, Array<{ lesson: string; role: string }>>();
    const associate = (path: string, lesson: string, role: string): void => {
      const associations = fileRoles.get(path) ?? [];
      if (!associations.some((item) => item.lesson === lesson)) associations.push({ lesson, role });
      fileRoles.set(path, associations);
    };
    for (const [position, chapter] of manifest.chapters.entries()) {
      db.prepare('INSERT INTO chapter VALUES(?,?,?,?)').run(manifest.id, chapter.id, position, chapter.title);
      for (const [index, lesson] of chapter.drills.entries()) {
        const drill = lesson as unknown as Record<string, unknown>;
        const rawChapter = (raw.chapters as Array<{ drills: Array<Record<string, unknown>> }>)[position]!;
        const remaining = { ...rawChapter.drills[index]! };
        for (const field of ['id', 'title', 'contentType', 'kind', 'estMinutes', 'instructions']) delete remaining[field];
        db.prepare('INSERT INTO lesson VALUES(?,?,?,?,?,?,?,?,?,?)').run(manifest.id, lesson.id, chapter.id, index, lesson.title, lesson.contentType, drill.kind ?? null, drill.estMinutes ?? null, drill.instructions ?? '', JSON.stringify(remaining));
        const paths: Array<[unknown, string]> = [[drill.sourcePath, lesson.contentType === 'map' ? 'mindmap' : lesson.contentType === 'recall' || lesson.contentType === 'whiteboard' ? 'recall' : lesson.contentType === 'cheatsheet' ? 'section' : 'source'], [drill.testPath, 'test'], [drill.outlinePath, 'outline'], [(drill.scaffold as { seedPath?: string } | undefined)?.seedPath, 'seed'], [(drill.evaluation as { rubricPath?: string } | undefined)?.rubricPath, 'rubric'], [drill.handoffPath, 'handoff'], [drill.rubricPath, 'rubric']];
        for (const [path, role] of paths) if (typeof path === 'string') associate(path, lesson.id, role);
        for (const field of ['workspacePath', 'acceptancePath']) if (typeof drill[field] === 'string') for (const path of Object.keys(bundle.files)) if (path.startsWith(`${drill[field]}/`)) associate(path, lesson.id, field === 'workspacePath' ? 'workspace' : 'test');
      }
    }
    for (const [path, file] of Object.entries(bundle.files)) {
      const bytes = available.get(file.sha256)!; putBlob(db, bytes, file.sha256);
      const roles = fileRoles.get(path) ?? [{ lesson: null, role: path.endsWith('.hints.json') ? 'hints' : path.startsWith('images/') ? 'image' : path.startsWith('outlines/') ? 'outline' : path.startsWith('mindmaps/') ? 'mindmap' : path.startsWith('recall/') ? 'recall' : path.startsWith('cheatsheets/') ? 'section' : 'source' }];
      for (const role of roles) db.prepare('INSERT INTO lesson_file VALUES(?,?,?,?,?,?)').run(manifest.id, role.lesson, path, role.role, file.sha256, file.mode ?? null);
      if (roles.some(({ role }) => ['outline', 'mindmap', 'recall', 'section', 'hints'].includes(role))) { const text = assetText(path, bytes); if (text !== undefined) db.prepare('INSERT INTO asset_fts(course_id,path,text) VALUES(?,?,?)').run(manifest.id, path, text); }
    }
    db.prepare('INSERT INTO course_revision VALUES(?,?,?,?,?,?,?)').run(manifest.id, revision, JSON.stringify(bundle), options.actorUserId ?? null, options.actorApiKeyId ?? null, options.message ?? null, now);
    db.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    db.exec('COMMIT'); invalidateCourseCatalog(); return revision;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
