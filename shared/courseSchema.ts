import { isLegacyReading } from './legacyReading';

/** Version is recorded once per content repository in interview-courses.json. */
export const COURSE_SCHEMA_VERSION = 2;

export function readCourseSchemaVersion(marker: unknown): number {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
      !('kind' in marker) || marker.kind !== 'interview-runner-courses' ||
      !('runner' in marker) || typeof marker.runner !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(marker.runner) ||
      !('schema' in marker) || typeof marker.schema !== 'number' || !Number.isSafeInteger(marker.schema) || marker.schema < 1) {
    throw new Error('interview-courses.json: invalid course repository marker or schema version');
  }
  return marker.schema;
}

/** Schema 2 retired UI drills. They cannot be converted without rewriting the exercise and tests. */
export const upcasters: Record<number, (manifest: unknown) => unknown> = {
  1: (manifest) => {
    if (manifest && typeof manifest === 'object' && 'chapters' in manifest && Array.isArray(manifest.chapters)) {
      for (const chapter of manifest.chapters) if (chapter && typeof chapter === 'object' && Array.isArray(chapter.drills)) {
        for (const drill of chapter.drills) if (drill && typeof drill === 'object' && drill.kind === 'ui') {
          throw new Error(`${String(drill.id ?? 'drill')}.kind: UI drills were removed in schema v2; manually replace the exercise and tests before migrating`);
        }
      }
    }
    return manifest;
  },
};

export function upcastCourse(value: unknown, fromVersion: number): unknown {
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 1) throw new Error(`unknown course schema version ${fromVersion}; expected v1 or newer`);
  if (fromVersion > COURSE_SCHEMA_VERSION) throw new Error(`course schema v${fromVersion} is newer than this runner supports (v${COURSE_SCHEMA_VERSION}); upgrade the stack`);
  let result = value;
  for (let version = fromVersion; version < COURSE_SCHEMA_VERSION; version++) {
    const upcast = upcasters[version];
    if (!upcast) throw new Error(`no course schema upcaster from v${version} to v${version + 1}`);
    result = upcast(result);
  }
  return result;
}

/** Browser-safe contract shared by the authoring tools, API and course UI. */
export type LibraryKind = 'course' | 'cheatsheet';
export type ContentType = 'reading' | 'coding' | 'ai-coding' | 'cheatsheet' | 'map' | 'recall' | 'whiteboard';
export type DrillKind = 'logic' | 'scratch';
export type DrillScaffold = { seedPath: string };
export type StageUnlock = { mode: 'manual' } | { mode: 'timer'; minutes: number[] };
type LessonBase = { id: string; title: string; kind: DrillKind; estMinutes: number; sourcePath: string; instructions: string; scaffold?: DrillScaffold };
export type Drill = LessonBase & (
  | { contentType: 'reading'; outlinePath: string; testPath?: never; evaluation?: never }
  | { contentType: 'coding'; testPath: string; outlinePath?: never; evaluation?: never }
  | { contentType: 'ai-coding'; workspacePath: string; testRunner: 'vitest' | 'pytest'; handoffPath: string; rubricPath: string; stageUnlock: StageUnlock; acceptancePath?: string; testPath?: never; outlinePath?: never; evaluation?: never }
  | { contentType: 'map'; testPath?: never; outlinePath?: never; evaluation?: never }
  | { contentType: 'recall'; whiteboard?: boolean; testPath?: never; outlinePath?: never; evaluation?: never }
  | { contentType: 'whiteboard'; testPath?: never; outlinePath?: never; evaluation?: never }
);
export function isWhiteboardDrill(drill: Drill | undefined): boolean { return drill?.contentType === 'whiteboard' || (drill?.contentType === 'recall' && drill.whiteboard === true); }
export type Chapter = { id: string; title: string; drills: Drill[] };
export type Course = { type?: 'map-recall'; book?: true; id: string; title: string; company?: string; tier?: 1 | 2 | 3; role?: string; interviewDate?: string; deadline?: string; createdAt?: string; updatedAt?: string; tags?: string[]; chapters: Chapter[] };
export type CheatsheetLesson = { id: string; title: string; contentType: 'cheatsheet'; headingLevel: number; sourcePath: string; anchors?: string[]; mindmapPath?: string };
export type Lesson = Drill | CheatsheetLesson;
export type CheatsheetChapter = { id: string; title: string; drills: CheatsheetLesson[] };
export type Cheatsheet = { type: 'cheatsheet'; id: string; title: string; chapters: CheatsheetChapter[] };

