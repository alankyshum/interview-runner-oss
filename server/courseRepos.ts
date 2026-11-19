import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot } from './packageRoot';

export { packageRoot } from './packageRoot';

type RunnerMarker = { kind: 'interview-runner'; repo: string; courseSchema: number };
type Links = {
  version: number;
  runners: Record<string, { path: string; supportedCourseSchema: number }>;
  courses: Record<string, { path: string; runner: string; schema: number }>;
};
export type CourseRepo = { id: string; name: string; root: string };

const guidance = 'See AGENTS.md and use the course--author skill to repair course links.';
function fail(message: string): never { throw new Error(`Course repository configuration error: ${message} ${guidance}`); }
function json(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}.`); }
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

const runnerMarkerPath = join(packageRoot, 'interview-runner.json');
const rawRunner = json(runnerMarkerPath);
if (!record(rawRunner) || rawRunner.kind !== 'interview-runner' || typeof rawRunner.repo !== 'string' || !Number.isInteger(rawRunner.courseSchema)) fail(`invalid runner marker ${runnerMarkerPath}.`);
export const runnerMarker = rawRunner as RunnerMarker;
// Schema 2 retires UI drills but keeps reading schema-1 links and markers during
// the migration. Both versions use the current manifest validator.
const supportedSchema = (schema: unknown): boolean => schema === runnerMarker.courseSchema || (runnerMarker.courseSchema === 2 && schema === 1);
export const statePath = join(process.env.XDG_STATE_HOME ? resolve(process.env.XDG_STATE_HOME) : join(homedir(), '.local/state'), 'interview-runner/links.json');
const dbMode = (process.env.INTERVIEW_RUNNER_CONTENT_SOURCE ?? 'db') === 'db';
// DB mode reads content.db, so a fresh checkout needs no link registry: none means no linked repositories.
const rawLinks = dbMode && !existsSync(statePath) ? { version: 1, runners: { [runnerMarker.repo]: { path: packageRoot, supportedCourseSchema: runnerMarker.courseSchema } }, courses: {} } : json(statePath);
if (!record(rawLinks) || rawLinks.version !== 1 || !record(rawLinks.runners) || !record(rawLinks.courses)) fail(`invalid links file ${statePath}.`);
const links = rawLinks as Links;
// Links and course markers written for a fork name the runner as <owner>/<name>; the owner part is not significant.
const runnerName = (id: unknown): string | undefined => typeof id === 'string' ? id.split('/').at(-1) : undefined;
const sameRunner = (id: unknown): boolean => runnerName(id) === runnerName(runnerMarker.repo);
const linkedRunner = links.runners[runnerMarker.repo] ?? Object.entries(links.runners).find(([id]) => sameRunner(id))?.[1];
if (!linkedRunner || !supportedSchema(linkedRunner.supportedCourseSchema)) fail(`links file ${statePath} does not describe this runner and schema.`);
let linkedRunnerPath: string;
try { linkedRunnerPath = realpathSync(resolve(linkedRunner.path)); }
catch (error) { fail(`cannot resolve runner path in ${statePath}: ${error instanceof Error ? error.message : String(error)}.`); }
if (linkedRunnerPath !== realpathSync(packageRoot)) fail(`links file ${statePath} does not describe this runner and schema.`);

export const courseRepos: CourseRepo[] = Object.entries(links.courses)
  .filter(([, link]) => sameRunner(link.runner))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, link]) => {
    if (!record(link) || typeof link.path !== 'string' || !supportedSchema(link.schema)) fail(`invalid link for ${id}.`);
    const root = resolve(link.path);
    const markerPath = join(root, 'interview-courses.json');
    const marker = json(markerPath);
    if (!record(marker) || marker.kind !== 'interview-runner-courses' || !sameRunner(marker.runner) || !supportedSchema(marker.schema)) fail(`marker mismatch for ${id} at ${markerPath}.`);
    return { id, name: id.split('/').at(-1)!, root };
  });
if (!courseRepos.length && !dbMode) fail(`no course repositories are linked to ${runnerMarker.repo} in ${statePath}.`);

function courseOwners(): Map<string, CourseRepo> {
  const owners = new Map<string, CourseRepo>();
  for (const repo of courseRepos) {
    const directory = join(repo.root, 'courses');
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.json') && !name.endsWith('.hints.json')).sort()) {
      let id: unknown; let type: unknown;
      try { const manifest = JSON.parse(readFileSync(join(directory, file), 'utf8')); id = manifest.id; type = manifest.type; } catch { continue; }
      if (typeof id !== 'string') continue;
      const filenameId = file.slice(0, -5);
      if (id !== filenameId && (type === 'cheatsheet' || existsSync(join(repo.root, 'cheatsheets', filenameId)))) continue;
      const previous = owners.get(id);
      if (previous) fail(`duplicate course id "${id}" in ${previous.id} and ${repo.id}.`);
      owners.set(id, repo);
    }
  }
  return owners;
}
courseOwners();

export function repoForCourse(courseId: string): CourseRepo | undefined { return courseOwners().get(courseId); }
export function requireRepoForCourse(courseId: string): CourseRepo { return repoForCourse(courseId) ?? fail(`unknown course "${courseId}".`); }
export function pathInRepo(repo: CourseRepo, manifestPath: string): string {
  const path = resolve(repo.root, manifestPath);
  const relativePath = path.slice(repo.root.length);
  if (!(path === repo.root || relativePath.startsWith('/') || relativePath.startsWith('\\'))) fail(`path escapes ${repo.id}: ${manifestPath}.`);
  return path;
}
