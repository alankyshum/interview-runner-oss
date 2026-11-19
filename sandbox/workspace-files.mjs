import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const workspaceFileLimits = Object.freeze({ files: 2000, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
export const workspaceFileExcluded = new Set(['node_modules', '.git', '.ir-acceptance', 'dist', 'build', 'coverage', '__pycache__', '.pytest_cache', '.venv']);

export function safeWorkspacePath(root, candidate) {
  const path = resolve(root, candidate);
  return path === resolve(root) || path.startsWith(`${resolve(root)}${sep}`) ? path : undefined;
}
export async function captureWorkspaceRevision(source, destination) {
  const root = resolve(source);
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (workspaceFileExcluded.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name); const info = await lstat(absolute); const path = relative(root, absolute).replaceAll('\\', '/');
      // Captured runs deliberately reject learner symlinks instead of copying or
      // following them. The captured files and every tested envelope contain
      // the same regular-file-only revision; node_modules is injected separately.
      if (info.isSymbolicLink()) throw new Error(`Workspace symlinks are not allowed in captured runs: ${path}`);
      const target = safeWorkspacePath(destination, path); if (!target) throw new Error(`Invalid captured workspace path: ${path}`);
      if (info.isDirectory()) { await mkdir(target, { recursive: true }); await walk(absolute); continue; }
      if (!info.isFile()) continue;
      await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, await readFile(absolute), { mode: info.mode & 0o777 }); await chmod(target, info.mode & 0o777);
    }
  }
  await mkdir(destination, { recursive: true }); await walk(root);
}

export async function readWorkspaceFiles(root, limits = workspaceFileLimits) {
  const files = []; let totalBytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (workspaceFileExcluded.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name); const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await walk(absolute); continue; }
      if (!info.isFile()) continue;
      if (info.size > limits.fileBytes) throw new Error('Workspace file limit exceeded');
      totalBytes += info.size;
      if (totalBytes > limits.totalBytes) throw new Error('Workspace total limit exceeded');
      if (files.length >= limits.files) throw new Error('Workspace file count limit exceeded');
      const bytes = await readFile(absolute); const path = relative(root, absolute).replaceAll('\\', '/');
      files.push(bytes.includes(0) ? { path, size: bytes.length, mode: info.mode & 0o777, binary: true, sha256: createHash('sha256').update(bytes).digest('hex') } : { path, size: bytes.length, mode: info.mode & 0o777, content: bytes.toString('utf8') });
    }
  }
  await walk(resolve(root)); files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = await readWorkspaceFiles(process.env.IR_WORKSPACE ?? process.cwd());
  process.stdout.write(`IR_RESULT ${JSON.stringify(value)}\n`);
}