export function invalid(file: string, field: string): never { throw new Error(`Invalid course manifest ${file}: ${field}`); }
export function stringField(value: unknown, file: string, field: string): string { if (typeof value !== 'string' || !value.trim()) invalid(file, field); return value; }
export function unknownFields(value: Record<string, unknown>, allowed: Set<string>, file: string, field: string): void { for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(file, `${field}: unknown field "${key}"`); }
export function safePath(file: string, path: string, field: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '..' || part === '.')) invalid(file, field);
}
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('tags must be an array of strings');
  if (value.length > 20) throw new Error('tags may contain at most 20 items');
  const tags: string[] = []; const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('tags: each value must be a string');
    const tag = raw.trim();
    if (tag.length < 1 || tag.length > 40 || /[\u0000-\u001f\u007f]/.test(tag)) throw new Error('tags: each tag must be 1–40 characters and contain no control characters');
    const key = tag.toLocaleLowerCase(); if (!seen.has(key)) { tags.push(tag); seen.add(key); }
  }
  return tags;
}
function record(value: unknown, file: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, field);
  return value as Record<string, unknown>;
}
function identifier(value: unknown, file: string, field: string): string {
  const id = stringField(value, file, field); if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) invalid(file, field); return id;
}
function pathField(value: unknown, file: string, field: string): string { const path = stringField(value, file, field); safePath(file, path, field); return path; }

/** Report every removed drill shape so catalog preflight can enumerate all blockers. */
export function removedDrillErrors(drill: Record<string, unknown>, id: string): string[] {
  const errors: string[] = [];
  if (Object.hasOwn(drill, 'evaluation')) errors.push(`${id}.evaluation is no longer supported; use deterministic coding tests or a reading outline`);
  if (drill.contentType === 'reading' && drill.outlinePath === undefined) errors.push(`${id}.outlinePath is required for reading lessons`);
  return errors;
}

export function parseCheatsheet(file: string, value: unknown): Cheatsheet {
  const root = record(value, file, 'root');
  unknownFields(root, new Set(['type', 'id', 'title', 'chapters']), file, 'root');
  if (root.type !== 'cheatsheet') invalid(file, 'type');
  const id = identifier(root.id, file, 'id');
  if (file.endsWith('.json') && file.slice(0, -5) !== id) invalid(file, `id ("${id}") must match the filename "${file}"`);
  if (!Array.isArray(root.chapters) || root.chapters.length === 0) invalid(file, 'chapters');
  const chapterIds = new Set<string>(); const lessonIds = new Set<string>();
  const chapters = root.chapters.map((raw, index): CheatsheetChapter => {
    const chapter = record(raw, file, `chapters[${index}]`);
    unknownFields(chapter, new Set(['id', 'title', 'drills']), file, `chapters[${index}]`);
    const chapterId = identifier(chapter.id, file, 'chapter.id');
    if (chapterIds.has(chapterId)) invalid(file, `duplicate chapter id ${chapterId}`); chapterIds.add(chapterId);
    if (!Array.isArray(chapter.drills) || chapter.drills.length === 0) invalid(file, 'chapter.drills');
    const drills = chapter.drills.map((rawLesson): CheatsheetLesson => {
      const lesson = record(rawLesson, file, 'drill');
      unknownFields(lesson, new Set(['id', 'title', 'contentType', 'headingLevel', 'sourcePath', 'anchors', 'mindmapPath']), file, 'drill');
      const lessonId = identifier(lesson.id, file, 'drill.id');
      if (lessonIds.has(lessonId)) invalid(file, `duplicate drill id ${lessonId}`); lessonIds.add(lessonId);
      if (lesson.contentType !== 'cheatsheet') invalid(file, `${lessonId}.contentType must be cheatsheet`);
      if (typeof lesson.headingLevel !== 'number' || !Number.isInteger(lesson.headingLevel) || lesson.headingLevel < 1 || lesson.headingLevel > 6) invalid(file, `${lessonId}.headingLevel`);
      const sourcePath = pathField(lesson.sourcePath, file, `${lessonId}.sourcePath`);
      if (sourcePath !== `cheatsheets/${id}/sections/${lessonId}.html`) invalid(file, `${lessonId}.sourcePath must match the cheatsheet and lesson ids`);
      const mindmapPath = lesson.mindmapPath === undefined ? undefined : pathField(lesson.mindmapPath, file, `${lessonId}.mindmapPath`);
      if (mindmapPath !== undefined && !new RegExp(`^cheatsheets/${id}/diagrams/mindmaps/[a-zA-Z0-9][a-zA-Z0-9_-]*\\.md$`).test(mindmapPath)) invalid(file, `${lessonId}.mindmapPath must be a same-cheatsheet mind map`);
      if (lesson.anchors !== undefined && (!Array.isArray(lesson.anchors) || lesson.anchors.some((anchor) => typeof anchor !== 'string' || !anchor || anchor.length > 300 || /[\s\u0000-\u001f\u007f]/.test(anchor)) || new Set(lesson.anchors).size !== lesson.anchors.length)) invalid(file, `${lessonId}.anchors`);
      return { id: lessonId, title: stringField(lesson.title, file, 'drill.title'), contentType: 'cheatsheet', headingLevel: lesson.headingLevel, sourcePath, ...(lesson.anchors ? { anchors: lesson.anchors as string[] } : {}), ...(mindmapPath ? { mindmapPath } : {}) };
    });
    return { id: chapterId, title: stringField(chapter.title, file, 'chapter.title'), drills };
  });
  return { type: 'cheatsheet', id, title: stringField(root.title, file, 'title'), chapters };
}

