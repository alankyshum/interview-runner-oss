import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { courseRepos } from '../server/courseRepos';
import { findTestQualityIssues } from './validate-course-tests';

const execFileAsync = promisify(execFile);
async function stagedTests(contentRoot: string): Promise<{ paths: Set<string>; contents: Map<string, string> }> {
  const { stdout: repoOutput } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: contentRoot, encoding: 'utf8' });
  const repoRoot = repoOutput.trim();
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: repoRoot, encoding: 'utf8' });
  const contentDir = relative(repoRoot, await realpath(contentRoot)).split('\\').join('/');
  const runnerPrefix = contentDir ? `${contentDir}/` : '';
  const staged = stdout.split('\n').filter((path) => path.startsWith(runnerPrefix) && (/\.test\.tsx?$/.test(path) || /\/test_[^/]+\.py$/.test(path)));
  const paths = new Set(staged.map((path) => path.slice(runnerPrefix.length))); const contents = new Map<string, string>();
  await Promise.all(staged.map(async (repoPath) => { const { stdout: content } = await execFileAsync('git', ['show', `:${repoPath}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }); contents.set(repoPath.slice(runnerPrefix.length), content); }));
  return { paths, contents };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); const repoIndex = args.indexOf('--repo'); const repoPath = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
  if (repoIndex >= 0 && !repoPath) throw new Error('--repo requires a path');
  if (args.includes('--staged') && !repoPath) throw new Error('--staged requires --repo <path>');
  const selected = args.filter((value, index) => !value.startsWith('-') && index !== repoIndex + 1);
  const roots = repoPath ? [resolve(repoPath)] : courseRepos.map((repo) => repo.root);
  if (!roots.length) { console.log('No linked repositories; skipping behavioral test validation (content is validated at publish time).'); return; }
  const results = [];
  for (const root of roots) { const staged = args.includes('--staged') ? await stagedTests(root) : undefined; results.push(await findTestQualityIssues(resolve(root, 'courses'), selected, staged ? { testPaths: staged.paths, testContents: staged.contents } : {})); }
  const result = { checked: results.reduce((sum, item) => sum + item.checked, 0), courses: results.reduce((sum, item) => sum + item.courses, 0), findings: results.flatMap((item) => item.findings) };
  if (result.findings.length) {
    for (const finding of result.findings) console.error(`${finding.courseId} / ${finding.chapterId} / ${finding.drillId}: ${finding.testPath} — ${finding.issue}`);
    console.error(`rejected ${result.findings.length} test-quality issue(s) across ${result.checked} test file(s)`);
    process.exitCode = 1; return;
  }
  console.log(`validated ${result.checked} behavioral drill tests across ${result.courses} course(s)`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
