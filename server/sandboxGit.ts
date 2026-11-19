import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { packageRoot } from './packageRoot';

const run = promisify(execFile);
const workspaceGitTool = join(packageRoot, 'sandbox/workspace-git.mjs');
export const initialWorkspaceCommit = 'Initial drill workspace';
export function localCommitTimestamp(date = new Date(), timeZone?: unknown): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  if (typeof timeZone === 'string' && timeZone.length > 0 && timeZone.length <= 128) {
    let formatter: Intl.DateTimeFormat | undefined;
    try { formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }); } catch (error) { if (!(error instanceof RangeError)) throw error; }
    if (formatter) {
      const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
      const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3);
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
    }
  }
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
const safeGit = (workspace: string) => ['-c', `safe.directory=${workspace}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external='];
const gitOptions = { timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Interview Runner', GIT_AUTHOR_EMAIL: 'runner@localhost', GIT_COMMITTER_NAME: 'Interview Runner', GIT_COMMITTER_EMAIL: 'runner@localhost' } };
const git = (workspace: string, args: string[]) => run('git', [...safeGit(workspace), '-C', workspace, ...args], gitOptions);
export function workspaceGitDirectory(courseId: string, drillId: string, root = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'interview-runner', 'workspace-git')): string {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(courseId) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(drillId)) throw new Error('Invalid workspace identity');
  return join(root, courseId, `${drillId}.git`);
}

// Podman initializes and commits the repository only after dropping into the
// sandbox user. The host creates the empty mount and its workspace pointer.
export async function preparePodmanWorkspaceGit(workspace: string, directory: string, pointerDirectory: string): Promise<void> {
  await mkdir(dirname(directory), { recursive: true });
  let created = false;
  try { await mkdir(directory); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (created) await writeFile(join(directory, 'interview-runner-pending'), 'pending\n', { flag: 'wx' });
  else {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid workspace Git directory');
    try { if (!(await lstat(join(directory, 'HEAD'))).isFile() || !(await lstat(join(directory, 'objects'))).isDirectory()) throw new Error('Invalid workspace Git repository'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const entries = await readdir(directory);
      if (entries.some((entry) => !['interview-runner-pending', 'interview-runner-sandbox'].includes(entry)) || !(await lstat(join(directory, 'interview-runner-pending'))).isFile()) throw new Error('Invalid workspace Git repository');
    }
  }
  await writeFile(join(workspace, '.git'), `gitdir: ${pointerDirectory}\n`, { flag: 'wx' });
}

export async function initializeWorkspaceGit(workspace: string, separateGitDirectory?: string, pointerDirectory?: string): Promise<void> {
  if (separateGitDirectory) {
    const pointer = join(workspace, '.git');
    await mkdir(dirname(separateGitDirectory), { recursive: true });
    let existing = false;
    try { if (!(await lstat(separateGitDirectory)).isDirectory()) throw new Error('Invalid workspace Git directory'); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const directory = existing ? await realpath(separateGitDirectory) : separateGitDirectory;
    let pointerExists = false;
      try { const info = await lstat(pointer); if (!info.isFile()) throw new Error('Workspace already contains Git metadata'); const content = await readFile(pointer, 'utf8'); if (content.trim() !== `gitdir: ${pointerDirectory ?? directory}`) throw new Error('Workspace already contains Git metadata'); pointerExists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (!(await lstat(join(directory, 'HEAD'))).isFile() || !(await lstat(join(directory, 'objects'))).isDirectory()) throw new Error('Invalid workspace Git repository');
      await run(process.execPath, [workspaceGitTool, 'exclude', directory], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      if (!pointerExists) await writeFile(pointer, `gitdir: ${pointerDirectory ?? directory}\n`, { flag: 'wx' });
      return;
    } else {
      if (pointerExists) throw new Error('Workspace Git pointer has no repository');
      await run('git', [...safeGit(workspace), 'init', '--quiet', `--separate-git-dir=${directory}`, workspace], gitOptions);
      if (pointerDirectory) await writeFile(pointer, `gitdir: ${pointerDirectory}\n`);
    }
  } else {
    await git(workspace, ['init', '--quiet']);
  }
  const directory = separateGitDirectory ? await realpath(separateGitDirectory) : (await git(workspace, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const runGit = separateGitDirectory ? (args: string[]) => run('git', [...safeGit(workspace), '--git-dir', directory, '--work-tree', workspace, ...args], gitOptions) : (args: string[]) => git(workspace, args);
  await run(process.execPath, [workspaceGitTool, 'exclude', directory], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  await runGit(['config', '--local', 'user.name', 'Interview Runner']);
  await runGit(['config', '--local', 'user.email', 'runner@localhost']);
  try { await runGit(['rev-parse', '--verify', 'HEAD']); return; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; /* a fresh workspace needs its baseline */ }
  await run(process.execPath, [workspaceGitTool, 'stage', workspace, directory], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  await runGit(['commit', '--quiet', '--allow-empty', '-m', initialWorkspaceCommit]);
}

export async function removeWorkspaceGitPointer(workspace: string, separateGitDirectory: string, pointerDirectory?: string): Promise<void> {
  const pointer = join(workspace, '.git');
  try {
    if (!(await lstat(pointer)).isFile()) return;
    const content = await readFile(pointer, 'utf8');
    if (content.trim() === `gitdir: ${pointerDirectory ?? await realpath(separateGitDirectory)}`) await rm(pointer, { force: true });
  } catch { /* never remove unknown or already-removed workspace metadata */ }
}
