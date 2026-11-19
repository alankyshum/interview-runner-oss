import { lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { applyEdits, modify, parseTree } from 'jsonc-parser';
import { COURSE_SCHEMA_VERSION, parseCheatsheet, parseCourse, readCourseSchemaVersion, upcastCourse, type Course, type Cheatsheet } from '../shared/courseSchema';

const usage = 'Usage: ir course validate <dir> | ir course migrate <dir> [--dry-run]';
type Change = { path: string; before: string; after: string };

async function regularFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path}: expected a regular file, not a symlink`);
  return readFile(path, 'utf8');
}
function json(text: string, path: string): unknown {
  try { return JSON.parse(text); } catch (error) { throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
async function replaceChecked(change: Change): Promise<void> {
  if (await regularFile(change.path) !== change.before) throw new Error(`${change.path}: changed since validation; refusing to overwrite`);
  const temp = `${change.path}.ir-${process.pid}-${crypto.randomUUID()}`;
  const mode = (await lstat(change.path)).mode & 0o777;
  const handle = await open(temp, 'wx', mode);
  try {
    try { await handle.writeFile(change.after); await handle.chmod(mode); } finally { await handle.close(); }
    if (await regularFile(change.path) !== change.before) throw new Error(`${change.path}: changed since validation; refusing to overwrite`);
    await rename(temp, change.path);
  } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function main(args: string[]): Promise<void> {
  if (args[0] !== 'course' || !['validate', 'migrate'].includes(args[1] ?? '') || !args[2] || args[2].startsWith('-') || args.length > 4 || (args[3] !== undefined && (args[1] !== 'migrate' || args[3] !== '--dry-run'))) throw new Error(usage);
  const input = resolve(args[2]);
  let root = input;
  if (basename(input) === 'courses') {
    try {
      const markerPath = join(input, 'interview-courses.json');
      const marker = json(await regularFile(markerPath), markerPath);
      if (!marker || typeof marker !== 'object' || !('kind' in marker) || marker.kind !== 'interview-runner-courses') root = dirname(input);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') root = dirname(input); else throw error; }
  }
  const dir = join(root, 'courses');
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error(`${dir}: expected a courses directory, not a symlink`);
  let markerPath = join(root, 'interview-courses.json');
  let markerText: string;
  try { markerText = await regularFile(markerPath); }
  catch (error) {
    // <repo>/namespaces/<name>/ holds another namespace's courses under the repository's marker.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || basename(dirname(root)) !== 'namespaces') throw error;
    markerPath = join(dirname(dirname(root)), 'interview-courses.json');
    markerText = await regularFile(markerPath);
  }
  const marker = json(markerText, markerPath);
  const version = readCourseSchemaVersion(marker);
  // Check even an empty directory for incompatible versions.
  upcastCourse({}, version);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.endsWith('.hints.json')).sort();
  const changes: Change[] = []; const manifests: (Course | Cheatsheet)[] = []; let errors = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const before = await regularFile(path); const raw = json(before, path);
      const original = JSON.stringify(raw);
      const next = upcastCourse(raw, version);
      manifests.push(next && typeof next === 'object' && 'type' in next && next.type === 'cheatsheet' ? parseCheatsheet(name, next) : parseCourse(name, next));
      if (JSON.stringify(next) !== original) changes.push({ path, before, after: `${JSON.stringify(next, null, 2)}\n` });
    } catch (error) { errors++; console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors) throw new Error(`${errors} invalid manifest(s); no files changed`);
  if (args[1] === 'validate') {
    const { findMissingPaths } = await import('./validate-course-paths');
    const { findTestQualityIssues } = await import('./validate-course-tests');
    const missing = await findMissingPaths(dir, manifests);
    for (const item of missing) console.error(`${join(dir, `${item.courseId}.json`)}: ${item.drillId}.${item.field}: missing ${item.path}`);
    if (missing.length) throw new Error('course validation failed');
    const tests = await findTestQualityIssues(dir, [], { courses: manifests.filter((manifest): manifest is Course => manifest.type !== 'cheatsheet') });
    for (const finding of tests.findings) console.error(`${join(dir, `${finding.courseId}.json`)}: ${finding.drillId}.testPath: ${finding.issue} (${finding.testPath})`);
    if (tests.findings.length) throw new Error('course validation failed');
    console.log(`Validated ${names.length} manifests (schema v${version}), ${tests.checked} behavioral test files`);
    return;
  }
  if (version !== COURSE_SCHEMA_VERSION) {
    const tree = parseTree(markerText);
    const schemaFields = tree?.children?.filter((property) => property.children?.[0]?.value === 'schema') ?? [];
    if (schemaFields.length !== 1) throw new Error(`${markerPath}: ambiguous schema field; refusing to overwrite`);
    const after = applyEdits(markerText, modify(markerText, ['schema'], COURSE_SCHEMA_VERSION, {}));
    changes.push({ path: markerPath, before: markerText, after });
  }
  if (args[3] === '--dry-run') {
    for (const change of changes) console.log(`Would update ${change.path}`);
    console.log(`Dry run: ${changes.length} file(s), schema v${version} -> v${COURSE_SCHEMA_VERSION}`);
  } else {
    for (const change of changes) await replaceChecked(change);
    console.log(`Migrated ${changes.length} file(s), schema v${version} -> v${COURSE_SCHEMA_VERSION}`);
  }
}

main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