export function parseDeadline(value: unknown, file = 'course'): string {
  const text = typeof value === 'string' ? value : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(text);
  if (!match) invalid(file, 'deadline');
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (m < 1 || m > 12 || d < 1 || d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!) invalid(file, 'deadline');
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || (second !== undefined && Number(second) > 59) || (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59)) || !Number.isFinite(Date.parse(text)))) invalid(file, 'deadline');
  return text;
}

export function parseCourse(file: string, value: unknown, requirePathPrefix = true): Course {
  const root = record(value, file, 'root');
  unknownFields(root, new Set(['type', 'book', 'id', 'title', 'company', 'tier', 'role', 'interviewDate', 'deadline', 'createdAt', 'updatedAt', 'tags', 'chapters']), file, 'root');
  if (root.type !== undefined && root.type !== 'map-recall') invalid(file, 'type');
  if (root.book !== undefined && root.book !== true) invalid(file, 'book must be true when present');
  const id = identifier(root.id, file, 'id'); const title = stringField(root.title, file, 'title');
  const coursePath = (path: string, field: string) => { if (requirePathPrefix && path.split('/')[1] !== id) invalid(file, `${field} must look like <dir>/${id}/…`); return path; };
  if (file.endsWith('.json') && file.slice(0, -5) !== id) invalid(file, `id ("${id}") must match the filename "${file}"`);
  if (!Array.isArray(root.chapters)) invalid(file, 'chapters');
  const chapterIds = new Set<string>(); const drillIds = new Set<string>();
  const chapters = root.chapters.map((raw, ci): Chapter => {
    const c = record(raw, file, `chapters[${ci}]`);
    unknownFields(c, new Set(['id', 'title', 'drills']), file, `chapters[${ci}]`);
    const chapterId = identifier(c.id, file, 'chapter.id');
    if (chapterIds.has(chapterId)) invalid(file, `duplicate chapter id ${chapterId}`); chapterIds.add(chapterId);
    if (!Array.isArray(c.drills)) invalid(file, 'chapter.drills');
    const drills = c.drills.map((rawDrill): Drill => {
      const d = record(rawDrill, file, 'drill');
      const drillId = identifier(d.id, file, 'drill.id');
      if (drillIds.has(drillId)) invalid(file, `duplicate drill id ${drillId}`); drillIds.add(drillId);
      if (d.contentType === 'reading' && !isLegacyReading(id, drillId)) invalid(file, `${drillId}: reading is deprecated; use contentType: "map" with a mindmaps/<course-id>/<drill-id>.md source`);
      unknownFields(d, new Set(['id', 'title', 'contentType', 'outlinePath', 'kind', 'estMinutes', 'sourcePath', 'testPath', 'instructions', 'scaffold', 'evaluation', 'workspacePath', 'testRunner', 'handoffPath', 'rubricPath', 'stageUnlock', 'acceptancePath', 'whiteboard']), file, 'drill');
      if (d.contentType !== 'reading' && d.contentType !== 'coding' && d.contentType !== 'ai-coding' && d.contentType !== 'map' && d.contentType !== 'recall' && d.contentType !== 'whiteboard') invalid(file, `${drillId}.contentType must be reading, coding, ai-coding, map, recall, or whiteboard`);
      const removed = removedDrillErrors(d, drillId); if (removed.length) invalid(file, removed[0]!);
      if ((root.type === 'map-recall' && d.contentType !== 'map' && d.contentType !== 'recall' && d.contentType !== 'whiteboard') || (root.type !== 'map-recall' && d.contentType === 'recall' && d.whiteboard !== true)) invalid(file, `${drillId}: lesson type must match course type`);
      if (d.kind !== 'logic' && d.kind !== 'scratch') invalid(file, `${drillId}.kind`);
      if (typeof d.estMinutes !== 'number' || !Number.isFinite(d.estMinutes) || d.estMinutes < 0) invalid(file, `${drillId}.estMinutes`);
      const base: LessonBase = { id: drillId, title: stringField(d.title, file, 'drill.title'), kind: d.kind, estMinutes: d.estMinutes, sourcePath: coursePath(pathField(d.sourcePath, file, 'drill.sourcePath'), 'drill.sourcePath'), instructions: stringField(d.instructions, file, 'drill.instructions') };
      if (d.contentType === 'map' || d.contentType === 'recall' || d.contentType === 'whiteboard') {
        unknownFields(d, new Set(['id', 'title', 'contentType', 'kind', 'estMinutes', 'sourcePath', 'instructions', ...(d.contentType === 'recall' ? ['whiteboard'] : [])]), file, 'drill');
        if (d.kind !== 'scratch') invalid(file, `${drillId}.kind must be scratch`);
        const expected = d.contentType === 'map' ? `mindmaps/${id}/${drillId}.md` : `recall/${id}/${drillId}.json`;
        if (base.sourcePath !== expected) invalid(file, `${drillId}.sourcePath must be ${expected}`);
        if (d.contentType === 'recall') {
          if (d.whiteboard !== undefined && typeof d.whiteboard !== 'boolean') invalid(file, `${drillId}.whiteboard must be a boolean`);
          return { ...base, contentType: 'recall', ...(d.whiteboard === undefined ? {} : { whiteboard: d.whiteboard }) };
        }
        if (d.contentType === 'whiteboard') return { ...base, contentType: 'whiteboard' };
        return { ...base, contentType: 'map' };
      }
      if (d.whiteboard !== undefined) invalid(file, `${drillId}.whiteboard is only allowed on recall lessons`);
      if (d.stageUnlock !== undefined && d.contentType !== 'ai-coding') invalid(file, `${drillId}.stageUnlock is only allowed on ai-coding lessons`);
      if (d.scaffold !== undefined) {
        const s = record(d.scaffold, file, 'drill.scaffold'); unknownFields(s, new Set(['seedPath']), file, 'drill.scaffold');
        const seedPath = coursePath(pathField(s.seedPath, file, 'drill.scaffold.seedPath'), 'drill.scaffold.seedPath');
        if (seedPath !== base.sourcePath.replace(/(\.[^/.]+)$/, '.seed$1')) invalid(file, 'drill.scaffold.seedPath');
        base.scaffold = { seedPath };
      }
      if (d.contentType === 'coding') {
        if (d.outlinePath !== undefined) invalid(file, `${drillId}: coding cannot declare outlinePath`);
        const testPath = coursePath(pathField(d.testPath, file, `${drillId}.testPath`), `${drillId}.testPath`);
        const python = base.sourcePath.endsWith('.py');
        if (python) {
          const stem = drillId.replaceAll('-', '_');
          if (d.kind !== 'logic' || base.sourcePath !== `drills/${id}/${drillId}/${stem}.py`) invalid(file, `${drillId}: Python coding source must be drills/${id}/${drillId}/${stem}.py`);
          if (testPath !== `drills/${id}/${drillId}/test_${stem}.py`) invalid(file, `${drillId}.testPath must be test_${stem}.py beside the source`);
        } else {
          if (!/\.test\.tsx?$/.test(testPath)) invalid(file, `${drillId}.testPath must be a .test.ts or .test.tsx file`);
          if (d.kind !== 'logic' || !/\.ts$/.test(base.sourcePath)) invalid(file, `${drillId}: coding requires logic/.ts or logic/.py`);
        }
        return { ...base, contentType: 'coding', testPath };
      }
      if (d.contentType === 'ai-coding') {
        if (d.kind !== 'logic') invalid(file, `${drillId}: ai-coding requires logic kind`);
        if (d.testPath !== undefined || d.outlinePath !== undefined || d.scaffold !== undefined) invalid(file, `${drillId}: ai-coding cannot declare testPath, outlinePath, or scaffold`);
        const workspacePath = coursePath(pathField(d.workspacePath, file, `${drillId}.workspacePath`), `${drillId}.workspacePath`);
        if (workspacePath !== `drills/${id}/${drillId}/workspace`) invalid(file, `${drillId}.workspacePath must be drills/${id}/${drillId}/workspace`);
        if (!base.sourcePath.startsWith(`${workspacePath}/`)) invalid(file, `${drillId}.sourcePath must be under workspacePath`);
        if (d.testRunner !== 'vitest' && d.testRunner !== 'pytest') invalid(file, `${drillId}.testRunner`);
        const handoffPath = coursePath(pathField(d.handoffPath, file, `${drillId}.handoffPath`), `${drillId}.handoffPath`);
        const rubricPath = coursePath(pathField(d.rubricPath, file, `${drillId}.rubricPath`), `${drillId}.rubricPath`);
        if (!handoffPath.endsWith('.md')) invalid(file, `${drillId}.handoffPath must be a .md file`);
        if (!rubricPath.endsWith('.md')) invalid(file, `${drillId}.rubricPath must be a .md file`);
        const acceptancePath = d.acceptancePath === undefined ? undefined : coursePath(pathField(d.acceptancePath, file, `${drillId}.acceptancePath`), `${drillId}.acceptancePath`);
        if (acceptancePath !== undefined && acceptancePath !== `drills/${id}/${drillId}/acceptance`) invalid(file, `${drillId}.acceptancePath must be drills/${id}/${drillId}/acceptance`);
        const stages = [...base.instructions.matchAll(/^## Milestone(?:\s|$)/gm)].length;
        if (stages < (requirePathPrefix ? 2 : 1)) invalid(file, `${drillId}.instructions must contain at least ${requirePathPrefix ? 'two' : 'one'} ## Milestone headings`);
        let stageUnlock: StageUnlock = { mode: 'manual' };
        if (d.stageUnlock !== undefined) {
          const unlock = record(d.stageUnlock, file, `${drillId}.stageUnlock`);
          if (unlock.mode === 'manual') {
            unknownFields(unlock, new Set(['mode']), file, `${drillId}.stageUnlock`);
          } else if (unlock.mode === 'timer') {
            unknownFields(unlock, new Set(['mode', 'minutes']), file, `${drillId}.stageUnlock`);
            if (!Array.isArray(unlock.minutes) || (requirePathPrefix && unlock.minutes.length !== stages - 1) || unlock.minutes.some((minute) => typeof minute !== 'number' || !Number.isFinite(minute) || minute <= 0 || minute >= base.estMinutes)) invalid(file, `${drillId}.stageUnlock.minutes`);
            const minutes = unlock.minutes as number[];
            if (minutes.some((minute, index) => index > 0 && minute <= minutes[index - 1])) invalid(file, `${drillId}.stageUnlock.minutes must be strictly increasing`);
            stageUnlock = { mode: 'timer', minutes };
          } else invalid(file, `${drillId}.stageUnlock.mode`);
        }
        return { ...base, contentType: 'ai-coding', workspacePath, testRunner: d.testRunner, handoffPath, rubricPath, stageUnlock, ...(acceptancePath ? { acceptancePath } : {}) };
      }
      if (d.testPath !== undefined) invalid(file, `${drillId}: testPath is not allowed for reading`);
      const outlinePath = coursePath(pathField(d.outlinePath, file, `${drillId}.outlinePath`), `${drillId}.outlinePath`);
      if (outlinePath !== `outlines/${id}/${drillId}.json`) invalid(file, `${drillId}.outlinePath must match course and lesson ids`);
      return { ...base, contentType: 'reading', outlinePath };
    });
    return { id: chapterId, title: stringField(c.title, file, 'chapter.title'), drills };
  });
  if (root.type === 'map-recall') {
    const lessons = chapters.flatMap((chapter) => chapter.drills);
    if (lessons[0]?.contentType !== 'map') invalid(file, 'map-recall requires a map as its first lesson');
  }
  const course: Course = { id, title, chapters, ...(root.type === 'map-recall' ? { type: 'map-recall' as const } : {}), ...(root.book === true ? { book: true as const } : {}) };
  if (root.deadline !== undefined) course.deadline = parseDeadline(root.deadline, file);
  for (const field of ['company', 'role', 'interviewDate', 'createdAt', 'updatedAt'] as const) if (root[field] !== undefined) course[field] = stringField(root[field], file, field);
  if (root.tier !== undefined) { if ((root.tier !== 1 && root.tier !== 2 && root.tier !== 3) || !course.company) invalid(file, 'tier'); course.tier = root.tier; }
  if (root.tags !== undefined) { try { course.tags = normalizeTags(root.tags); } catch (error) { invalid(file, error instanceof Error ? error.message : 'tags'); } }
  return course;
}
