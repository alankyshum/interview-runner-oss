import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Course } from '../shared/courseSchema';
import { behavioralTestIssues } from './test-quality';

export type TestQualityFinding = { courseId: string; chapterId: string; drillId: string; testPath: string; issue: string };
type ValidationOptions = { testPaths?: ReadonlySet<string>; testContents?: ReadonlyMap<string, string>; courses?: Course[] };

export async function findTestQualityIssues(coursesDir: string, selectedCourseIds: readonly string[] = [], options: ValidationOptions = {}): Promise<{ checked: number; courses: number; findings: TestQualityFinding[] }> {
  const selected = new Set(selectedCourseIds);
  const courses = (options.courses ?? await (await import('../server/courses')).loadCourses(coursesDir)).filter((course) => selected.size === 0 || selected.has(course.id));
  if (selected.size > 0) for (const id of selected) if (!courses.some((course) => course.id === id)) throw new Error(`Unknown course: ${id}`);
  const root = dirname(coursesDir); let checked = 0;
  const findings: TestQualityFinding[] = [];
  for (const course of courses) for (const chapter of course.chapters) for (const drill of chapter.drills) {
    if (drill.contentType === 'ai-coding') {
      const workspace = resolve(root, drill.workspacePath);
      const workspaceTests: string[] = [];
      async function collect(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) { if (entry.name !== 'node_modules') await collect(path); }
          else if (entry.isFile() && (/\.test\.tsx?$/.test(entry.name) || /^test_.*\.py$/.test(entry.name))) workspaceTests.push(path);
        }
      }
      await collect(workspace);
      for (const path of workspaceTests) {
        checked += 1; const content = await readFile(path, 'utf8'); const testPath = relative(root, path).replaceAll('\\', '/');
        if (path.endsWith('.py')) {
          const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: content, encoding: 'utf8' });
          if (parsed.status !== 0) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath, issue: 'workspace test does not parse' });
        } else {
          const { default: ts } = await import('@typescript/typescript6');
          const parsed = ts.transpileModule(content, { fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX } });
          if (parsed.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath, issue: 'workspace test does not parse' });
        }
      }
      if (drill.acceptancePath) for (const entry of await readdir(resolve(root, drill.acceptancePath), { withFileTypes: true })) {
        if (!entry.isFile() || !/^stage-\d+\.test\.(?:tsx?|py)$/.test(entry.name)) continue;
        checked += 1; const absolute = resolve(root, drill.acceptancePath, entry.name); const content = await readFile(absolute, 'utf8'); const testPath = `${drill.workspacePath}/.ir-acceptance/${entry.name}`;
        if (entry.name.endsWith('.py')) {
          const stem = basename(drill.sourcePath, '.py');
          if (!new RegExp(`(?:from\\s+${stem}\\s+import|import\\s+${stem}(?:\\s|$))`).test(content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath, issue: 'test must import the learner module' });
          if (!/\bassert\b/.test(content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath, issue: 'test must contain a behavioral assertion' });
        } else for (const issue of await behavioralTestIssues(testPath, drill.sourcePath, content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath, issue });
      }
      continue;
    }
    if (!drill.testPath) continue;
    if (options.testPaths && !options.testPaths.has(drill.testPath)) continue;
    checked += 1;
    let content: string;
    try { content = options.testContents?.get(drill.testPath) ?? await readFile(resolve(root, drill.testPath), 'utf8'); }
    catch { findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath: drill.testPath, issue: 'test file is missing or unreadable' }); continue; }
    if (drill.testPath.endsWith('.py')) {
      const stem = drill.sourcePath.split('/').pop()!.replace(/\.py$/, '');
      if (!new RegExp(`(?:from\\s+${stem}\\s+import|import\\s+${stem}(?:\\s|$))`).test(content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath: drill.testPath, issue: 'test must import the learner module' });
      if (!/\bassert\b/.test(content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath: drill.testPath, issue: 'test must contain a behavioral assertion' });
      if (/pytest\.mark\.skip|pytest\.skip\s*\(/.test(content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath: drill.testPath, issue: 'test must not be skipped' });
    } else for (const issue of await behavioralTestIssues(drill.testPath, drill.sourcePath, content)) findings.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath: drill.testPath, issue });
  }
  return { checked, courses: courses.length, findings: findings.sort((a, b) => `${a.courseId}/${a.chapterId}/${a.drillId}/${a.issue}`.localeCompare(`${b.courseId}/${b.chapterId}/${b.drillId}/${b.issue}`)) };
}
