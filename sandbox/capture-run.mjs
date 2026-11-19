import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { safeWorkspacePath, readWorkspaceFiles } from './workspace-files.mjs';
import { commitWorkspace, gitEnv, gitOverrides, materializeCommit } from './workspace-git.mjs';

const source = process.env.IR_WORKSPACE ?? process.cwd();
const runs = JSON.parse(process.argv[2] ?? '[]');
if (!Array.isArray(runs) || !runs.length || runs.some((args) => !Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) throw new Error('Invalid captured run arguments');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'ir-captured-run-')));
const revision = join(directory, 'revision');
const exec = promisify(execFile);
const cap = 4 * 1024 * 1024;
const run = (args, workspace) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [process.env.IR_RUN_TESTS ?? '/opt/ir/tools/run-tests.mjs', ...args], { cwd: workspace, env: { ...process.env, IR_WORKSPACE: workspace }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let size = 0; let settled = false;
  const append = (raw) => { const chunk = Buffer.from(raw); size += chunk.length; if (size > cap) { child.kill('SIGKILL'); if (!settled) { settled = true; reject(new Error('Test output limit exceeded')); } return; } chunks.push(chunk); };
  child.stdout.on('data', append); child.stderr.on('data', append); child.once('error', (error) => { if (!settled) { settled = true; reject(error); } }); child.once('close', (code) => { if (settled) return; settled = true; if (code !== 0) reject(new Error(`Captured test run failed (${code ?? 'unknown'})`)); else { const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter((line) => line.startsWith('IR_RESULT ')); if (lines.length !== 1) reject(new Error('Captured test run returned an invalid result')); else { try { resolve(JSON.parse(lines[0].slice('IR_RESULT '.length))); } catch { reject(new Error('Captured test run returned invalid JSON')); } } } });
});
const materialize = async (workspaceFiles, workspace) => {
  await mkdir(workspace, { recursive: true });
  for (const file of workspaceFiles.files) {
    const sourcePath = safeWorkspacePath(revision, file.path); const target = safeWorkspacePath(workspace, file.path);
    if (!sourcePath || !target) throw new Error(`Invalid captured workspace path: ${file.path}`);
    const bytes = await readFile(sourcePath);
    const valid = bytes.length === file.size && (file.binary ? createHash('sha256').update(bytes).digest('hex') === file.sha256 : bytes.toString('utf8') === file.content);
    if (!valid) throw new Error(`Captured workspace revision changed: ${file.path}`);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { mode: file.mode }); await chmod(target, file.mode);
  }
};
try {
  const gitDir = (await exec('git', [...gitOverrides(source), '-C', source, 'rev-parse', '--absolute-git-dir'], { env: gitEnv })).stdout.trim();
  const commitSha = await commitWorkspace(source, gitDir, process.argv[3] || undefined);
  await materializeCommit(source, gitDir, commitSha, revision);
  const workspaceFiles = await readWorkspaceFiles(revision);
  const results = [];
  for (const [index, args] of runs.entries()) {
    const workspace = join(directory, `run-${index}`);
    await materialize(workspaceFiles, workspace);
    await symlink(process.env.IR_NODE_MODULES ?? '/opt/ir/node_modules', join(workspace, 'node_modules'));
    results.push(await run(args, workspace));
  }
  process.stdout.write(`IR_RESULT ${JSON.stringify({ commitSha, workspaceFiles, results })}\n`);
} catch (error) {
  if (error.code === 'ENOENT' && error.syscall === 'spawn git') throw new Error('IR_GIT_UNAVAILABLE: Git is required for workspace commits', { cause: error });
  throw error;
} finally { await rm(directory, { recursive: true, force: true }); }
