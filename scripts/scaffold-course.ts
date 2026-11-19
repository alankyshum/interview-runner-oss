import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname, basename, join } from 'node:path';
import { SCAFFOLD_TEST_MARKER } from './test-quality';

import { parseCourse as validate, parseCheatsheet, type Drill, type Course } from '../shared/courseSchema';
import { requireRepoForCourse } from '../server/courseRepos';
let root = '';
let coursesDir = '';

function camelCase(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((word, i) => i === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()).join('') || 'drill';
}
function snakeCase(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'drill'; }
function logicNames(instructions: string, fallback: string): string[] {
  const names = new Set<string>();
  const signature = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=|(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\()/g;
  for (const match of instructions.matchAll(signature)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name && name !== 'function' && name !== 'export') names.add(name);
  }
  return [...names].slice(0, 4).length ? [...names].slice(0, 4) : [camelCase(fallback)];
}
function sourceFor(drill: Drill): string {
  if (drill.contentType === 'map') return `# ${drill.title}\n`;
  if (drill.sourcePath.endsWith('.py')) return `${logicNames(drill.instructions, drill.id).map((name) => `def ${snakeCase(name)}(*args: object) -> object:\n    raise NotImplementedError("not implemented")`).join('\n\n')}\n`;
  if (drill.kind === 'scratch') return `// Scratch drill: ${drill.title}\n// Time box: ${drill.estMinutes} minutes\n`;
  return `${logicNames(drill.instructions, drill.id).map((name) => `export function ${name}(..._args: unknown[]): never {\n  throw new Error('not implemented');\n}`).join('\n\n')}\n`;
}
function testFor(drill: Drill): string {
  if (drill.testPath?.endsWith('.py')) return `# ${SCAFFOLD_TEST_MARKER}\n# Course author: replace this file with behavioral tests before validation.\nimport pytest\n\n@pytest.mark.skip(reason="replace scaffold with behavioral tests")\ndef test_requires_course_authored_behavioral_tests():\n    raise AssertionError("Scaffold test only: import and exercise the learner module.")\n`;
  return `// ${SCAFFOLD_TEST_MARKER}\n// Course author: replace this file with behavioral tests before validation.\n// Learner: remove .skip when you begin this drill.\nimport { describe, it } from 'vitest';\n\ndescribe.skip(${JSON.stringify(drill.title)}, () => {\n  it('requires course-authored behavioral tests', () => {\n    throw new Error('Scaffold test only: import and exercise the learner export with canonical, edge, and constraint cases.');\n  });\n});\n`;
}
const aiTemplates = resolve(import.meta.dirname, '../templates/ai-coding');
async function aiTemplate(name: string, drill: Extract<Drill, { contentType: 'ai-coding' }>, stem: string): Promise<string> {
  const symbol = drill.testRunner === 'pytest' ? snakeCase(stem) : camelCase(stem);
  return (await readFile(join(aiTemplates, name), 'utf8')).replaceAll('__STEM__', stem).replaceAll('__SYMBOL__', symbol).replaceAll('__TITLE__', drill.title);
}
async function scaffoldAiCoding(drill: Extract<Drill, { contentType: 'ai-coding' }>, summary: string[]): Promise<void> {
  const extension = drill.testRunner === 'pytest' ? '.py' : '.ts';
  const stem = basename(drill.sourcePath, extension);
  const workspace = safePath(drill.workspacePath);
  const files = drill.testRunner === 'vitest'
    ? [['package.json', 'vitest/package.json'], ['tsconfig.json', 'vitest/tsconfig.json'], ['vitest.config.ts', 'vitest/vitest.config.ts'], [relative(drill.workspacePath, drill.sourcePath), 'vitest/source.ts'], [`tests/${stem}.test.ts`, 'vitest/test.ts']]
    : [['pyproject.toml', 'pytest/pyproject.toml'], [relative(drill.workspacePath, drill.sourcePath), 'pytest/source.py'], [`tests/test_${stem}.py`, 'pytest/test.py']];
  for (const [target, template] of files) await emit(resolve(workspace, target), await aiTemplate(template, drill, stem), summary);
  await emit(safePath(drill.handoffPath), await aiTemplate('handoff.md', drill, stem), summary);
  await emit(safePath(drill.rubricPath), await aiTemplate('rubric.md', drill, stem), summary);
}
async function emit(path: string, content: string, summary: string[]): Promise<void> {
  try {
    await stat(path);
    summary.push(`SKIPPED (exists) ${relative(root, path)}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    summary.push(`CREATED ${relative(root, path)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      summary.push(`SKIPPED (exists) ${relative(root, path)}`);
      return;
    }
    throw error;
  }
}
function safePath(manifestPath: string): string {
  const path = resolve(root, manifestPath);
  if (relative(root, path).startsWith('..')) throw new Error(`Manifest path escapes runner root: ${manifestPath}`);
  return path;
}

function seedHeader(seedPath: string, seedBytes: string): string { return `${seedPath.endsWith('.py') ? '#' : '//'} scaffold-seed: ${seedPath} sha256:${createHash('sha256').update(seedBytes).digest('hex').slice(0, 12)}\n`; }
function diffSummary(source: string, seed: string): string {
  const sourceLines = source.split('\n');
  const seedLines = seed.split('\n');
  const line = sourceLines.findIndex((value, index) => value !== seedLines[index]);
  return `first differing line ${line < 0 ? Math.max(sourceLines.length, seedLines.length) : line + 1}`;
}
async function checkScaffold(drill: Drill, checkOnly: boolean, adopt: boolean, summary: string[]): Promise<void> {
  if (!drill.scaffold) return;
  const seedPath = safePath(drill.scaffold.seedPath);
  let seedBytes: string;
  try { seedBytes = await readFile(seedPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`MISSING SEED ${drill.scaffold.seedPath}`); throw error; }
  const sourcePath = safePath(drill.sourcePath);
  let sourceBytes: string | undefined;
  try { sourceBytes = await readFile(sourcePath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const header = seedHeader(drill.scaffold.seedPath, seedBytes);
  if (sourceBytes !== undefined) {
    const line = sourceBytes.split('\n', 1)[0];
    if (!/^(?:\/\/|#) scaffold-seed:/.test(line)) {
      if (adopt) {
        if (sourceBytes !== seedBytes) throw new Error(`REFUSED ADOPT ${drill.sourcePath}: ${diffSummary(sourceBytes, seedBytes)}`);
        await writeFile(sourcePath, `${header}${sourceBytes}`, 'utf8');
        summary.push(`ADOPTED ${drill.sourcePath}`);
        return;
      }
      // A pre-existing learner file is a legitimate state, not drift.
      summary.push(`UNMANAGED ${drill.sourcePath}`); return;
    }
    const expectedHash = header.trimEnd().match(/sha256:([0-9a-f]+)$/)?.[1]; const actualHash = line.match(/sha256:([0-9a-f]+)$/)?.[1];
    if (actualHash !== expectedHash) { const message = `STALE ${drill.sourcePath} (seed sha256:${expectedHash} header sha256:${actualHash ?? 'missing'})`; if (checkOnly) throw new Error(message); summary.push(message); return; }
    summary.push(`SKIPPED (exists) ${relative(root, sourcePath)}`); return;
  }
  if (checkOnly) return;
  await emit(sourcePath, `${header}${seedBytes}`, summary);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const repoIndex = args.indexOf('--repo'); const repoRoot = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
  const courseId = args.find((arg, index) => !arg.startsWith('--') && (repoIndex < 0 || index !== repoIndex + 1));
  if (!courseId) throw new Error('Usage: npm run scaffold -- <course-id>');
  root = repoRoot ? resolve(repoRoot) : requireRepoForCourse(courseId).root; coursesDir = resolve(root, 'courses');
  const file = `${courseId}.json`;
  const checkOnly = process.argv.includes('--check');
  const adopt = process.argv.includes('--adopt');
  let course: Course;
  try {
    const raw: unknown = JSON.parse(await readFile(resolve(coursesDir, file), 'utf8'));
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'cheatsheet') {
      const sheet = parseCheatsheet(file, raw); const summary: string[] = [];
      for (const chapter of sheet.chapters) for (const lesson of chapter.drills) {
        if (checkOnly) { try { await stat(safePath(lesson.sourcePath)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`MISSING ${lesson.sourcePath}`); throw error; } }
        else await emit(safePath(lesson.sourcePath), '<!-- Add this section’s content here. -->\n', summary);
      }
      console.log(`Scaffold ${sheet.id}: ${summary.filter((line) => line.startsWith('CREATED')).length} created`);
      for (const line of summary) console.log(line);
      return;
    }
    course = validate(file, raw);
    if (course.type === 'map-recall') throw new Error('Map + recall content is authored directly; scaffold does not modify it.');
  }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; return; }
  const summary: string[] = [];
  const failures: string[] = [];
  for (const chapter of course.chapters) for (const drill of chapter.drills) {
    if (drill.contentType === 'ai-coding') {
      if (!checkOnly) await scaffoldAiCoding(drill, summary);
      continue;
    }
    try {
      await checkScaffold(drill, checkOnly, adopt, summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      console.error(message);
    }
    if (!drill.scaffold && !checkOnly) await emit(safePath(drill.sourcePath), sourceFor(drill), summary);
    if (drill.testPath && !checkOnly) await emit(safePath(drill.testPath), testFor(drill), summary);
  }
  const created = summary.filter((line) => line.startsWith('CREATED')).length;
  const skipped = summary.length - created;
  console.log(`Scaffold ${course.id}: ${created} created, ${skipped} skipped`);
  for (const line of summary) console.log(line);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
