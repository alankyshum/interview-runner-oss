// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { instanceLabel, PodmanDriver, sandboxLabel, validateSandboxSpec } from './sandboxd';
import { listTrees, loadTree, openUserDb } from './userData';

it('authorizes only computed managed roots and rejects traversal, missing revisions and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-sandbox-'));
  try {
    const drill = 'drills/course/drill'; const material = join(root, 'materialized/course/1', drill); const workspace = join(root, 'workspaces/course/drill');
    await mkdir(material, { recursive: true }); await mkdir(workspace, { recursive: true });
    await writeFile(join(material, 'source.test.ts'), 'test'); await writeFile(join(workspace, 'source.ts'), 'source');
    const allowlist = { managed: { hostRoot: root, containerRoot: '/app/state/interview-runner/managed' } };
    const spec = { id: '12345678', repoId: 'managed', courseId: 'course', drillId: 'drill', kind: 'coding' as const, workspacePath: drill, sourcePath: `${drill}/source.ts`, testPath: `${drill}/source.test.ts`, contentRevision: 1 };
    await expect(validateSandboxSpec(spec, allowlist)).resolves.toEqual(spec);
    await expect(validateSandboxSpec({ ...spec, contentRevision: 2 }, allowlist)).rejects.toThrow('Unknown content revision');
    await expect(validateSandboxSpec({ ...spec, contentRevision: -1 }, allowlist)).rejects.toThrow('Invalid content revision');
    await expect(validateSandboxSpec({ ...spec, sourcePath: `${drill}/../outside` }, allowlist)).rejects.toThrow('Invalid sandbox path');
    await expect(validateSandboxSpec({ ...spec, testPath: 'drills/course/another/test.ts' }, allowlist)).rejects.toThrow('escapes the drill');
    await rm(join(workspace, 'source.ts')); await symlink(join(material, 'source.test.ts'), join(workspace, 'source.ts'));
    await expect(validateSandboxSpec(spec, allowlist)).rejects.toThrow('symbolic link');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('binds managed workspace read-write and protected files from the computed revision read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-binds-')); const settings = await mkdtemp(join(tmpdir(), 'managed-settings-')); const socket = join(settings, 'podman.sock');
  let created: any; const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (request.url?.includes('/containers/create?')) { created = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(201, { 'Content-Type': 'application/json' }); response.end('{"Id":"container"}'); } else { response.writeHead(204); response.end(); } });
  server.listen(socket); await once(server, 'listening'); const driver = new PodmanDriver(socket, 'test-image', settings, settings);
  try {
    const drill = 'drills/course/drill'; const material = join(root, 'materialized/course/1', drill); const workspace = join(root, 'workspaces/course/drill'); await mkdir(material, { recursive: true }); await mkdir(workspace, { recursive: true });
    for (const [file, value] of [['source.test.ts', 'test'], ['source.seed.ts', 'seed']] as const) await writeFile(join(material, file), value);
    await writeFile(join(workspace, 'source.ts'), 'learner'); await writeFile(join(workspace, 'source.seed.ts'), 'seed');
    const allowlist = { managed: { hostRoot: root, containerRoot: '/app/state/interview-runner/managed' } }; const spec = { id: '12345678', repoId: 'managed', courseId: 'course', drillId: 'drill', kind: 'coding' as const, workspacePath: drill, sourcePath: `${drill}/source.ts`, testPath: `${drill}/source.test.ts`, contentRevision: 1 };
    await validateSandboxSpec(spec, allowlist); await driver.create(spec, allowlist);
    expect(created.HostConfig.Binds).toContain(`${await realpath(workspace)}:/workspace/${drill}:rw`);
    expect(created.HostConfig.Binds).toContain(`${await realpath(join(material, 'source.test.ts'))}:/workspace/${drill}/source.test.ts:ro`);
    expect(created.HostConfig.Binds).toContain(`${await realpath(join(material, 'source.seed.ts'))}:/workspace/${drill}/source.seed.ts:ro`);
    expect(created.Labels['io.interview-runner.content-revision']).toBe('1');
  } finally { (driver as any).settings.close(); (driver as any).ui.close(); server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); await rm(settings, { recursive: true, force: true }); }
});

