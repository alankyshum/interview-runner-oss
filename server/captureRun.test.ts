// @vitest-environment node
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { initializeWorkspaceGit } from './sandboxGit';
const exec = promisify(execFile);

describe('captured sandbox runs', () => {
  it('fails before running tests when Git is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-run-no-git-')); const workspace = join(root, 'workspace');
    try {
      await mkdir(workspace); await writeFile(join(workspace, 'value.txt'), 'initial'); await initializeWorkspaceGit(workspace);
      const marker = join(root, 'started'); const fake = join(root, 'fake-run.mjs');
      await writeFile(fake, `import {writeFile} from 'node:fs/promises'; await writeFile(process.env.MARKER,'started');`);
      const env = { ...process.env, PATH: root, IR_WORKSPACE: workspace, IR_RUN_TESTS: fake, MARKER: marker };
      await expect(exec(process.execPath, [resolve('sandbox/capture-run.mjs'), JSON.stringify([['--mode', 'workspace']])], { env })).rejects.toThrow('IR_GIT_UNAVAILABLE: Git is required for workspace commits');
      expect(await access(marker).then(() => true, () => false)).toBe(false);
      expect((await exec('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('commits changed runs, reuses unchanged HEAD, and never commits acceptance files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-run-commit-')); const workspace = join(root, 'workspace');
    try {
      await mkdir(workspace); await writeFile(join(workspace, 'value.txt'), 'initial'); await initializeWorkspaceGit(workspace);
      await mkdir(join(workspace, '.ir-acceptance')); await writeFile(join(workspace, '.ir-acceptance', 'secret'), 'private'); await writeFile(join(workspace, 'value.txt'), 'changed');
      const fake = join(root, 'fake-run.mjs'); await writeFile(fake, `process.stdout.write('IR_RESULT {"status":"passed","diagnostics":[],"tests":[]}\\n');`);
      const env = { ...process.env, IR_WORKSPACE: workspace, IR_RUN_TESTS: fake, IR_NODE_MODULES: resolve('node_modules') };
      const capture = async () => JSON.parse((await exec(process.execPath, [resolve('sandbox/capture-run.mjs'), JSON.stringify([['--mode', 'workspace']])], { env })).stdout.match(/^IR_RESULT (.+)$/m)![1]);
      const first = await capture(); const second = await capture(); expect(second.commitSha).toBe(first.commitSha);
      const tree = await exec('git', ['-C', workspace, 'ls-tree', '-r', '--name-only', first.commitSha]); expect(tree.stdout).toBe('value.txt\n');
      const count = await exec('git', ['-C', workspace, 'rev-list', '--count', 'HEAD']); expect(count.stdout.trim()).toBe('2');
      expect(first.workspaceFiles.files[0].content).toBe('changed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('tests and reads files from the same immutable workspace revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-run-test-')); const workspace = join(root, 'workspace'); const marker = join(root, 'started');
    await mkdir(workspace); await writeFile(join(workspace, 'value.txt'), 'initial'); await initializeWorkspaceGit(workspace); await writeFile(join(workspace, 'value.txt'), 'before');
    const fake = join(root, 'fake-run.mjs'); await writeFile(fake, `import {readFile,writeFile} from 'node:fs/promises';\nawait writeFile(process.env.MARKER,'1');\nawait new Promise(r=>setTimeout(r,100));\nconst value=await readFile(process.env.IR_WORKSPACE+'/value.txt','utf8');\nprocess.stdout.write('IR_RESULT '+JSON.stringify({status:'passed',diagnostics:[],tests:[{name:value,status:'passed'}]})+'\\n');\n`);
    const child = spawn(process.execPath, [resolve('sandbox/capture-run.mjs'), JSON.stringify([['--mode', 'workspace']])], { env: { ...process.env, IR_WORKSPACE: workspace, IR_RUN_TESTS: fake, IR_NODE_MODULES: resolve('node_modules'), MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      for (let count = 0; count < 100; count++) { if (await access(marker).then(() => true, () => false)) break; await new Promise((done) => setTimeout(done, 5)); }
      await writeFile(join(workspace, 'value.txt'), 'after');
      const code = await new Promise<number | null>((done) => child.once('close', done)); expect(code, output).toBe(0);
      const envelope = JSON.parse(output.match(/^IR_RESULT (.+)$/m)![1]); expect(envelope.commitSha).toMatch(/^[a-f0-9]{40,64}$/); expect(envelope.workspaceFiles.files.find((file: any) => file.path === 'value.txt').content).toBe('before'); expect(envelope.results[0].tests[0].name).toBe('before'); expect(await readFile(join(workspace, 'value.txt'), 'utf8')).toBe('after');
    } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
  });
  it('isolates each test envelope from mutations made by an earlier envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-run-isolation-')); const workspace = join(root, 'workspace'); await mkdir(workspace); await writeFile(join(workspace, 'value.txt'), 'captured'); await initializeWorkspaceGit(workspace);
    const fake = join(root, 'fake-run.mjs'); await writeFile(fake, `import {readFile,writeFile} from 'node:fs/promises';\nconst file=process.env.IR_WORKSPACE+'/value.txt';\nconst mode=process.argv[process.argv.indexOf('--mode')+1];\nconst before=await readFile(file,'utf8');\nif(mode==='workspace') await writeFile(file,'mutated');\nprocess.stdout.write('IR_RESULT '+JSON.stringify({status:'passed',diagnostics:[],tests:[{name:before,status:'passed'}]})+'\\n');\n`);
    const child = spawn(process.execPath, [resolve('sandbox/capture-run.mjs'), JSON.stringify([['--mode', 'workspace'], ['--mode', 'acceptance']])], { env: { ...process.env, IR_WORKSPACE: workspace, IR_RUN_TESTS: fake, IR_NODE_MODULES: resolve('node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    try { const code = await new Promise<number | null>((done) => child.once('close', done)); expect(code, output).toBe(0); const envelope = JSON.parse(output.match(/^IR_RESULT (.+)$/m)![1]); expect(envelope.results.map((result: any) => result.tests[0].name)).toEqual(['captured', 'captured']); expect(envelope.workspaceFiles.files.find((file: any) => file.path === 'value.txt').content).toBe('captured'); expect(await readFile(join(workspace, 'value.txt'), 'utf8')).toBe('captured'); }
    finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
  });
  it('rejects absolute and escaping learner symlinks before running an envelope', async () => {
    for (const target of ['absolute', 'escaping']) {
      const root = await mkdtemp(join(tmpdir(), `capture-run-${target}-symlink-`)); const workspace = join(root, 'workspace'); const outside = join(root, 'outside.txt'); const marker = join(root, 'runner-started'); await mkdir(join(workspace, 'nested'), { recursive: true }); await writeFile(outside, 'outside'); await writeFile(join(workspace, 'value.txt'), 'captured');
      await initializeWorkspaceGit(workspace); const link = target === 'absolute' ? join(workspace, 'absolute-link') : join(workspace, 'nested/escape-link'); await symlink(target === 'absolute' ? outside : '../../outside.txt', link);
      const fake = join(root, 'fake-run.mjs'); await writeFile(fake, `import {writeFile} from 'node:fs/promises'; await writeFile(process.env.MARKER,'started'); process.stdout.write('IR_RESULT {"status":"passed","diagnostics":[],"tests":[]}\\n');`);
      const child = spawn(process.execPath, [resolve('sandbox/capture-run.mjs'), JSON.stringify([['--mode', 'workspace']])], { env: { ...process.env, IR_WORKSPACE: workspace, IR_RUN_TESTS: fake, IR_NODE_MODULES: resolve('node_modules'), MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      try { const code = await new Promise<number | null>((done) => child.once('close', done)); expect(code).not.toBe(0); expect(output).toContain('Workspace symlinks are not allowed in captured runs'); expect(output).toContain(target === 'absolute' ? 'absolute-link' : 'nested/escape-link'); expect(await access(marker).then(() => true, () => false)).toBe(false); expect(await readFile(outside, 'utf8')).toBe('outside'); }
      finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
    }
  });
});
