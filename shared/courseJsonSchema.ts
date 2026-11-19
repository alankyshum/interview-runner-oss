import { COURSE_SCHEMA_VERSION } from './courseSchema';

// Structural representation of the shared parser. Cross-field rules, filename/ID
// matching, legacy-reading policy, and repository paths require the CLI parser.
const text = { type: 'string', pattern: '\\S' };
const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' };
const path = { type: 'string', pattern: '^(?!/)(?!.*[\\\\:])(?!(?:.*?/)?\\.{1,2}(?:/|$))(?!.*//).+[^/]$|^[^/\\\\:.]$' };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const arr = (items: unknown, minItems = 0) => ({ type: 'array', items, minItems });
const common = { id, title: text, kind: { enum: ['logic', 'scratch'] }, estMinutes: { type: 'number', minimum: 0 }, sourcePath: path, instructions: text };
const baseRequired = ['id', 'title', 'contentType', 'kind', 'estMinutes', 'sourcePath', 'instructions'];
const scaffold = obj({ seedPath: path }, ['seedPath']);
const unlock = { oneOf: [obj({ mode: { const: 'manual' } }, ['mode']), obj({ mode: { const: 'timer' }, minutes: arr({ type: 'number', exclusiveMinimum: 0 }) }, ['mode', 'minutes'])] };
const lesson = (contentType: string, extra: Record<string, unknown> = {}, required: string[] = []) => obj({ ...common, contentType: { const: contentType }, ...extra }, [...baseRequired, ...required]);
const lessons = [
  lesson('coding', { testPath: path, scaffold }, ['testPath']),
  lesson('reading', { outlinePath: path, scaffold }, ['outlinePath']),
  lesson('ai-coding', { workspacePath: path, testRunner: { enum: ['vitest', 'pytest'] }, handoffPath: path, rubricPath: path, stageUnlock: unlock, acceptancePath: path }, ['workspacePath', 'testRunner', 'handoffPath', 'rubricPath']),
  lesson('map'), lesson('recall', { whiteboard: { type: 'boolean' } }), lesson('whiteboard'),
];
const chapter = (drill: unknown, minItems = 0) => obj({ id, title: text, drills: arr(drill, minItems) }, ['id', 'title', 'drills']);
const course = obj({
  type: { const: 'map-recall' }, book: { const: true }, id, title: text,
  company: text, tier: { enum: [1, 2, 3] }, role: text, interviewDate: text, deadline: text, createdAt: text, updatedAt: text,
  tags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } },
  chapters: arr(chapter({ oneOf: lessons })),
}, ['id', 'title', 'chapters']);
const sheetLesson = obj({ id, title: text, contentType: { const: 'cheatsheet' }, headingLevel: { type: 'integer', minimum: 1, maximum: 6 }, sourcePath: path, anchors: { ...arr({ type: 'string', minLength: 1, maxLength: 300, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' }), uniqueItems: true }, mindmapPath: path }, ['id', 'title', 'contentType', 'headingLevel', 'sourcePath']);
const sheet = obj({ type: { const: 'cheatsheet' }, id, title: text, chapters: arr(chapter(sheetLesson, 1), 1) }, ['type', 'id', 'title', 'chapters']);

export function courseJsonSchema(): unknown {
  return { $schema: 'http://json-schema.org/draft-07/schema#', title: `Course or cheatsheet manifest v${COURSE_SCHEMA_VERSION}`, description: 'Structural checks only; use the course validate CLI for full semantic and filesystem validation.', oneOf: [course, sheet] };
}
export function schemaText(): string { return `${JSON.stringify(courseJsonSchema(), null, 2)}\n`; }
