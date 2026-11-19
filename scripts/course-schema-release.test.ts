import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { COURSE_SCHEMA_VERSION, parseCheatsheet, parseCourse, readCourseSchemaVersion, upcastCourse } from '../shared/courseSchema';
import { courseJsonSchema, schemaText } from '../shared/courseJsonSchema';

const root = resolve(import.meta.dirname, '..');
const fixtures = join(root, 'scripts/fixtures/course-schema');
const load = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
// Optional: a courses/ directory of real manifests to validate against the released schema.
const corpus = process.env.COURSE_SCHEMA_CORPUS ?? '';

describe('released course schema', () => {
  it('matches the runner marker and repository version contract', () => {
    expect(load(join(root, 'interview-runner.json'))).toMatchObject({ courseSchema: COURSE_SCHEMA_VERSION });
    expect(readCourseSchemaVersion({ kind: 'interview-runner-courses', runner: 'example/runner', schema: 1 })).toBe(1);
    expect(() => readCourseSchemaVersion({ kind: 'interview-runner-courses', runner: 'example/runner', schema: 0 })).toThrow('invalid');
    expect(() => readCourseSchemaVersion({ kind: 'interview-runner-courses', schema: 2 })).toThrow('invalid');
    expect(() => upcastCourse({}, 3)).toThrow('course schema v3 is newer than this runner supports (v2); upgrade the stack');
    expect(() => upcastCourse({}, 0)).toThrow('unknown course schema');
  });
  it('upcasts real pre-v2 and current fixture manifests without changing data', () => {
    const old = load(join(fixtures, 'v1-example-course.json'));
    const current = load(join(fixtures, 'v2-example-course.json'));
    expect(upcastCourse(old, 1)).toEqual(old);
    expect(parseCourse('example-course.json', upcastCourse(old, 1))).toMatchObject({ id: 'example-course' });
    expect(parseCourse('example-course.json', upcastCourse(current, 2))).toMatchObject({ id: 'example-course' });
    const sheet = load(join(fixtures, 'v2-cheatsheet.json'));
    expect(parseCheatsheet('behavioral-interview-cheatsheet.json', upcastCourse(sheet, 2))).toMatchObject({ type: 'cheatsheet' });
  });
  it('refuses to rewrite removed UI exercises', () => {
    expect(() => upcastCourse({ chapters: [{ drills: [{ id: 'old-ui', kind: 'ui' }] }] }, 1)).toThrow('old-ui.kind: UI drills were removed');
  });
  it('commits exactly the generated schema and validates portable fixtures', () => {
    expect(readFileSync(join(root, `schema/course.v${COURSE_SCHEMA_VERSION}.json`), 'utf8')).toBe(schemaText());
    const validate = new Ajv({ allErrors: true }).compile(courseJsonSchema() as object);
    for (const name of ['v1-example-course.json', 'v2-example-course.json', 'v2-cheatsheet.json']) {
      expect(validate(load(join(fixtures, name))), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    const bad = { ...(load(join(fixtures, 'v2-example-course.json')) as object), unexpected: true };
    expect(validate(bad)).toBe(false);
    const badDrill = structuredClone(load(join(fixtures, 'v2-example-course.json'))) as { chapters: { drills: { contentType: string }[] }[] };
    badDrill.chapters[0]!.drills[0]!.contentType = 'not-a-type';
    expect(validate(badDrill)).toBe(false);
  });
  it('stamps bundled skills with the canonical stack version', () => {
    const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const skill of ['course--author', 'course--publish']) expect(readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8')).toContain(`\nstackVersion: ${version}\n`);
  });
  it('validates every manifest in the optional external corpus', ({ skip }) => {
    if (!corpus || !existsSync(corpus)) { console.info('COURSE_SCHEMA_CORPUS is not set to an existing directory; skipping external-corpus check'); skip(); return; }
    const files = readdirSync(corpus).filter((name) => name.endsWith('.json') && !name.endsWith('.hints.json'));
    expect(files.length).toBeGreaterThan(0);
    const validate = new Ajv({ allErrors: true }).compile(courseJsonSchema() as object);
    for (const file of files) expect(validate(load(join(corpus, file))), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    console.info(`JSON Schema accepted ${files.length} external manifests`);
  });
});
