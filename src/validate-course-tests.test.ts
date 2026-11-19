import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCAFFOLD_TEST_MARKER } from '../scripts/test-quality';
import { findTestQualityIssues } from '../scripts/validate-course-tests';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

async function fixture(testContent: string, extension: 'ts' | 'tsx' = 'ts') {
  root = await mkdtemp(join(tmpdir(), 'course-tests-'));
  const courses = join(root, 'courses'); const drill = join(root, 'drills/course/solve');
  await mkdir(courses, { recursive: true }); await mkdir(drill, { recursive: true });
  const sourcePath = 'drills/course/solve/solve.ts'; const testPath = `drills/course/solve/solve.test.${extension}`;
  await writeFile(join(root, sourcePath), extension === 'tsx' ? 'export default function Solve(){ return null; }' : 'export const solve = (value: number) => value;');
  await writeFile(join(root, testPath), testContent);
  await writeFile(join(courses, 'course.json'), JSON.stringify({ id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ contentType: 'coding', id: 'solve', title: 'Solve', kind: 'logic', estMinutes: 10, sourcePath, testPath, instructions: '## Done\nWorks.' }] }] }));
  return courses;
}

const qualityFixture = (name: string) => readFile(join(process.cwd(), 'scripts/fixtures/test-quality', `${name}.test.ts`), 'utf8');

describe('behavioral course test validation', () => {
  it('parses learner workspace tests and applies behavioral checks to ai-coding acceptance tests', async () => {
    root = await mkdtemp(join(tmpdir(), 'course-tests-ai-')); const courses = join(root, 'courses'); const workspace = join(root, 'drills/course/pair/workspace'); const acceptance = join(root, 'drills/course/pair/acceptance');
    await mkdir(join(workspace, 'src'), { recursive: true }); await mkdir(join(workspace, 'tests'), { recursive: true }); await mkdir(acceptance, { recursive: true }); await mkdir(courses, { recursive: true });
    await writeFile(join(workspace, 'src/solve.ts'), 'export const solve = (value: number) => value;\n');
    await writeFile(join(workspace, 'tests/solve.test.ts'), "import { it } from 'vitest';\nit('starter', () => {});\n");
    await writeFile(join(acceptance, 'stage-1.test.ts'), "import { expect, it } from 'vitest';\nimport { solve } from '../src/solve';\nit('accepts', () => expect(solve(2)).toBe(2));\n");
    await writeFile(join(courses, 'course.json'), JSON.stringify({ id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ contentType: 'ai-coding', id: 'pair', title: 'Pair', kind: 'logic', estMinutes: 20, workspacePath: 'drills/course/pair/workspace', sourcePath: 'drills/course/pair/workspace/src/solve.ts', testRunner: 'vitest', handoffPath: 'drills/course/pair/handoff.md', rubricPath: 'drills/course/pair/rubric.md', acceptancePath: 'drills/course/pair/acceptance', instructions: '## Milestone 1\nStart.\n## Milestone 2\nChange.' }] }] }));
    expect((await findTestQualityIssues(courses)).findings).toEqual([]);
    await writeFile(join(acceptance, 'stage-1.test.ts'), "import { expect, it } from 'vitest';\nit('fake', () => expect(2).toBe(2));\n");
    expect((await findTestQualityIssues(courses)).findings.map((finding) => finding.issue)).toContain('does not import the learner source module');
  });
  it('accepts Python tests that import the colocated learner module and assert behavior', async () => {
    root = await mkdtemp(join(tmpdir(), 'course-tests-python-')); const courses = join(root, 'courses'); const drill = join(root, 'drills/course/solve');
    await mkdir(courses, { recursive: true }); await mkdir(drill, { recursive: true });
    await writeFile(join(drill, 'solve.py'), 'def solve(value: int) -> int:\n    return value\n'); await writeFile(join(drill, 'test_solve.py'), 'from solve import solve\n\ndef test_solve():\n    assert solve(2) == 2\n');
    await writeFile(join(courses, 'course.json'), JSON.stringify({ id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ contentType: 'coding', id: 'solve', title: 'Solve', kind: 'logic', estMinutes: 10, sourcePath: 'drills/course/solve/solve.py', testPath: 'drills/course/solve/test_solve.py', instructions: 'Solve.' }] }] }));
    expect((await findTestQualityIssues(courses)).findings).toEqual([]);
  });
  it('accepts a suite that imports and exercises the learner export', async () => {
    const courses = await fixture("import { expect, it } from 'vitest';\nimport { solve } from './solve';\nit('solves', () => expect(solve(2)).toBe(2));\n");
    expect((await findTestQualityIssues(courses)).findings).toEqual([]);
  });

  it('accepts a TSX suite that renders an imported component through JSX', async () => {
    const courses = await fixture("import { expect, it } from 'vitest';\nimport { render } from '@testing-library/react';\nimport Solve from './solve';\nit('renders', () => { expect(render(<Solve />).container).toBeDefined(); });\n", 'tsx');
    expect((await findTestQualityIssues(courses)).findings).toEqual([]);
  });

  it('accepts skipped learner tests only when their assertions are behavioral', async () => {
    const courses = await fixture(await qualityFixture('pass-skipped'));
    expect((await findTestQualityIssues(courses)).findings).toEqual([]);
  });

  it.each([
    ['literal-only assertions', 'fail-literal-only', 'test "looks finished" contains a literal-only assertion'],
    ['assertions unrelated to the learner export', 'fail-unrelated-assertion', 'test "asserts an unrelated constant" contains a literal-only assertion'],
    ['dynamic assertions unrelated to the learner export', 'fail-unrelated-dynamic', 'test "asserts unrelated dynamic state" has no assertion derived from the learner source module'],
    ['no learner import', 'fail-no-import', 'does not import the learner source module'],
  ])('rejects %s with the offending test name', async (_name, fixtureName, issue) => {
    const content = await qualityFixture(fixtureName);
    const courses = await fixture(content);
    expect((await findTestQualityIssues(courses)).findings.map((finding) => finding.issue)).toContain(issue);
  });

  it('rejects the unchanged scaffold marker even though scaffold tests are skipped', async () => {
    const courses = await fixture(`// ${SCAFFOLD_TEST_MARKER}\nimport { it } from 'vitest';\nimport { solve } from './solve';\nit.skip('replace me', () => { solve(1); });\n`);
    expect((await findTestQualityIssues(courses)).findings.map((finding) => finding.issue)).toContain('unchanged scaffold test marker');
  });
});