it('saves a managed coding workspace, its Git history and the UI state into the user database and restores them into empty scratch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-persist-')); const settings = await mkdtemp(join(tmpdir(), 'managed-persist-settings-')); const uiState = join(settings, 'ui-state'); const socket = join(settings, 'podman.sock'); const previous = process.env.SANDBOX_UI_STATE_DIR; process.env.SANDBOX_UI_STATE_DIR = uiState;
  let created: any; let containers: any[] = []; const deleted: string[] = [];
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const url = request.url ?? ''; response.setHeader('Content-Type', 'application/json');
    if (url.includes('/containers/create?')) { created = JSON.parse(Buffer.concat(chunks).toString()); const name = new URL(url, 'http://podman').searchParams.get('name'); containers.push({ Names: [`/${name}`], Id: `c-${name}`, State: 'running', Labels: created.Labels }); response.writeHead(201).end(JSON.stringify({ Id: `c-${name}` })); }
    else if (url.includes('/containers/json?')) response.end(JSON.stringify(containers));
    else if (request.method === 'GET' && url.includes('/containers/')) { const row = containers.find((item) => url.includes(`/containers/${item.Id}/json`)); if (row) response.end(JSON.stringify({ Config: { Labels: row.Labels } })); else response.writeHead(404).end(); }
    else if (request.method === 'DELETE' && url.includes('/containers/')) { const id = url.split('/containers/')[1]!.split('?')[0]!; deleted.push(id); containers = containers.filter((item) => item.Id !== id); response.writeHead(204).end(); }
    else response.writeHead(204).end(); });
  server.listen(socket); await once(server, 'listening'); const db = await openUserDb(':memory:'); const drivers: PodmanDriver[] = [];
  const driver = (instance = 'a') => { const value = new PodmanDriver(socket, 'test-image', settings, settings, undefined, instance, db); drivers.push(value); return value; };
  try {
    const drill = 'drills/course/drill'; const material = join(root, 'materialized/course/1', drill); const workspace = join(root, 'workspaces/course/drill'); await mkdir(material, { recursive: true }); await mkdir(join(workspace, 'notes'), { recursive: true });
    await writeFile(join(material, 'source.test.ts'), 'test'); await writeFile(join(workspace, 'source.ts'), 'learner v1'); await writeFile(join(workspace, 'source.test.ts'), 'test');
    const allowlist = { managed: { hostRoot: root, containerRoot: '/app/state/interview-runner/managed' } }; const spec = { id: '12345678', repoId: 'managed', courseId: 'course', drillId: 'drill', kind: 'coding' as const, workspacePath: drill, sourcePath: `${drill}/source.ts`, testPath: `${drill}/source.test.ts`, contentRevision: 1 };
    const first = driver(); await first.create(spec, allowlist); expect(created.Labels).toMatchObject({ 'io.interview-runner.persist': '1', [instanceLabel]: 'a' });
    // The learner works: files change, Git history accumulates in the separate directory, code-server writes UI state.
    const gitDirectory = join(settings, '.workspace-git/course/drill.git'); await mkdir(join(gitDirectory, 'objects'), { recursive: true }); await writeFile(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n'); await writeFile(join(workspace, 'source.ts'), 'learner v2'); await mkdir(join(uiState, 'drills/course'), { recursive: true }); await writeFile(join(uiState, 'layout.json'), '{"panelVisible":true}');
    // Another instance and an unlabelled legacy sandbox point at host directories this instance must never save.
    const foreign = join(root, 'workspaces/course/foreign'); await mkdir(foreign, { recursive: true }); await writeFile(join(foreign, 'secret.ts'), 'other'); const foreignLabels = { ...created.Labels, 'io.interview-runner.drill': 'course/foreign', 'io.interview-runner.host-workspace': foreign };
    containers.push({ Names: ['/ir-b-sbx-bbbbbbbb'], Id: 'other', State: 'running', Labels: { ...foreignLabels, [instanceLabel]: 'b' } }, { Names: ['/ir-sbx-cccccccc'], Id: 'legacy', State: 'running', Labels: { ...foreignLabels, [instanceLabel]: undefined, [sandboxLabel]: '1' } });
    await first.persistAll();
    expect(listTrees(db).map((tree) => `${tree.kind}:${tree.key}`)).toEqual(['ui-state:', 'workspace:course/drill', 'workspace-git:course/drill']);
    expect(loadTree(db, 'workspace', 'course/drill')!.map((entry) => entry.path)).toEqual(['notes', 'source.test.ts', 'source.ts']); expect(loadTree(db, 'workspace', 'course/drill')!.find((entry) => entry.path === 'source.ts')!.content.toString()).toBe('learner v2');
    await writeFile(join(workspace, 'source.ts'), 'learner v3'); await first.remove(spec.id); expect(deleted).toEqual(['c-ir-a-sbx-12345678']);
    expect(loadTree(db, 'workspace', 'course/drill')!.find((entry) => entry.path === 'source.ts')!.content.toString()).toBe('learner v3'); expect(existsSync(join(workspace, '.git'))).toBe(false);
    // A sandbox created without a database is not marked, and a database-less driver saves nothing.
    const plain = new PodmanDriver(socket, 'test-image', settings, settings, undefined, 'a'); drivers.push(plain); await plain.create({ ...spec, id: '22222222' }, allowlist); expect(created.Labels['io.interview-runner.persist']).toBeUndefined(); await plain.persistAll(); await plain.remove('22222222');
    // Scratch is lost: the UI state returns when sandboxd starts, the Git history when the drill is opened again.
    await rm(uiState, { recursive: true, force: true }); await rm(join(settings, '.workspace-git'), { recursive: true, force: true });
    const second = driver(); expect(await readFile(join(uiState, 'layout.json'), 'utf8')).toBe('{"panelVisible":true}');
    await second.create({ ...spec, id: '87654321' }, allowlist); expect(await readFile(join(gitDirectory, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n'); expect(existsSync(join(gitDirectory, 'objects'))).toBe(true); expect(await readFile(join(workspace, '.git'), 'utf8')).toBe('gitdir: /opt/ir/workspace-git\n');
  } finally { for (const value of drivers) { (value as any).settings.close(); (value as any).ui.close(); } db.close?.(); if (previous === undefined) delete process.env.SANDBOX_UI_STATE_DIR; else process.env.SANDBOX_UI_STATE_DIR = previous; server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }); await rm(settings, { recursive: true, force: true }); }
});
