import { resolve } from 'node:path';
import { loadCourses, loadDirectory } from '../server/courses';
import { courseRepos } from '../server/courseRepos';
import { findMissingPaths } from './validate-course-paths';
import { findCodingExampleIssues } from './coding-examples';

async function main(): Promise<void> {
  const repoArg = process.argv.indexOf('--repo');
  const roots = repoArg >= 0 ? [resolve(process.argv[repoArg + 1] ?? '')] : courseRepos.map((repo) => repo.root);
  if (repoArg >= 0 && !process.argv[repoArg + 1]) throw new Error('--repo requires a path');
  if (!roots.length) { console.log('No linked repositories; skipping course path validation (content is validated at publish time).'); return; }
  const missing = (await Promise.all(roots.map((root) => findMissingPaths(resolve(root, 'courses'))))).flat();
  if (missing.length) {
    for (const item of missing) console.error(`${item.courseId} / ${item.chapterId} / ${item.drillId}: ${item.field} -> ${item.path} (missing)`);
    process.exitCode = 1; return;
  }
  const courses = (await Promise.all(roots.map((root) => loadCourses(resolve(root, 'courses'))))).flat();
  const examples = (await Promise.all(roots.map((root) => findCodingExampleIssues(resolve(root, 'courses'))))).flat();
  if (examples.length) {
    for (const issue of examples) console.error(`Coding example error: ${issue.courseId} / ${issue.field}: ${issue.message}`);
    process.exitCode = 1; return;
  }
  const sheets = (await Promise.all(roots.map((root) => loadDirectory(resolve(root, 'courses'))))).flat().filter((manifest) => manifest.type === 'cheatsheet');
  const drillPaths = courses.flatMap((course) => course.chapters.flatMap((chapter) => chapter.drills.flatMap((drill) => [drill.sourcePath, drill.testPath, drill.outlinePath, drill.scaffold?.seedPath, drill.contentType === 'ai-coding' ? drill.workspacePath : undefined, drill.contentType === 'ai-coding' ? drill.handoffPath : undefined, drill.contentType === 'ai-coding' ? drill.rubricPath : undefined, drill.contentType === 'ai-coding' ? drill.acceptancePath : undefined].filter((path): path is string => path !== undefined))));
  const sectionCount = sheets.reduce((sum, sheet) => sum + sheet.chapters.reduce((count, chapter) => count + chapter.drills.length, 0), 0);
  console.log(`validated ${drillPaths.length} drill paths across ${courses.length} courses and ${sectionCount} section paths across ${sheets.length} cheatsheets`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
