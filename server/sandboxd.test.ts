import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { commandFor, createSandboxd, instanceLabel, PodmanDriver, sandboxLabel, sandboxNetworkName, tokenAllowed, validateSandboxSpec } from './sandboxd';
import { SandboxSettingsSync } from './sandboxSettings';
import { SandboxUiStateSync } from './sandboxUiState';
import { buildTar } from './tar';
import { listTrees, loadTree, openUserDb, saveTree } from './userData';

const valid = { id: '12345678-abcd', repoId: 'course', courseId: 'course-one', drillId: 'drill-one', kind: 'coding' as const, workspacePath: 'drills/course-one/drill-one', sourcePath: 'drills/course-one/drill-one/index.ts', testPath: 'drills/course-one/drill-one/index.test.ts' };

async function fixture() { const root = await mkdtemp(join(tmpdir(), 'sandboxd-mounts-')); const drill = join(root, valid.workspacePath); await mkdir(drill, { recursive: true }); await writeFile(join(drill, 'index.ts'), 'export {}'); await writeFile(join(drill, 'index.test.ts'), ''); return { root, allowlist: { course: { hostRoot: root, containerRoot: '/app/course-repos/course' } } }; }

describe('sandboxd boundary', () => {
  it('imports and starts without course link state', async () => {
    const state = await mkdtemp(join(tmpdir(), 'sandboxd-no-links-'));
    try {
      const script = `const { createSandboxd } = await import('./server/sandboxd.ts');
        const server = createSandboxd({ token: 'a'.repeat(64), allowlist: {}, driver: { list: async () => [] } });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/sandboxes', { headers: { authorization: 'Bearer ' + 'a'.repeat(64) } });
        if (!response.ok) throw new Error('sandboxd request failed: ' + response.status);
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));`;
      expect(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: state }, timeout: 15_000, encoding: 'utf8' })).toBe('');
    } finally { await rm(state, { recursive: true, force: true }); }
  });
  it('accepts workspace file reads and rejects the retired snapshot action', () => {
    expect(commandFor({ action: 'workspace-files' })).toEqual(['timeout', '30', 'node', '/opt/ir/tools/workspace-files.mjs']);
    expect(commandFor({ action: 'commit-files' })).toEqual(['timeout', '30', 'node', '/opt/ir/tools/workspace-git.mjs', 'commit-files', '']);
    expect(() => commandFor({ action: 'snapshot' } as any)).toThrow('Invalid exec action');
  });
  it('passes validated host commit timestamps to both commit paths', () => {
    const commitTimestamp = '2026-10-27T12:34:56-07:00';
    expect(commandFor({ action: 'capture-run', runs: [[]], commitTimestamp }).at(-1)).toBe(commitTimestamp);
    expect(commandFor({ action: 'stage-commit', stage: 1, commitTimestamp }).at(-1)).toBe(commitTimestamp);
    expect(() => commandFor({ action: 'capture-run', runs: [[]], commitTimestamp: '--bad' })).toThrow('Invalid commit timestamp');
  });
  it('accepts only canonical allowlisted drill mounts and no caller labels', async () => {
    const { root, allowlist } = await fixture(); try {
      await expect(validateSandboxSpec(valid, allowlist)).resolves.toEqual(valid);
      await expect(validateSandboxSpec({ ...valid, repoId: 'other' }, allowlist)).rejects.toThrow('Unknown course repository');
      await expect(validateSandboxSpec({ ...valid, sourcePath: '../secret' }, allowlist)).rejects.toThrow('Invalid sandbox path');
      await expect(validateSandboxSpec({ ...valid, workspacePath: 'drills/course-one/other' }, allowlist)).rejects.toThrow('escapes the drill');
      await expect(validateSandboxSpec({ ...valid, labels: { [sandboxLabel]: '0' } }, allowlist)).rejects.toThrow('unknown fields');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects symlink escapes in a file, directory, or allowlist ancestor', async () => {
    const { root, allowlist } = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'sandboxd-outside-'));
    try {
      await writeFile(join(outside, 'secret.ts'), 'secret');
      await rm(join(root, valid.sourcePath)); await symlink(join(outside, 'secret.ts'), join(root, valid.sourcePath));
      await expect(validateSandboxSpec(valid, allowlist)).rejects.toThrow('symbolic link');
      await rm(join(root, valid.sourcePath)); await writeFile(join(root, valid.sourcePath), 'export {}');
      const linkedDir = join(root, 'drills/course-one/linked'); await symlink(outside, linkedDir);
      await expect(validateSandboxSpec({ ...valid, drillId: 'linked', workspacePath: 'drills/course-one/linked', sourcePath: 'drills/course-one/linked/secret.ts', testPath: undefined }, allowlist)).rejects.toThrow('symbolic link');
      const parent = await mkdtemp(join(tmpdir(), 'sandboxd-parent-')); const rootLink = join(parent, 'courses'); await symlink(root, rootLink);
      await expect(validateSandboxSpec(valid, { course: { ...allowlist.course, hostRoot: rootLink } })).rejects.toThrow('symbolic link');
      await rm(parent, { recursive: true, force: true });
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it('compares the full bearer token', () => {
    const token = 'a'.repeat(64);
    expect(tokenAllowed(`Bearer ${token}`, token)).toBe(true);
    expect(tokenAllowed(`Bearer ${'a'.repeat(63)}`, token)).toBe(false);
    expect(tokenAllowed(undefined, token)).toBe(false);
  });

  it('requires token auth before invoking the driver', async () => {
    const list = vi.fn(async () => []); const driver = { list, create: vi.fn(), remove: vi.fn(), exec: vi.fn() } as any;
    const server = createSandboxd({ token: 'b'.repeat(64), allowlist: {}, driver }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      expect((await fetch(`${origin}/sandboxes`)).status).toBe(401);
      expect((await fetch(`${origin}/sandboxes`, { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } })).status).toBe(200);
      expect(list).toHaveBeenCalledTimes(1);
    } finally { server.close(); }
  });

  it('protects the health endpoint with the sandboxd bearer token', async () => {
    const health = vi.fn(async () => ({ oomKills: 1, memoryCurrent: 100, memoryPeak: 200, memoryMax: 300, extHostCrashes: 0 })); const server = createSandboxd({ token: 'b'.repeat(64), allowlist: {}, driver: { health } as any }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try { expect((await fetch(`${origin}/sandboxes/12345678/health`)).status).toBe(401); const response = await fetch(`${origin}/sandboxes/12345678/health`, { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } }); expect(await response.json()).toMatchObject({ oomKills: 1, extHostCrashes: 0 }); expect(health).toHaveBeenCalledWith('12345678'); } finally { server.close(); }
  });

  it('creates a sandbox with an init process', async () => {
    const { root, allowlist } = await fixture(); const socketDir = await mkdtemp(join(tmpdir(), 'sandboxd-init-')); const socket = join(socketDir, 'podman.sock'); let created: any;
    const server = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url?.includes('/containers/create?')) { created = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ Id: 'container' })); }
      else { response.writeHead(204); response.end(); }
    }); server.listen(socket); await once(server, 'listening');
    const driver = new PodmanDriver(socket, 'sandbox-image', socketDir, socketDir);
    try { await driver.create(valid, allowlist); expect(created.HostConfig.Init).toBe(true); expect(created.HostConfig.Memory).toBe(2560 * 1024 * 1024); expect(created.Env).toEqual(expect.arrayContaining(['GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory', `GIT_CONFIG_VALUE_0=/workspace/${valid.workspacePath}`])); }
    finally { (driver as any).settings.close(); (driver as any).ui.close(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); await rm(socketDir, { recursive: true, force: true }); }
  });

  it('mounts an existing review volume read-only without creating, changing, or deleting it', async () => {
    const { root, allowlist } = await fixture(); const state = await mkdtemp(join(tmpdir(), 'sandboxd-review-')); const socket = join(state, 'podman.sock'); const workspacePath = 'drills/course-one/drill-one/workspace'; await mkdir(join(root, workspacePath), { recursive: true }); await writeFile(join(root, workspacePath, 'index.ts'), 'export {}');
    const spec = { ...valid, kind: 'ai-coding' as const, workspacePath, sourcePath: `${workspacePath}/index.ts`, testPath: undefined, attemptNumber: 1, review: true }; const calls: string[] = []; let created: any; let present = true; let needsChown = false;
    const server = createHttpServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const url = request.url ?? ''; calls.push(`${request.method} ${url}`); response.setHeader('Content-Type', 'application/json'); if (url.includes('/volumes/')) { if (!present) response.writeHead(404).end(); else response.end(JSON.stringify({ Labels: { [sandboxLabel]: '1', [instanceLabel]: 'default', 'io.interview-runner.drill': 'course-one/drill-one/1' }, NeedsChown: needsChown })); } else if (url.includes('/containers/create?')) { created = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(201).end(JSON.stringify({ Id: 'container' })); } else if (url.includes('/containers/json?')) response.end(JSON.stringify([{ Names: [`/ir-default-sbx-${spec.id}`], Id: 'container', State: 'running', Labels: created.Labels }])); else response.writeHead(204).end(); }); server.listen(socket); await once(server, 'listening'); const driver = new PodmanDriver(socket, 'sandbox-image', state, state);
    try {
      expect(await validateSandboxSpec(spec, allowlist)).toMatchObject({ review: true, attemptNumber: 1 }); await expect(validateSandboxSpec({ ...spec, attemptNumber: undefined }, allowlist)).rejects.toThrow('Invalid review workspace');
      const record = await driver.create(spec, allowlist); expect(record.review).toBe(true); expect(created.HostConfig.Binds).toContain('ir-default-ws-course-one--drill-one--1:/workspace/drill-one-1:ro,nocopy'); expect(created.Env).toContain('IR_REVIEW=1'); expect(calls.some((call) => call.startsWith('POST /v1.41/volumes/create'))).toBe(false);
      for (const action of ['run', 'capture-run', 'commit-files', 'stage-commit'] as const) await expect(driver.exec(spec.id, { action })).rejects.toThrow('read-only'); await expect(driver.remove(spec.id, true)).rejects.toThrow('cannot delete'); expect(calls.some((call) => call.startsWith('DELETE /v1.41/volumes/'))).toBe(false);
      needsChown = true; await expect(driver.create({ ...spec, id: '87654321-abcd' }, allowlist)).rejects.toThrow('ownership changes'); needsChown = false; present = false; await expect(driver.create({ ...spec, id: '87654321-abcd' }, allowlist)).rejects.toThrow('Podman GET'); expect(calls.some((call) => call.startsWith('POST /v1.41/volumes/create'))).toBe(false);
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
  });

  it('retains coding Git history across Podman teardown and recreation', async () => {
    const { root, allowlist } = await fixture(); const state = await mkdtemp(join(tmpdir(), 'sandboxd-state-')); const socket = join(state, 'podman.sock'); const workspace = join(root, valid.workspacePath); const directory = join(state, '.workspace-git/course-one/drill-one.git'); const hostSettings = '/host/runner/sandbox'; const hostDirectory = join(hostSettings, '.workspace-git/course-one/drill-one.git'); let created: any; let active = false;
    vi.stubEnv('XDG_STATE_HOME', state);
    const server = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const url = request.url ?? ''; response.setHeader('Content-Type', 'application/json');
      if (url.includes('/containers/create?')) { created = JSON.parse(Buffer.concat(chunks).toString()); active = true; response.end(JSON.stringify({ Id: 'container' })); }
      else if (url.endsWith('/containers/container/start')) {
        // Simulate the image entrypoint; the real operation runs as the container user.
        try { await readFile(join(directory, 'interview-runner-pending')); const git = (...args: string[]) => execFileSync('git', ['--git-dir', directory, '--work-tree', workspace, ...args]); git('init', '-q'); git('config', 'user.name', 'Interview Runner'); git('config', 'user.email', 'runner@localhost'); git('add', '-A'); git('commit', '-qm', 'Initial drill workspace'); await rm(join(directory, 'interview-runner-pending')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        response.writeHead(204).end();
      }
      else if (url.includes('/containers/json?')) response.end(JSON.stringify(active ? [{ Names: [`/ir-default-sbx-${valid.id}`], Id: 'container', State: 'running', Labels: created.Labels }] : []));
      else if (url.endsWith('/containers/container/json')) response.end(JSON.stringify({ Config: { Labels: created.Labels } }));
      else if (request.method === 'DELETE') { active = false; response.writeHead(204).end(); }
      else response.writeHead(204).end();
    }); server.listen(socket); await once(server, 'listening'); const driver = new PodmanDriver(socket, 'sandbox-image', state, hostSettings);
    try {
      await driver.create(valid, allowlist); expect(created.HostConfig.Binds).toContain(`${hostDirectory}:/opt/ir/workspace-git:rw,U`); expect(created.HostConfig.Binds).toContain(`${await realpath(workspace)}:/workspace/${valid.workspacePath}:rw`); expect(await readFile(join(workspace, '.git'), 'utf8')).toBe('gitdir: /opt/ir/workspace-git\n');
      const git = (...args: string[]) => execFileSync('git', ['--git-dir', directory, '--work-tree', workspace, ...args], { encoding: 'utf8' }).trim();
      expect(git('log', '-1', '--format=%s')).toBe('Initial drill workspace'); await writeFile(join(workspace, 'index.ts'), 'export const changed = true;'); git('add', 'index.ts'); git('commit', '-m', 'test revision'); const head = git('rev-parse', 'HEAD');
      await driver.remove(valid.id); await expect(readFile(join(workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(git('rev-parse', 'HEAD')).toBe(head);
      const outside = join(state, 'outside'); await writeFile(outside, 'untouched'); await rm(join(directory, 'interview-runner-sandbox')); await symlink(outside, join(directory, 'interview-runner-sandbox'));
      await driver.create(valid, allowlist); expect(await readFile(outside, 'utf8')).toBe('untouched'); expect(git('rev-parse', 'HEAD')).toBe(head); await writeFile(join(workspace, '.git'), 'gitdir: /unrelated\n'); await driver.remove(valid.id); expect(await readFile(join(workspace, '.git'), 'utf8')).toBe('gitdir: /unrelated\n');
      await expect(driver.create(valid, allowlist)).rejects.toThrow('already contains Git metadata'); expect(await readFile(join(workspace, '.git'), 'utf8')).toBe('gitdir: /unrelated\n');
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); vi.unstubAllEnvs(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
  });

  it('dispatches capture and commits to Podman as the sandbox user without running learner Git config on the host', async () => {
    const { root, allowlist } = await fixture(); const state = await mkdtemp(join(tmpdir(), 'sandboxd-git-exec-')); const socket = join(state, 'podman.sock'); const workspace = join(root, valid.workspacePath); const directory = join(state, '.workspace-git/course-one/drill-one.git'); const sentinel = join(state, 'host-executed'); const hooks = join(state, 'hooks');
    vi.stubEnv('XDG_STATE_HOME', state); await mkdir(directory, { recursive: true }); await mkdir(hooks);
    const git = (...args: string[]) => execFileSync('git', ['--git-dir', directory, '--work-tree', workspace, ...args]);
    git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid'); await writeFile(join(workspace, '.gitattributes'), '* filter=x diff=x\n'); git('add', '-A'); git('commit', '-qm', 'initial');
    const command = `touch '${sentinel}'`; await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    for (const [key, value] of [['filter.x.clean', command], ['filter.x.smudge', command], ['diff.x.textconv', command], ['core.hooksPath', hooks], ['core.fsmonitor', command]]) git('config', key, value);
    let created: any; const executions: any[] = [];
    const server = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; const url = request.url ?? ''; response.setHeader('Content-Type', 'application/json');
      if (url.includes('/containers/create?')) { created = body; response.end(JSON.stringify({ Id: 'container' })); }
      else if (url.includes('/containers/json?')) response.end(JSON.stringify([{ Names: [`/ir-default-sbx-${valid.id}`], Id: 'container', State: 'running', Labels: created.Labels }]));
      else if (url.endsWith('/containers/container/exec')) { executions.push(body); response.end(JSON.stringify({ Id: 'exec-id' })); }
      else if (url.endsWith('/exec/exec-id/json')) response.end(JSON.stringify({ ExitCode: 0 }));
      else response.writeHead(204).end();
    }); server.listen(socket); await once(server, 'listening'); const driver = new PodmanDriver(socket, 'sandbox-image', state, state);
    try {
      await driver.create(valid, allowlist);
      expect(created.User).toBe('1000');
      await driver.exec(valid.id, { action: 'capture-run', runs: [['--mode', 'file']] });
      await driver.exec(valid.id, { action: 'capture-run', runs: [['--mode', 'file']] });
      await driver.exec(valid.id, { action: 'stage-commit', stage: 1 });
      await driver.exec(valid.id, { action: 'commit-files' });
      expect(executions).toHaveLength(4); expect(executions.every((item) => item.User === '1000')).toBe(true);
      expect(executions.map((item) => item.Cmd[3])).toEqual(['/opt/ir/tools/capture-run.mjs', '/opt/ir/tools/capture-run.mjs', '/opt/ir/tools/workspace-git.mjs', '/opt/ir/tools/workspace-git.mjs']);
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); vi.unstubAllEnvs(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
  });

  it('does not reattach settings watchers while sampling health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-health-')); const socket = join(root, 'podman.sock'); const watchSettings = vi.spyOn(SandboxSettingsSync.prototype, 'watch'); const watchUi = vi.spyOn(SandboxUiStateSync.prototype, 'watch');
    const server = createHttpServer((request, response) => { const url = request.url ?? ''; response.setHeader('Content-Type', 'application/json'); if (url.includes('/containers/json?')) response.end(JSON.stringify([{ Names: ['/ir-default-sbx-12345678'], Id: 'container', State: 'running', Labels: { [sandboxLabel]: '1', [instanceLabel]: 'default', 'io.interview-runner.drill': 'course-one/drill-one', 'io.interview-runner.workspace': '/workspace' } }])); else if (url.includes('/containers/container/exec')) response.end(JSON.stringify({ Id: 'exec-id' })); else if (url.includes('/exec/exec-id/start')) response.end('oom_kill 0\n100\n200\n300\n'); else if (url.includes('/exec/exec-id/json')) response.end(JSON.stringify({ ExitCode: 0 })); else response.writeHead(404).end(); }); server.listen(socket); await once(server, 'listening');
    try { const health = await new PodmanDriver(socket, 'sandbox-image', root, root).health('12345678'); expect(health).toMatchObject({ oomKills: 0, memoryCurrent: 100 }); expect(watchSettings).not.toHaveBeenCalled(); expect(watchUi).not.toHaveBeenCalled(); } finally { watchSettings.mockRestore(); watchUi.mockRestore(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); }
  });

  it.each([201, 409])('preserves an existing AI volume when container startup fails (volume create %s)', async (volumeStatus) => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-ai-')); const workspace = join(root, 'drills/course-one/drill-one/workspace'); await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'index.ts'), 'export {}'); const socket = join(root, 'podman.sock'); const calls: string[] = [];
    const server = createHttpServer((request, response) => { const url = request.url ?? ''; calls.push(`${request.method} ${url}`); response.setHeader('Content-Type', 'application/json'); if (url.endsWith('/volumes/create')) response.writeHead(volumeStatus).end('{}'); else if (url.includes('/volumes/')) response.end(JSON.stringify({ Labels: { [sandboxLabel]: '1', [instanceLabel]: 'default', 'io.interview-runner.drill': 'course-one/drill-one/1' } })); else if (url.includes('/containers/create?')) response.end(JSON.stringify({ Id: 'container' })); else if (url.endsWith('/containers/container/start')) response.writeHead(500).end('{}'); else if (url.endsWith('/containers/container/json')) response.end(JSON.stringify({ Config: { Labels: {} } })); else response.writeHead(204).end(); }); server.listen(socket); await once(server, 'listening');
    const driver = new PodmanDriver(socket, 'sandbox-image', root, root, 'sandbox'); const ai = { ...valid, kind: 'ai-coding' as const, workspacePath: 'drills/course-one/drill-one/workspace', sourcePath: 'drills/course-one/drill-one/workspace/index.ts', testPath: undefined, attemptNumber: 1 };
    try { await expect(driver.create(ai, { course: { hostRoot: root, containerRoot: root } })).rejects.toThrow('failed (500)'); expect(calls.some((call) => call.startsWith('DELETE ') && call.includes('/volumes/'))).toBe(false); } finally { server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); }
  });

  it('scopes list, remove and volume deletion to its own instance and ignores other instances and unlabelled legacy items', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-instance-')); const socket = join(root, 'podman.sock'); const calls: string[] = []; let filters: any;
    const drill = 'course-one/drill-one/1';
    const containers = [
      { Names: ['/ir-a-sbx-aaaaaaaa'], Id: 'own', State: 'running', Labels: { [sandboxLabel]: '1', [instanceLabel]: 'a', 'io.interview-runner.drill': drill, 'io.interview-runner.kind': 'ai-coding' } },
      { Names: ['/ir-b-sbx-bbbbbbbb'], Id: 'other', State: 'exited', Labels: { [sandboxLabel]: '1', [instanceLabel]: 'b', 'io.interview-runner.drill': drill, 'io.interview-runner.kind': 'ai-coding' } },
      { Names: ['/ir-sbx-cccccccc'], Id: 'legacy', State: 'exited', Labels: { [sandboxLabel]: '1', 'io.interview-runner.drill': drill, 'io.interview-runner.kind': 'ai-coding' } },
      { Names: ['/ir-b-sbx-dddddddd'], Id: 'spoof', State: 'exited', Labels: { [sandboxLabel]: '1', [instanceLabel]: 'a', 'io.interview-runner.drill': drill } },
    ];
    const volumes: Record<string, Record<string, string>> = { 'ir-a-ws-course-one--drill-one--1': { [sandboxLabel]: '1', [instanceLabel]: 'a', 'io.interview-runner.drill': drill }, 'ir-a-ws-course-one--drill-one--2': { [sandboxLabel]: '1', [instanceLabel]: 'b', 'io.interview-runner.drill': 'course-one/drill-one/2' }, 'ir-a-ws-course-one--drill-one--3': { [sandboxLabel]: '1', 'io.interview-runner.drill': 'course-one/drill-one/3' } };
    // The fake daemon deliberately ignores the label filter, so the driver's own ownership checks are what is under test.
    const server = createHttpServer((request, response) => { const url = request.url ?? ''; calls.push(`${request.method} ${url}`); response.setHeader('Content-Type', 'application/json'); if (url.includes('/containers/json?')) { filters = JSON.parse(new URL(url, 'http://podman').searchParams.get('filters') ?? '{}'); response.end(JSON.stringify(containers)); } else if (request.method === 'GET' && url.includes('/containers/')) response.end(JSON.stringify({ Config: { Labels: {} } })); else if (request.method === 'GET' && url.includes('/volumes/')) { const labels = volumes[decodeURIComponent(url.split('/volumes/')[1])]; if (labels) response.end(JSON.stringify({ Labels: labels })); else response.writeHead(404).end(); } else response.writeHead(204).end(); }); server.listen(socket); await once(server, 'listening');
    const driver = new PodmanDriver(socket, 'sandbox-image', root, root, 'sandbox', 'a'); const deleted = () => calls.filter((call) => call.startsWith('DELETE '));
    try {
      expect(filters).toBeUndefined(); const listed = await driver.list(false);
      expect(filters.label).toEqual([`${sandboxLabel}=1`, `${instanceLabel}=a`]);
      expect(listed.map((record) => record.id)).toEqual(['aaaaaaaa']); expect(listed[0]).toMatchObject({ target: 'http://ir-a-sbx-aaaaaaaa:8080', volume: 'ir-a-ws-course-one--drill-one--1' });
      for (const id of ['bbbbbbbb', 'cccccccc', 'dddddddd']) { await driver.remove(id, true); await expect(driver.exec(id, { action: 'health' })).rejects.toThrow('Unknown sandbox'); }
      expect(deleted()).toEqual([]);
      await expect(driver.removeWorkspace('course-one', 'drill-one', 2)).rejects.toThrow('not owned'); await expect(driver.removeWorkspace('course-one', 'drill-one', 3)).rejects.toThrow('not owned'); await driver.removeWorkspace('course-one', 'drill-one', 9); expect(deleted()).toEqual([]);
      await driver.remove('aaaaaaaa', true); expect(deleted()).toEqual(['DELETE /v1.41/containers/own?force=true', 'DELETE /v1.41/volumes/ir-a-ws-course-one--drill-one--1?force=true']);
      expect(sandboxNetworkName('a')).toBe('ir-a-sandbox'); expect(() => new PodmanDriver(socket, 'sandbox-image', root, root, 'sandbox', 'Bad_Name')).toThrow('RUNNER_INSTANCE');
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to reuse a same-named volume that lacks its instance label and joins its own network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-instance-volume-')); const workspace = join(root, 'drills/course-one/drill-one/workspace'); await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'index.ts'), 'export {}'); const socket = join(root, 'podman.sock'); const calls: string[] = []; let created: any; let volumeBody: any; let labels: Record<string, string> = { [sandboxLabel]: '1', 'io.interview-runner.drill': 'course-one/drill-one/1' }; let inspections = 0;
    // The volume appears between the first inspect (404) and the create (409), so only the second inspect shows whose it is.
    const server = createHttpServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const url = request.url ?? ''; calls.push(`${request.method} ${url}`); response.setHeader('Content-Type', 'application/json'); if (url.endsWith('/volumes/create')) { volumeBody = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(409).end('{}'); } else if (url.includes('/volumes/')) { if (inspections++ % 2 === 0) response.writeHead(404).end('{}'); else response.end(JSON.stringify({ Labels: labels })); } else if (url.includes('/containers/create?')) { created = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(201).end(JSON.stringify({ Id: 'container' })); } else response.writeHead(204).end(); }); server.listen(socket); await once(server, 'listening');
    const driver = new PodmanDriver(socket, 'sandbox-image', root, root, 'sandbox', 'a'); const ai = { ...valid, kind: 'ai-coding' as const, workspacePath: 'drills/course-one/drill-one/workspace', sourcePath: 'drills/course-one/drill-one/workspace/index.ts', testPath: undefined, attemptNumber: 1 }; const allowlist = { course: { hostRoot: root, containerRoot: root } };
    try {
      await expect(driver.create(ai, allowlist)).rejects.toThrow('not owned'); expect(calls.some((call) => call.includes('/containers/create?'))).toBe(false); expect(volumeBody).toMatchObject({ Name: 'ir-a-ws-course-one--drill-one--1', Labels: { [instanceLabel]: 'a' } });
      labels = { ...labels, [instanceLabel]: 'b' }; await expect(driver.create(ai, allowlist)).rejects.toThrow('not owned');
      labels = { ...labels, [instanceLabel]: 'a' }; const record = await driver.create(ai, allowlist); expect(record.target).toBe(`http://ir-a-sbx-${ai.id}:8080`); expect(created.HostConfig.NetworkMode).toBe('ir-a-sandbox'); expect(created.Labels).toMatchObject({ [sandboxLabel]: '1', [instanceLabel]: 'a' }); expect(calls.some((call) => call.includes(`/containers/create?name=ir-a-sbx-${ai.id}`))).toBe(true);
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); }
  });

  it('never mounts, fills or deletes a volume it cannot prove it created and owns when restoring stored AI work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-restore-owner-')); const workspace = join(root, 'drills/course-one/drill-one/workspace'); await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'index.ts'), 'export {}'); const socket = join(root, 'podman.sock');
    const db = await openUserDb(':memory:'); const entry = (path: string, content: string) => ({ path, type: 'file' as const, mode: 0o644, mtimeMs: 0, content: Buffer.from(content) }); saveTree(db, 'ai-workspace', 'course-one/drill-one/1', [entry('.ir-seeded', ''), entry('work.txt', 'saved')]);
    const ours = { [sandboxLabel]: '1', [instanceLabel]: 'a', 'io.interview-runner.drill': 'course-one/drill-one/1' };
    let calls: string[] = []; let volume: { Labels: Record<string, string> } | undefined; let createStatus = 409; let onCreate: (body: any) => void = () => {}; let putStatus = 200; let helperBinds: string[] | undefined;
    const server = createHttpServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const url = request.url ?? ''; calls.push(`${request.method} ${url.replace('/v1.41', '')}`); response.setHeader('Content-Type', 'application/json');
      if (url.endsWith('/volumes/create')) { onCreate(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(createStatus).end('{}'); }
      else if (request.method === 'GET' && url.includes('/volumes/')) { if (volume) response.end(JSON.stringify(volume)); else response.writeHead(404).end('{}'); }
      else if (request.method === 'DELETE' && url.includes('/volumes/')) { volume = undefined; response.writeHead(204).end(); }
      else if (url.includes('/containers/create?name=ir-a-restore-')) { helperBinds = JSON.parse(Buffer.concat(chunks).toString()).HostConfig.Binds; response.writeHead(201).end(JSON.stringify({ Id: 'helper' })); }
      else if (url.includes('/containers/create?')) response.writeHead(201).end(JSON.stringify({ Id: 'container' }));
      else if (request.method === 'GET' && url.includes('/containers/')) response.writeHead(404).end('{}');
      else if (request.method === 'PUT') response.writeHead(putStatus).end('{}');
      else response.writeHead(204).end(); }); server.listen(socket); await once(server, 'listening');
    const driver = new PodmanDriver(socket, 'sandbox-image', root, root, 'sandbox', 'a', db); const ai = { ...valid, kind: 'ai-coding' as const, workspacePath: 'drills/course-one/drill-one/workspace', sourcePath: 'drills/course-one/drill-one/workspace/index.ts', testPath: undefined, attemptNumber: 1 }; const allowlist = { course: { hostRoot: root, containerRoot: root } };
    const touched = () => calls.filter((call) => call.includes('/containers/create?') || call.startsWith('PUT ') || call.startsWith('DELETE /volumes/'));
    try {
      // 1. Missing at first, then someone else's unlabelled volume wins the name: a create conflict proves nothing.
      onCreate = () => { volume = { Labels: { other: 'owner' } }; }; await expect(driver.create(ai, allowlist)).rejects.toThrow('not owned'); expect(touched()).toEqual([]); expect(volume).toEqual({ Labels: { other: 'owner' } });
      // 2. The same race lost to another instance, and to a successful-looking create that returned a foreign volume.
      calls = []; volume = undefined; onCreate = () => { volume = { Labels: { ...ours, [instanceLabel]: 'b' } }; }; await expect(driver.create(ai, allowlist)).rejects.toThrow('not owned'); createStatus = 201; volume = undefined; await expect(driver.create(ai, allowlist)).rejects.toThrow('not owned'); expect(touched()).toEqual([]);
      // 3. This instance's own volume appeared meanwhile (no create token of this call): it is used as it is and never overwritten from the stored copy.
      calls = []; volume = undefined; createStatus = 409; onCreate = () => { volume = { Labels: ours }; }; await driver.create(ai, allowlist); expect(touched()).toEqual([`POST /containers/create?name=ir-a-sbx-${ai.id}`]); expect(helperBinds).toBeUndefined();
      // 4. A volume this call created is refilled; when that fails it is removed again, but only while it still carries this call's token.
      calls = []; volume = undefined; createStatus = 201; putStatus = 500; onCreate = (body) => { volume = { Labels: body.Labels }; }; await expect(driver.create({ ...ai, id: '22222222-abcd' }, allowlist)).rejects.toThrow('failed (500)');
      expect(helperBinds).toEqual(['ir-a-ws-course-one--drill-one--1:/restore:rw,U']); expect(touched()).toEqual(['POST /containers/create?name=ir-a-restore-course-one--drill-one--1', 'PUT /containers/helper/archive?path=%2Frestore', 'DELETE /volumes/ir-a-ws-course-one--drill-one--1?force=true']); expect(volume).toBeUndefined();
      calls = []; onCreate = (body) => { volume = { Labels: body.Labels }; setTimeout(() => { volume = { Labels: ours }; }, 0); }; const original = (driver as any).restoreAiVolume.bind(driver); (driver as any).restoreAiVolume = async (...args: unknown[]) => { await new Promise((resolve) => setTimeout(resolve, 20)); return original(...args); };
      await expect(driver.create({ ...ai, id: '33333333-abcd' }, allowlist)).rejects.toThrow('failed (500)'); expect(calls.filter((call) => call.startsWith('DELETE /volumes/'))).toEqual([]); expect(volume).toEqual({ Labels: ours }); (driver as any).restoreAiVolume = original;
      // 5. Concurrent creates for one volume are serialized: the stored copy is restored once, by the call that created the volume.
      calls = []; volume = undefined; putStatus = 200; onCreate = (body) => { volume = { Labels: body.Labels }; }; await Promise.all([driver.create({ ...ai, id: '44444444-abcd' }, allowlist), driver.create({ ...ai, id: '55555555-abcd' }, allowlist)]);
      expect(calls.filter((call) => call === 'POST /volumes/create')).toHaveLength(1); expect(calls.filter((call) => call.startsWith('PUT '))).toHaveLength(1);
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); db.close?.(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); }
  });

  it('drops an AI workspace archive that arrives after a newer save or after the workspace was deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-save-race-')); const db = await openUserDb(':memory:'); const driver = new PodmanDriver('/unused', 'sandbox-image', root, root, 'sandbox', 'a', db);
    const labels = { [sandboxLabel]: '1', [instanceLabel]: 'a', 'io.interview-runner.drill': 'course-one/drill-one/1', 'io.interview-runner.kind': 'ai-coding', 'io.interview-runner.persist': '1', 'io.interview-runner.workspace': '/workspace/drill-one-1' };
    const row = { Id: 'learner', Names: ['/ir-a-sbx-12345678'], State: 'running', Labels: labels }; const reply = (status: number, body: unknown = {}) => ({ status, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)) });
    const entry = (path: string, content: string) => ({ path, type: 'file' as const, mode: 0o644, mtimeMs: 0, content: Buffer.from(content) }); const archive = (content: string) => reply(200, buildTar([entry('drill-one-1/.ir-seeded', ''), entry('drill-one-1/work.txt', content)], { uid: 1000, gid: 1000 }));
    let archives: Array<(value: unknown) => void> = []; let volumeExists = true; const deleted: string[] = [];
    (driver as any).call = async (method: string, path: string) => { if (path.startsWith('/containers/json?')) return reply(200, [row]); if (method === 'GET' && path.includes('/archive?')) return new Promise((resolve) => { archives.push(resolve); }); if (method === 'GET' && path.startsWith('/volumes/')) return volumeExists ? reply(200, { Labels: labels }) : reply(404); if (method === 'DELETE' && path.startsWith('/volumes/')) { deleted.push(path); volumeExists = false; return reply(204); } if (path.endsWith('/json')) return reply(200, { Config: { Labels: labels } }); return reply(204); };
    const pending = async (count: number) => { while (archives.length < count) await new Promise((resolve) => setImmediate(resolve)); }; const stored = () => loadTree(db, 'ai-workspace', 'course-one/drill-one/1')?.find((item) => item.path === 'work.txt')?.content.toString();
    try {
      // A periodic autosave is reading its archive when the sandbox is removed; the removal's final archive is newer and lands first.
      const periodic = driver.persistAll(); await pending(1); const removal = driver.remove('12345678', false); await pending(2); archives[1]!(archive('newest final save')); await removal; expect(stored()).toBe('newest final save');
      archives[0]!(archive('older autosave')); await periodic; expect(stored()).toBe('newest final save');
      // The opposite order: the final archive starts first, an autosave starts after it and fails once the container is gone. The successful final save must stay.
      archives = []; const closing = driver.remove('12345678', false); await pending(1); const failing = driver.persistAll(); await pending(2); archives[0]!(archive('final before failed autosave')); await closing; expect(stored()).toBe('final before failed autosave');
      archives[1]!(reply(404)); await failing; expect(stored()).toBe('final before failed autosave');
      // Two overlapping saves that both succeed: the one that started later wins whichever order they finish in.
      archives = []; const early = driver.persistAll(); await pending(1); const later = driver.persistAll(); await pending(2); archives[1]!(archive('started later')); await later; archives[0]!(archive('started earlier')); await early; expect(stored()).toBe('started later');
      archives = []; const first = driver.persistAll(); await pending(1); const second = driver.persistAll(); await pending(2); archives[0]!(archive('earlier lands first')); await first; expect(stored()).toBe('earlier lands first'); archives[1]!(archive('later lands second')); await second; expect(stored()).toBe('later lands second');
      // Later saves still commit in order.
      archives = []; const next = driver.persistAll(); await pending(1); archives[0]!(archive('next save')); await next; expect(stored()).toBe('next save');
      // An autosave in flight when the attempt workspace is deleted must not bring its stored copy back.
      archives = []; const late = driver.persistAll(); await pending(1); await driver.removeWorkspace('course-one', 'drill-one', 1); expect(deleted).toHaveLength(1); expect(listTrees(db, 'ai-workspace')).toEqual([]);
      archives[0]!(archive('resurrected')); await late; expect(listTrees(db, 'ai-workspace')).toEqual([]);
      // The same holds when the sandbox is removed together with its volume.
      archives = []; volumeExists = true; const again = driver.persistAll(); await pending(1); await driver.remove('12345678', true); archives[0]!(archive('resurrected')); await again; expect(listTrees(db, 'ai-workspace')).toEqual([]); expect(deleted).toHaveLength(2);
    } finally { (driver as any).settings.close(); (driver as any).ui.close(); db.close?.(); await rm(root, { recursive: true, force: true }); }
  });

  it('aborts an oversized Podman response while streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandboxd-socket-')); const socket = join(root, 'podman.sock');
    const server = createHttpServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); const chunk = Buffer.alloc(1024 * 1024); for (let index = 0; index < 6; index++) response.write(chunk); response.end(); }); server.listen(socket); await once(server, 'listening');
    try { await expect(new PodmanDriver(socket, 'sandbox-image').list()).rejects.toThrow('byte limit'); } finally { server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); }
  });
});
