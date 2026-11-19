import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initialWorkspaceCommit, initializeWorkspaceGit, localCommitTimestamp, removeWorkspaceGitPointer } from './sandboxGit';

const run = promisify(execFile); const roots: string[] = [];
const git = async (workspace: string, args: string[]) => (await run('git', ['-C', workspace, ...args], { encoding: 'utf8' })).stdout.trim();
const commit = async (workspace: string, directory: string) => (await run(process.execPath, ['--input-type=module', '-e', `import { commitWorkspace } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'sandbox/workspace-git.mjs')).href)}; console.log(await commitWorkspace(process.argv[1], process.argv[2]));`, workspace, directory], { encoding: 'utf8' })).stdout.trim();
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('sandbox Git baseline', () => {
  it('fails visibly when Git is unavailable during initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-missing-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git'); await mkdir(workspace);
    const script = `import { initializeWorkspaceGit } from './server/sandboxGit.ts'; await initializeWorkspaceGit(process.argv[1], process.argv[2]);`;
    await expect(run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, workspace, directory], { env: { ...process.env, PATH: root } })).rejects.toThrow('spawn git ENOENT');
    await expect(readFile(join(workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('formats the runner local offset, including non-hour offsets', () => {
    const date = new Date(2026, 9, 27, 12, 34, 56); date.getTimezoneOffset = () => 420;
    expect(localCommitTimestamp(date)).toBe('2026-10-27T12:34:56-07:00');
    date.getTimezoneOffset = () => -330;
    expect(localCommitTimestamp(date)).toBe('2026-10-27T12:34:56+05:30');
  });
  it('formats a fixed instant in the learner zone and falls back for invalid zones', () => {
    const date = new Date('2026-07-01T12:34:56Z');
    expect(localCommitTimestamp(date, 'America/Los_Angeles')).toBe('2026-07-01T05:34:56-07:00');
    expect(localCommitTimestamp(date, 'Asia/Kolkata')).toBe('2026-07-01T18:04:56+05:30');
    expect(localCommitTimestamp(date, 'UTC')).toBe('2026-07-01T12:34:56+00:00');
    for (const zone of [undefined, '', 'not/a-zone', 'x'.repeat(129), 42]) expect(localCommitTimestamp(date, zone)).toBe(localCommitTimestamp(date));
    expect(localCommitTimestamp(new Date('2026-01-01T12:34:56Z'), 'America/Los_Angeles')).toBe('2026-01-01T04:34:56-08:00');
  });
  it.each([false, true])('initializes a clean committed workspace (separate Git dir: %s)', async (separate) => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-')); roots.push(root); const workspace = join(root, 'workspace'); const gitDirectory = join(root, 'sandbox-git'); await mkdir(workspace); await writeFile(join(workspace, 'starter.ts'), 'export const starter = true;\n');
    await initializeWorkspaceGit(workspace, separate ? gitDirectory : undefined);
    expect(await git(workspace, ['status', '--porcelain'])).toBe(''); expect(await git(workspace, ['log', '-1', '--format=%s'])).toBe(initialWorkspaceCommit); expect(await git(workspace, ['config', '--local', 'user.name'])).toBe('Interview Runner'); expect(await git(workspace, ['config', '--local', 'user.email'])).toBe('runner@localhost'); expect(await readFile(join(workspace, 'starter.ts'), 'utf8')).toContain('starter = true');
    if (separate) { expect((await readFile(join(workspace, '.git'), 'utf8')).trim()).toBe(`gitdir: ${await realpath(gitDirectory)}`); await removeWorkspaceGitPointer(workspace, gitDirectory); await expect(readFile(join(workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' }); }
  });
  it('reuses a separate repository after teardown without rewriting its history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-persist-')); roots.push(root); const workspace = join(root, 'workspace'); const gitDirectory = join(root, 'state', 'course', 'drill.git');
    await mkdir(workspace); await writeFile(join(workspace, 'starter.ts'), 'first\n');
    await initializeWorkspaceGit(workspace, gitDirectory);
    await writeFile(join(workspace, 'starter.ts'), 'second\n'); await git(workspace, ['add', '-A']); await git(workspace, ['commit', '-m', 'saved']);
    const head = await git(workspace, ['rev-parse', 'HEAD']);
    await removeWorkspaceGitPointer(workspace, gitDirectory);
    await initializeWorkspaceGit(workspace, gitDirectory);
    expect(await git(workspace, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(workspace, ['log', '--format=%s'])).toBe(`saved\n${initialWorkspaceCommit}`);
  });
  it.each(['exclude', 'info'])('refuses a symlinked Git %s without writing outside the repository', async (part) => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-link-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git'); const outside = join(root, 'outside');
    await mkdir(workspace); await initializeWorkspaceGit(workspace, directory); await removeWorkspaceGitPointer(workspace, directory);
    if (part === 'exclude') { await writeFile(outside, 'untouched'); await rm(join(directory, 'info/exclude')); await symlink(outside, join(directory, 'info/exclude')); }
    else { await mkdir(outside); await writeFile(join(outside, 'exclude'), 'untouched'); await rm(join(directory, 'info'), { recursive: true }); await symlink(outside, join(directory, 'info')); }
    await expect(initializeWorkspaceGit(workspace, directory)).rejects.toThrow();
    expect(await readFile(part === 'exclude' ? outside : join(outside, 'exclude'), 'utf8')).toBe('untouched');
  });
  it('does not execute configured Git hooks or fsmonitor during runner commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-hooks-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git'); const hooks = join(root, 'hooks'); const marker = join(root, 'executed');
    await mkdir(workspace); await writeFile(join(workspace, 'starter'), 'first'); await initializeWorkspaceGit(workspace, directory); await mkdir(hooks);
    const script = `#!/bin/sh\nprintf executed > '${marker}'\n`; await writeFile(join(hooks, 'pre-commit'), script); await chmod(join(hooks, 'pre-commit'), 0o755); await writeFile(join(root, 'fsmonitor'), script); await chmod(join(root, 'fsmonitor'), 0o755);
    await git(workspace, ['config', 'core.hooksPath', hooks]); await git(workspace, ['config', 'core.fsmonitor', join(root, 'fsmonitor')]);
    await writeFile(join(workspace, 'starter'), 'second'); await commit(workspace, directory); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await removeWorkspaceGitPointer(workspace, directory); await initializeWorkspaceGit(workspace, directory); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not replace unrelated workspace metadata or invalid repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-unknown-')); roots.push(root); const workspace = join(root, 'workspace'); const gitDirectory = join(root, 'history.git');
    await mkdir(workspace); await writeFile(join(workspace, '.git'), 'gitdir: /unrelated\n');
    await expect(initializeWorkspaceGit(workspace, gitDirectory)).rejects.toThrow('Workspace already contains Git metadata');
    expect(await readFile(join(workspace, '.git'), 'utf8')).toBe('gitdir: /unrelated\n');
    await rm(join(workspace, '.git')); await mkdir(gitDirectory);
    await expect(initializeWorkspaceGit(workspace, gitDirectory)).rejects.toThrow();
    await expect(readFile(join(workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('creates a timestamped commit for changes and reuses HEAD when unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-commit-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git');
    await mkdir(workspace); await writeFile(join(workspace, 'starter.ts'), 'first\n'); await initializeWorkspaceGit(workspace, directory);
    const initial = await git(workspace, ['rev-parse', 'HEAD']); expect(await commit(workspace, directory)).toBe(initial);
    await writeFile(join(workspace, 'starter.ts'), 'second\n'); const changed = await commit(workspace, directory); expect(changed).not.toBe(initial); expect(await commit(workspace, directory)).toBe(changed);
    expect(await git(workspace, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await git(workspace, ['log', '-1', '--format=%an <%ae> %s'])).toMatch(/^Interview Runner <runner@localhost> \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });
  it('excludes hidden acceptance and generated files on initialization and reuse, even with negated gitignore rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-excluded-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git');
    await mkdir(join(workspace, 'nested', '.ir-acceptance'), { recursive: true }); await mkdir(join(workspace, 'node_modules'), { recursive: true });
    await writeFile(join(workspace, '.gitignore'), '!**/.ir-acceptance/\n!**/.ir-acceptance/**\n!node_modules/\n!node_modules/**\n'); await writeFile(join(workspace, 'nested/.ir-acceptance/secret'), 'private'); await writeFile(join(workspace, 'node_modules/package'), 'dependency'); await writeFile(join(workspace, 'starter.ts'), 'first');
    await initializeWorkspaceGit(workspace, directory); expect(await git(workspace, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('.gitignore\nstarter.ts');
    await writeFile(join(directory, 'info/exclude'), '# custom\n'); await removeWorkspaceGitPointer(workspace, directory); await initializeWorkspaceGit(workspace, directory);
    expect(await readFile(join(directory, 'info/exclude'), 'utf8')).toContain('.ir-acceptance/');
    await writeFile(join(workspace, 'starter.ts'), 'second'); await commit(workspace, directory); expect(await git(workspace, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('.gitignore\nstarter.ts');
  });
  it('refuses to create commits with previously tracked excluded files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-tracked-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git');
    await mkdir(workspace); await writeFile(join(workspace, 'starter.ts'), 'first'); await initializeWorkspaceGit(workspace, directory);
    await mkdir(join(workspace, '.ir-acceptance')); await writeFile(join(workspace, '.ir-acceptance/secret'), 'private'); await git(workspace, ['add', '-f', '.ir-acceptance/secret']);
    await expect(commit(workspace, directory)).rejects.toThrow('Excluded path is already tracked'); expect(await git(workspace, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });
  it('uses the exclusion guard for the stage-commit command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-stage-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git');
    await mkdir(workspace); await writeFile(join(workspace, 'starter.ts'), 'first'); await initializeWorkspaceGit(workspace, directory);
    await writeFile(join(workspace, 'starter.ts'), 'second');
    const args = [join(process.cwd(), 'sandbox/workspace-git.mjs'), 'commit', '2026-10-27T12:34:56-07:00'];
    const options = { cwd: workspace, env: { ...process.env, IR_WORKSPACE: workspace } };
    const output = (await run(process.execPath, args, options)).stdout; const sha = JSON.parse(output.trim().slice('IR_RESULT '.length)).commitSha;
    expect(sha).toBe(await git(workspace, ['rev-parse', 'HEAD']));
    expect(await git(workspace, ['log', '-1', '--format=%s'])).toBe('2026-10-27T12:34:56-07:00');
    await mkdir(join(workspace, '.ir-acceptance')); await writeFile(join(workspace, '.ir-acceptance/secret'), 'private'); await git(workspace, ['add', '-f', '.ir-acceptance/secret']);
    await expect(run(process.execPath, args, options)).rejects.toThrow('Excluded path is already tracked'); expect(await git(workspace, ['rev-parse', 'HEAD'])).toBe(sha);
  });
  it('reads handoff files from the committed tree, not the subsequently modified workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-files-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git');
    await mkdir(join(workspace, '.ir-acceptance'), { recursive: true }); await writeFile(join(workspace, '.ir-acceptance/secret'), 'private'); await writeFile(join(workspace, 'starter.ts'), 'committed'); await writeFile(join(workspace, 'binary'), Buffer.from([0, 1])); await initializeWorkspaceGit(workspace, directory);
    const sha = await commit(workspace, directory); await writeFile(join(workspace, 'starter.ts'), 'uncommitted');
    const script = `import { readCommitFiles } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'sandbox/workspace-git.mjs')).href)}; console.log(JSON.stringify(await readCommitFiles(process.argv[1], process.argv[2], process.argv[3])));`;
    const result = JSON.parse((await run(process.execPath, ['--input-type=module', '-e', script, workspace, directory, sha])).stdout);
    expect(result.files).toContainEqual(expect.objectContaining({ path: 'starter.ts', content: 'committed' })); expect(result.files).toContainEqual(expect.objectContaining({ path: 'binary', binary: true })); expect(JSON.stringify(result)).not.toContain('private');
    const output = (await run(process.execPath, [join(process.cwd(), 'sandbox/workspace-git.mjs'), 'commit-files', '2026-10-27T12:34:56-07:00'], { cwd: workspace, env: { ...process.env, IR_WORKSPACE: workspace } })).stdout;
    const handoff = JSON.parse(output.trim().slice('IR_RESULT '.length)); expect(handoff.commitSha).not.toBe(sha); expect(handoff.files).toContainEqual(expect.objectContaining({ path: 'starter.ts', content: 'uncommitted' }));
    expect(await git(workspace, ['log', '-1', '--format=%s'])).toBe('2026-10-27T12:34:56-07:00');
    const repeated = JSON.parse((await run(process.execPath, [join(process.cwd(), 'sandbox/workspace-git.mjs'), 'commit-files'], { cwd: workspace, env: { ...process.env, IR_WORKSPACE: workspace } })).stdout.trim().slice('IR_RESULT '.length)); expect(repeated.commitSha).toBe(handoff.commitSha);
  });
  it('materializes committed bytes and modes with plumbing without executing configured drivers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-plumbing-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git'); const destination = join(root, 'revision'); const marker = join(root, 'executed'); const hooks = join(root, 'hooks');
    await mkdir(workspace); await mkdir(hooks); await writeFile(join(workspace, '.gitattributes'), '* filter=x diff=x\n'); await writeFile(join(workspace, 'text'), 'committed\n'); await writeFile(join(workspace, 'binary'), Buffer.from([0, 1, 255])); await chmod(join(workspace, 'text'), 0o755); await initializeWorkspaceGit(workspace, directory);
    const sha = await git(workspace, ['rev-parse', 'HEAD']); const command = `touch '${marker}'`; await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    for (const [key, value] of [['filter.x.clean', command], ['filter.x.smudge', command], ['diff.x.textconv', command], ['core.hooksPath', hooks], ['core.fsmonitor', command]]) await git(workspace, ['config', key, value]);
    const script = `import { materializeCommit,readCommitFiles } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'sandbox/workspace-git.mjs')).href)}; await materializeCommit(process.argv[1],process.argv[2],process.argv[3],process.argv[4]); console.log(JSON.stringify(await readCommitFiles(process.argv[1],process.argv[2],process.argv[3])));`;
    const result = JSON.parse((await run(process.execPath, ['--input-type=module', '-e', script, workspace, directory, sha, destination])).stdout);
    expect(await readFile(join(destination, 'text'), 'utf8')).toBe('committed\n'); expect(await readFile(join(destination, 'binary'))).toEqual(Buffer.from([0, 1, 255])); expect(result.files).toContainEqual(expect.objectContaining({ path: 'text', mode: 0o755, content: 'committed\n' })); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('enforces handoff file size limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-files-limit-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git'); await mkdir(workspace); await writeFile(join(workspace, 'large'), Buffer.alloc(1024 * 1024 + 1)); await initializeWorkspaceGit(workspace, directory);
    await expect(run(process.execPath, [join(process.cwd(), 'sandbox/workspace-git.mjs'), 'commit-files'], { cwd: workspace, env: { ...process.env, IR_WORKSPACE: workspace } })).rejects.toThrow('Workspace file limit exceeded');
  });
  it('enforces handoff total size and file count limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-git-files-limits-')); roots.push(root); const workspace = join(root, 'workspace'); const directory = join(root, 'history.git'); await mkdir(workspace); await initializeWorkspaceGit(workspace, directory);
    const invoke = () => run(process.execPath, [join(process.cwd(), 'sandbox/workspace-git.mjs'), 'commit-files'], { cwd: workspace, env: { ...process.env, IR_WORKSPACE: workspace } });
    await Promise.all(Array.from({ length: 9 }, (_, i) => writeFile(join(workspace, `large-${i}`), Buffer.alloc(1024 * 1024)))); await expect(invoke()).rejects.toThrow('Workspace total limit exceeded');
    await Promise.all(Array.from({ length: 9 }, (_, i) => rm(join(workspace, `large-${i}`))));
    await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(workspace, `file-${i}`), ''))); await expect(invoke()).rejects.toThrow('Workspace file count limit exceeded');
  }, 30_000);
});
