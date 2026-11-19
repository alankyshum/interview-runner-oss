import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Course, Cheatsheet, Drill } from '../shared/courseSchema';
import { validateOutline } from '../server/outlines';
import { validateRecall, validateWhiteboard } from '../server/mapRecall';
import { workspaceFileLimits } from '../sandbox/workspace-files.mjs';

export type Missing = { courseId: string; chapterId: string; drillId: string; field: string; path: string };

async function isMissing(path: string): Promise<boolean> {
  try { await access(path); return false; } catch { return true; }
}

const sandboxPackage = JSON.parse(await readFile(resolve(import.meta.dirname, '../sandbox/package.json'), 'utf8')) as { dependencies?: Record<string, string> };

async function validateWorkspace(root: string, course: Course, drill: Extract<Drill, { contentType: 'ai-coding' }>): Promise<void> {
  const workspace = resolve(root, drill.workspacePath);
  const workspaceInfo = await lstat(workspace);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw new Error(`${drill.workspacePath}: ai-coding workspace must be a directory`);
  const projectFile = drill.testRunner === 'vitest' ? 'package.json' : 'pyproject.toml';
  if (await isMissing(join(workspace, projectFile))) throw new Error(`${drill.workspacePath}: ${projectFile} is required for ${drill.testRunner}`);
  let files = 0; let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const info = await lstat(path);
      const rel = relative(workspace, path).replaceAll('\\', '/');
      if (entry.name === 'node_modules') throw new Error(`${drill.workspacePath}/${rel}: node_modules is forbidden in an ai-coding template`);
      if (info.isSymbolicLink()) throw new Error(`${drill.workspacePath}/${rel}: symlinks are forbidden in an ai-coding template`);
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile()) continue;
      files += 1; bytes += info.size;
      if (files > workspaceFileLimits.files) throw new Error(`${drill.workspacePath}: workspace file count limit exceeded`);
      if (info.size > workspaceFileLimits.fileBytes) throw new Error(`${drill.workspacePath}/${rel}: workspace file limit exceeded`);
      if (bytes > workspaceFileLimits.totalBytes) throw new Error(`${drill.workspacePath}: workspace total limit exceeded`);
    }
  }
  await walk(workspace);
  if (drill.testRunner === 'vitest') {
    const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as { dependencies?: unknown; devDependencies?: unknown };
    const declared = { ...(packageJson.dependencies && typeof packageJson.dependencies === 'object' ? packageJson.dependencies : {}), ...(packageJson.devDependencies && typeof packageJson.devDependencies === 'object' ? packageJson.devDependencies : {}) };
    const unavailable = Object.keys(declared).filter((name) => !Object.hasOwn(sandboxPackage.dependencies ?? {}, name));
    if (unavailable.length) throw new Error(`${drill.workspacePath}/package.json: dependencies unavailable in sandbox: ${unavailable.join(', ')}`);
  }
  if (drill.acceptancePath) {
    const acceptance = resolve(root, drill.acceptancePath);
    const entries = await readdir(acceptance, { withFileTypes: true });
    const stages = [...drill.instructions.matchAll(/^## Milestone(?:\s|$)/gm)].length;
    for (let stage = 1; stage <= stages; stage += 1) {
      const prefix = `stage-${stage}.test.`;
      if (!entries.some((entry) => entry.isFile() && entry.name.startsWith(prefix) && (drill.testRunner === 'pytest' ? entry.name.endsWith('.py') : /\.tsx?$/.test(entry.name)))) throw new Error(`${drill.acceptancePath}: missing ${prefix}${drill.testRunner === 'pytest' ? 'py' : 'ts'}`);
    }
  }
}

export async function findMissingPaths(dir: string, manifests?: (Course | Cheatsheet)[]): Promise<Missing[]> {
  const loaded = manifests ?? await (await import('../server/courses')).loadDirectory(dir);
  const courses = loaded.filter((manifest): manifest is Course => manifest.type !== 'cheatsheet');
  const root = dirname(dir);
  const missing: Missing[] = [];
  for (const manifest of loaded) if (manifest.type === 'cheatsheet') for (const chapter of manifest.chapters) for (const lesson of chapter.drills) {
    if (await isMissing(resolve(root, lesson.sourcePath))) missing.push({ courseId: manifest.id, chapterId: chapter.id, drillId: lesson.id, field: 'sourcePath', path: lesson.sourcePath });
    if (lesson.mindmapPath && await isMissing(resolve(root, lesson.mindmapPath))) missing.push({ courseId: manifest.id, chapterId: chapter.id, drillId: lesson.id, field: 'mindmapPath', path: lesson.mindmapPath });
  }
  const fields = (drill: Drill): Array<[string, string | undefined]> => [
    ['sourcePath', drill.sourcePath],
    ['testPath', drill.testPath],
    ['outlinePath', drill.outlinePath],
    ['scaffold.seedPath', drill.scaffold?.seedPath],
    ['workspacePath', drill.contentType === 'ai-coding' ? drill.workspacePath : undefined],
    ['handoffPath', drill.contentType === 'ai-coding' ? drill.handoffPath : undefined],
    ['rubricPath', drill.contentType === 'ai-coding' ? drill.rubricPath : undefined],
    ['acceptancePath', drill.contentType === 'ai-coding' ? drill.acceptancePath : undefined],
  ];

  await Promise.all(courses.flatMap((course: Course) => course.chapters.flatMap((chapter) => chapter.drills.map(async (drill) => {
    await Promise.all(fields(drill).filter(([, path]) => path !== undefined).map(async ([field, path]) => {
      if (await isMissing(resolve(root, path!))) missing.push({ courseId: course.id, chapterId: chapter.id, drillId: drill.id, field, path: path! });
      else if (field === 'outlinePath') validateOutline(path!, JSON.parse(await readFile(resolve(root, path!), 'utf8')), course.id, drill.id);
      else if (field === 'sourcePath' && drill.contentType === 'recall') validateRecall(path!, JSON.parse(await readFile(resolve(root, path!), 'utf8')), course.id, drill.id);
      else if (field === 'sourcePath' && drill.contentType === 'whiteboard') validateWhiteboard(path!, JSON.parse(await readFile(resolve(root, path!), 'utf8')), course.id, drill.id);
    }));
    if (drill.contentType === 'ai-coding') {
      const workspaceExists = !(await isMissing(resolve(root, drill.workspacePath)));
      const acceptanceExists = !drill.acceptancePath || !(await isMissing(resolve(root, drill.acceptancePath)));
      if (workspaceExists && acceptanceExists) await validateWorkspace(root, course, drill);
    }
  }))));
  return missing.sort((a, b) => `${a.courseId}/${a.chapterId}/${a.drillId}/${a.field}`.localeCompare(`${b.courseId}/${b.chapterId}/${b.drillId}/${b.field}`));
}
