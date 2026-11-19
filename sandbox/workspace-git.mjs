import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { safeWorkspacePath, workspaceFileExcluded, workspaceFileLimits } from './workspace-files.mjs';

const exec = promisify(execFile);
const excluded = [...workspaceFileExcluded].filter((name) => name !== '.git').concat(['.ir-seeded', '.ruff_cache', '.mypy_cache', '.tox']);
const begin = '# BEGIN interview-runner exclusions';
const end = '# END interview-runner exclusions';

export async function ensureWorkspaceExclusions(gitDirectory) {
  const infoPath = join(gitDirectory, 'info');
  if (!(await lstat(infoPath)).isDirectory()) throw new Error('Invalid Git info directory');
  const directory = await open(infoPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  // Linux allows path operations relative to a pinned directory descriptor;
  // on other platforms the caller and workspace share the same user privileges.
  const base = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : infoPath;
  const file = join(base, 'exclude'); const temporary = join(base, `.exclude-${randomUUID()}`);
  try {
  let existing = '';
  try { const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { if (!(await input.stat()).isFile()) throw new Error('Invalid Git exclude file'); existing = await input.readFile('utf8'); } finally { await input.close(); } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const start = existing.indexOf(begin); const finish = existing.indexOf(end);
  if ((start === -1) !== (finish === -1) || (start !== -1 && finish < start)) throw new Error('Invalid runner Git exclusions');
  if (start !== -1) existing = existing.slice(0, start) + existing.slice(finish + end.length).replace(/^\r?\n/, '');
  const block = `${begin}\n${excluded.map((name) => `${name}/\n${name}`).join('\n')}\n.ir-seeded\n${end}\n`;
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { await output.writeFile(`${existing && !existing.endsWith('\n') ? `${existing}\n` : existing}${block}`); } finally { await output.close(); }
  await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); await directory.close(); }
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export const gitOverrides = (workspace) => ['-c', `safe.directory=${workspace}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external='];
const gitArgs = (workspace, gitDirectory) => [...gitOverrides(workspace), '--git-dir', gitDirectory, '--work-tree', workspace];
export const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_AUTHOR_NAME: 'Interview Runner', GIT_AUTHOR_EMAIL: 'runner@localhost', GIT_COMMITTER_NAME: 'Interview Runner', GIT_COMMITTER_EMAIL: 'runner@localhost' };
const gitCommand = (workspace, gitDirectory) => async (args) => (await exec('git', [...gitArgs(workspace, gitDirectory), ...args], { cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: gitEnv })).stdout;

export async function stageWorkspace(workspace, gitDirectory) {
  const git = gitCommand(workspace, gitDirectory);
  await ensureWorkspaceExclusions(gitDirectory);
  // Ignore rules can be overridden by a workspace .gitignore, and tracked files
  // stay tracked. Never commit an index containing excluded paths.
  const checkIndex = async () => {
    const tracked = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
    const unsafe = tracked.find((path) => path.split('/').some((part) => excluded.includes(part)));
    if (unsafe) throw new Error(`Excluded path is already tracked: ${unsafe}`);
  };
  await checkIndex();
  await git(['add', '-A', '--', '.', ...excluded.flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]), ':(exclude,glob)**/.ir-seeded']);
  await checkIndex();
}

export async function commitWorkspace(workspace, gitDirectory, message = timestamp(new Date())) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(message)) throw new Error('Invalid commit timestamp');
  const git = gitCommand(workspace, gitDirectory);
  await stageWorkspace(workspace, gitDirectory);
  const changed = await git(['diff', '--cached', '--quiet', '--exit-code', '--no-ext-diff', '--no-textconv']).then(() => false, (error) => { if (error.code === 1) return true; throw error; });
  if (changed) await git(['commit', '--quiet', '-m', message]);
  const sha = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid workspace commit');
  return sha;
}

async function commitBlobs(workspace, gitDirectory, sha) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) throw new Error('Invalid workspace commit');
  const args = gitArgs(workspace, gitDirectory);
  const listing = (await exec('git', [...args, 'ls-tree', '-r', '-l', '-z', sha], { cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: gitEnv })).stdout;
  const entries = []; let totalBytes = 0;
  for (const entry of listing.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid workspace commit tree');
    const [, mode, type, object, rawSize, path] = match;
    if (path.split('/').some((part) => workspaceFileExcluded.has(part))) continue;
    if (mode === '120000') throw new Error(`Workspace symlinks are not allowed in captured runs: ${path}`);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Unsupported workspace commit entry: ${path}`);
    if (path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid captured workspace path: ${path}`);
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size > workspaceFileLimits.fileBytes) throw new Error('Workspace file limit exceeded');
    totalBytes += size;
    if (totalBytes > workspaceFileLimits.totalBytes) throw new Error('Workspace total limit exceeded');
    if (entries.length >= workspaceFileLimits.files) throw new Error('Workspace file count limit exceeded');
    entries.push({ path, size, mode: parseInt(mode, 8) & 0o777, object });
  }
  if (!entries.length) return { entries, totalBytes };
  const output = await new Promise((resolve, reject) => {
    const child = spawn('git', [...args, 'cat-file', '--batch'], { cwd: workspace, env: gitEnv, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; const errors = []; let length = 0; let errorLength = 0; let oversized = false;
    child.stdout.on('data', (chunk) => { length += chunk.length; if (length > workspaceFileLimits.totalBytes + entries.length * 128) { oversized = true; child.kill(); } else chunks.push(chunk); });
    child.stderr.on('data', (chunk) => { errorLength += chunk.length; if (errorLength <= 8192) errors.push(chunk); });
    child.on('error', reject); child.stdin.on('error', reject);
    child.on('close', (code) => { if (oversized) reject(new Error('Workspace commit batch output exceeded limit')); else if (code !== 0) reject(new Error(`Git cat-file failed (${code}): ${Buffer.concat(errors).toString('utf8')}`)); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(entries.map(({ object }) => `${object}\n`).join(''));
  });
  let offset = 0;
  for (const entry of entries) {
    const end = output.indexOf(10, offset); if (end < 0 || output.subarray(offset, end).toString() !== `${entry.object} blob ${entry.size}`) throw new Error('Invalid workspace commit blob header');
    offset = end + 1; entry.bytes = output.subarray(offset, offset + entry.size); offset += entry.size;
    if (entry.bytes.length !== entry.size || output[offset++] !== 10) throw new Error('Workspace commit blob size mismatch');
  }
  if (offset !== output.length) throw new Error('Invalid workspace commit batch output');
  return { entries, totalBytes };
}

export async function materializeCommit(workspace, gitDirectory, sha, destination) {
  const { entries } = await commitBlobs(workspace, gitDirectory, sha);
  await mkdir(destination, { recursive: true });
  for (const { path, mode, bytes } of entries) {
    const target = safeWorkspacePath(destination, path); if (!target || target === destination) throw new Error(`Invalid captured workspace path: ${path}`);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { mode, flag: 'wx' }); await chmod(target, mode);
  }
}

export async function readCommitFiles(workspace, gitDirectory, sha) {
  const { entries, totalBytes } = await commitBlobs(workspace, gitDirectory, sha);
  const files = entries.map(({ path, size, mode, bytes }) => { const file = { path, size, mode }; return bytes.includes(0) ? { ...file, binary: true, sha256: createHash('sha256').update(bytes).digest('hex') } : { ...file, content: bytes.toString('utf8') }; });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'exclude' && process.argv[3]) await ensureWorkspaceExclusions(process.argv[3]);
  else if (process.argv[2] === 'stage' && process.argv[3] && process.argv[4]) await stageWorkspace(process.argv[3], process.argv[4]);
  else if (process.argv[2] === 'commit' || process.argv[2] === 'commit-files') {
    const workspace = process.env.IR_WORKSPACE ?? process.cwd();
    const directory = (await exec('git', [...gitOverrides(workspace), '-C', workspace, 'rev-parse', '--absolute-git-dir'], { env: gitEnv })).stdout.trim();
    const commitSha = await commitWorkspace(workspace, directory, process.argv[3] || undefined);
    const files = process.argv[2] === 'commit-files' ? await readCommitFiles(workspace, directory, commitSha) : {};
    process.stdout.write(`IR_RESULT ${JSON.stringify({ commitSha, ...files })}\n`);
  }
  else throw new Error('Invalid workspace Git command');
}
