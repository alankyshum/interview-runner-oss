import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { courseRepos, packageRoot, runnerMarker } from '../server/courseRepos';
import { loadCourses } from '../server/courses';
import { assertNoSymlink, seedLinkedCodingWorkspace } from '../server/content/materialize';

const containerRoot = (id: string) => `/app/course-repos/${id.replaceAll('/', '--')}`;
const dbMode = (process.env.INTERVIEW_RUNNER_CONTENT_SOURCE ?? 'db') === 'db';
const stateRoot = join(process.env.XDG_STATE_HOME ? resolve(process.env.XDG_STATE_HOME) : join(homedir(), '.local/state'), 'interview-runner', 'managed');
if (dbMode) {
  await Promise.all(['materialized', 'workspaces'].map((name) => mkdir(join(stateRoot, name), { recursive: true })));
  // DB-mode containers no longer see linked repos. Capture any existing coding
  // edits once on the host before those mounts are removed.
  if (!process.argv.includes('--preflight')) for (const repo of courseRepos) for (const course of await loadCourses(join(repo.root, 'courses'))) for (const chapter of course.chapters) for (const drill of chapter.drills) {
    if (drill.contentType !== 'coding') continue;
    const source = join(repo.root, 'drills', course.id, drill.id);
    await assertNoSymlink(repo.root, source); await seedLinkedCodingWorkspace(course.id, drill.id, source, stateRoot);
  }
}
const containerLinks = {
  version: 1,
  runners: { [runnerMarker.repo]: { path: '/app', supportedCourseSchema: runnerMarker.courseSchema } },
  courses: Object.fromEntries((dbMode ? [] : courseRepos).map((repo) => [repo.id, { path: containerRoot(repo.id), runner: runnerMarker.repo, schema: runnerMarker.courseSchema }])),
};
const outputDirectory = resolve(process.argv[2] ?? packageRoot);
const linksFile = join(outputDirectory, 'course-repos.links.json');
const sandboxFile = join(outputDirectory, 'course-repos.sandbox.json');
const sandboxSettings = join(packageRoot, 'sandbox');
const quote = (value: string) => JSON.stringify(value);
const mounts = dbMode ? [`      - ${quote(`${stateRoot}:/app/state/interview-runner/managed:rw`)}`] : courseRepos.flatMap((repo) => [
  `      - ${quote(`${repo.root}:${containerRoot(repo.id)}:ro`)}`,
  `      - ${quote(`${join(repo.root, 'drills')}:${containerRoot(repo.id)}/drills:rw`)}`,
]);
const sandboxMounts = dbMode ? [`      - ${quote(`${stateRoot}:${stateRoot}:ro`)}`, `      - ${quote(`${join(stateRoot, 'workspaces')}:${join(stateRoot, 'workspaces')}:rw`)}`] : courseRepos.flatMap((repo) => [`      - ${quote(`${repo.root}:${repo.root}:ro`)}`, `      - ${quote(`${join(repo.root, 'drills')}:${join(repo.root, 'drills')}:rw`)}`]);
const compose = `services:\n  interview-runner:\n    volumes:\n${[...mounts, `      - ${quote(`${linksFile}:/app/state/interview-runner/links.json:ro`)}`].join('\n')}\n  interview-sandboxd:\n    environment:\n      SANDBOX_SETTINGS_DIR: /app/sandbox-settings\n      SANDBOX_SETTINGS_HOST_DIR: ${quote(sandboxSettings)}\n    volumes:\n${[`      - ${quote(`${sandboxFile}:/app/course-repos.sandbox.json:ro`)}`, `      - ${quote(`${sandboxSettings}:/app/sandbox-settings:rw`)}`, ...sandboxMounts].join('\n')}\n`;
const sandboxRepos = dbMode ? { managed: { containerRoot: '/app/state/interview-runner/managed', hostRoot: stateRoot } } : Object.fromEntries(courseRepos.map((repo) => [repo.id, { containerRoot: containerRoot(repo.id), hostRoot: repo.root }]));
await Promise.all([
  writeFile(linksFile, `${JSON.stringify(containerLinks, null, 2)}\n`, 'utf8'),
  writeFile(sandboxFile, `${JSON.stringify(sandboxRepos, null, 2)}\n`, 'utf8'),
  writeFile(join(outputDirectory, 'compose.repos.yaml'), compose, 'utf8'),
]);
console.log(`Generated compose.repos.yaml and course-repos.sandbox.json for ${courseRepos.length} course repository(s).`);
