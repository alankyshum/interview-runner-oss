import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { safePath } from '../../shared/courseSchema';
import { workspaceFileExcluded } from '../../sandbox/workspace-files.mjs';
import { ContentValidationError } from './errors';

export type CourseBundle = { manifest: unknown; hints?: unknown; files: Record<string, { sha256: string; size: number; mode?: number }> };
export type BlobSource = ReadonlyMap<string, Uint8Array>;
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function checkBundlePath(path: string): void {
  safePath('bundle', path, 'path');
  if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid bundle path: ${path}`);
}

export function imageReferences(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('utf8');
  const references = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s"'`(=])(\/images\/[^\s"'`<>?#)\]]+)/g)) {
    const start = match.index + match[0].length - match[1]!.length;
    let tokenStart = start;
    while (tokenStart > 0 && !/[\s"'`<>]/.test(text[tokenStart - 1]!)) {
      if (tokenStart >= 2 && text.slice(tokenStart - 2, tokenStart) === '](') break;
      tokenStart -= 1;
    }
    const precedingToken = text.slice(tokenStart, start);
    if (!precedingToken.includes('://')) references.add(match[1]!.slice(1));
  }
  return [...references];
}

async function safeStat(root: string, path: string): Promise<Stats | undefined> {
  checkBundlePath(path);
  let current = root;
  let stat;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { stat = await lstat(current); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
    if (stat.isSymbolicLink()) return undefined;
  }
  return stat;
}

export async function bundleFromDirectory(repoRoot: string, courseId: string): Promise<{ bundle: CourseBundle; blobs: Map<string, Uint8Array> }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(courseId)) throw new Error('Invalid course id');
  const root = resolve(repoRoot); const files: CourseBundle['files'] = {}; const blobs = new Map<string, Uint8Array>();
  async function add(path: string): Promise<boolean> {
    const stat = await safeStat(root, path); if (!stat?.isFile()) return false;
    const bytes = await readFile(join(root, path)); const hash = sha256(bytes);
    files[path] = { sha256: hash, size: bytes.length, mode: stat.mode & 0o777 }; blobs.set(hash, bytes);
    return true;
  }
  async function walk(path: string): Promise<void> {
    const stat = await safeStat(root, path); if (!stat) return;
    if (stat.isFile()) { await add(path); return; }
    if (!stat.isDirectory()) return;
    for (const name of (await readdir(join(root, path))).sort()) {
      if (workspaceFileExcluded.has(name) || ['.ir-seeded', '.ruff_cache', '.mypy_cache', '.tox', '.DS_Store', '.vitest-report.json'].includes(name)) continue;
      await walk(`${path}/${name}`);
    }
  }
  const manifestPath = `courses/${courseId}.json`; const hintsPath = `courses/${courseId}.hints.json`;
  await add(manifestPath); await add(hintsPath);
  if (!files[manifestPath]) throw new Error(`Missing ${manifestPath}`);
  for (const tree of ['drills', 'outlines', 'mindmaps', 'recall', 'cheatsheets', 'reading', 'guides']) await walk(`${tree}/${courseId}`);
  const imageErrors: Array<{ field: string; message: string }> = [];
  for (const [path, file] of Object.entries(files)) {
    for (const image of imageReferences(blobs.get(file.sha256)!)) {
      try { checkBundlePath(image); } catch { imageErrors.push({ field: path, message: `Invalid image path: ${image}` }); continue; }
      if (!await add(image)) imageErrors.push({ field: path, message: `Missing referenced image: ${image}` });
    }
  }
  if (imageErrors.length) throw new ContentValidationError(imageErrors);
  const manifest = JSON.parse(Buffer.from(blobs.get(files[manifestPath].sha256)!).toString('utf8')) as unknown;
  const hints = files[hintsPath] ? JSON.parse(Buffer.from(blobs.get(files[hintsPath].sha256)!).toString('utf8')) as unknown : undefined;
  return { bundle: { manifest, ...(hints === undefined ? {} : { hints }), files }, blobs };
}

export async function writeBundleToDirectory(bundle: CourseBundle, blobs: BlobSource, dir: string): Promise<void> {
  const root = resolve(dir);
  for (const [path, file] of Object.entries(bundle.files)) {
    checkBundlePath(path);
    const bytes = blobs.get(file.sha256);
    if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Missing or invalid blob for ${path}`);
  }
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink is forbidden as output directory');
  for (const [path, file] of Object.entries(bundle.files)) {
    const parent = dirname(path); if (parent !== '.') {
      let current = root;
      for (const part of parent.split('/')) { current = join(current, part); await mkdir(current, { recursive: true }); if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink is forbidden in output: ${path}`); }
    }
    const handle = await open(join(root, path), 'wx', file.mode ?? 0o644);
    try { await handle.writeFile(blobs.get(file.sha256)!); if (file.mode !== undefined) await handle.chmod(file.mode); }
    finally { await handle.close(); }
  }
}
