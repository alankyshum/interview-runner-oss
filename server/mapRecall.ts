import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { invalid, stringField, unknownFields, type Course, type Drill } from '../shared/courseSchema';

export type RecallQuestion = { id: string; prompt: string; answer: string; expectation?: string; hint?: string };
export type RecallLesson = { courseId: string; drillId: string; title: string; questions: RecallQuestion[] };

export function validateRecall(file: string, value: unknown, courseId: string, drillId: string): RecallLesson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, 'root');
  const raw = value as Record<string, unknown>;
  unknownFields(raw, new Set(['courseId', 'drillId', 'title', 'questions']), file, 'root');
  if (raw.courseId !== courseId || raw.drillId !== drillId) invalid(file, 'courseId/drillId must match manifest');
  if (!Array.isArray(raw.questions)) invalid(file, 'questions');
  const ids = new Set<string>();
  const questions = raw.questions.map((value, index): RecallQuestion => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, `questions[${index}]`);
    const item = value as Record<string, unknown>;
    unknownFields(item, new Set(['id', 'prompt', 'answer']), file, `questions[${index}]`);
    const id = stringField(item.id, file, `questions[${index}].id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'bulk' || ids.has(id)) invalid(file, `invalid or duplicate question id "${id}"`);
    ids.add(id);
    return { id, prompt: stringField(item.prompt, file, `questions[${index}].prompt`), answer: stringField(item.answer, file, `questions[${index}].answer`) };
  });
  return { courseId, drillId, title: stringField(raw.title, file, 'title'), questions };
}

export function validateWhiteboard(file: string, value: unknown, courseId: string, drillId: string): RecallLesson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, 'root');
  const raw = value as Record<string, unknown>;
  unknownFields(raw, new Set(['courseId', 'drillId', 'title', 'milestones']), file, 'root');
  if (raw.courseId !== courseId || raw.drillId !== drillId) invalid(file, 'courseId/drillId must match manifest');
  if (!Array.isArray(raw.milestones) || raw.milestones.length === 0) invalid(file, 'milestones');
  const ids = new Set<string>();
  const questions = raw.milestones.map((value, index): RecallQuestion => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, `milestones[${index}]`);
    const item = value as Record<string, unknown>;
    unknownFields(item, new Set(['id', 'prompt', 'expectation', 'hint', 'answer']), file, `milestones[${index}]`);
    const id = stringField(item.id, file, `milestones[${index}].id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'bulk' || ids.has(id)) invalid(file, `invalid or duplicate milestone id "${id}"`);
    ids.add(id);
    return { id, prompt: stringField(item.prompt, file, `milestones[${index}].prompt`), answer: stringField(item.answer, file, `milestones[${index}].answer`), ...(item.expectation === undefined ? {} : { expectation: stringField(item.expectation, file, `milestones[${index}].expectation`) }), ...(item.hint === undefined ? {} : { hint: stringField(item.hint, file, `milestones[${index}].hint`) }) };
  });
  return { courseId, drillId, title: stringField(raw.title, file, 'title'), questions };
}

/** Resolve the declared file through real paths so symlinks cannot escape its course directory. */
export async function readMapRecall(course: Course, drill: Drill): Promise<string | RecallLesson> {
  const { requireRepoForCourse } = await import('./courseRepos');
  const { contentReader, contentSource } = await import('./content/reader');
  if (drill.contentType !== 'map' && drill.contentType !== 'whiteboard' && !(drill.contentType === 'recall' && (course.type === 'map-recall' || drill.whiteboard))) throw new Error('Not a map or recall lesson');
  const bytes = await contentReader().readCourseFile(course.id, drill.sourcePath);
  if (!bytes) throw Object.assign(new Error(`Missing course content: ${drill.sourcePath}`), { code: 'ENOENT' });
  const source = Buffer.from(bytes).toString('utf8');
  const file = contentSource() === 'files' ? resolve(await realpath(requireRepoForCourse(course.id).root), drill.sourcePath) : drill.sourcePath;
  return drill.contentType === 'map' ? source : drill.contentType === 'whiteboard' ? validateWhiteboard(file, JSON.parse(source), course.id, drill.id) : validateRecall(file, JSON.parse(source), course.id, drill.id);
}
