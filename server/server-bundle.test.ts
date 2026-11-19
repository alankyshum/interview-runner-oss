// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { ensureApiKeySchema, issueApiKey } from './content/apiKeys';

it('boots the separate plain-node server bundles without starting the other listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-bundle-')); const children: ChildProcess[] = [];
  try {
    await mkdir(join(root, 'interview-runner')); await writeFile(join(root, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
    const allowlist = join(root, 'allowlist.json'); await writeFile(allowlist, '{}');
    const preload = join(root, 'listen.mjs'); await writeFile(preload, `import http from 'node:http'; const listen=http.Server.prototype.listen; http.Server.prototype.listen=function(port,...args){ if(typeof port==='number'){const original=port;this.once('listening',()=>process.send({port:this.address().port,original}));return listen.call(this,0,'127.0.0.1')} return listen.call(this,port,...args)};`);
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_STATE_HOME: root, VITEST: '1', RUNNER_INSTANCE: 'bundle-test', INTERVIEW_RUNNER_CONTENT_SOURCE: 'db', RUNNER_ACCESS_MODE: 'tailnet', RUNNER_TAILNET_HOSTNAME: '127.0.0.1', RUNNER_TRUSTED_PROXY_IP: '127.0.0.1', RUNNER_SANDBOX_DRIVER: 'local', SANDBOX_UI_STATE_DIR: join(root, 'ui'), SANDBOXD_TOKEN: 'a'.repeat(64), SANDBOX_ALLOWLIST: allowlist, SANDBOX_IMAGE: 'test-image', PODMAN_SOCKET: join(root, 'missing.sock'), SANDBOX_SETTINGS_DIR: root, SANDBOX_SETTINGS_HOST_DIR: root };
    for (const [file, expectedPort] of [['start.mjs', 3000], ['sandboxd.mjs', 7070]] as const) {
      const source = await readFile(resolve('server-dist', file), 'utf8'); expect(source).not.toMatch(/(?:^|\n)import\s+(?:[^;\n]+from\s+)?["']@typescript\/typescript6["']/);
      const child = spawn(process.execPath, ['--import', preload, resolve('server-dist', file)], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
      let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
      const message = await Promise.race([once(child, 'message').then(([value]) => value as { port: number; original: number }), once(child, 'exit').then(([code]) => { throw new Error(`${file} exited ${code}: ${stderr}`); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`${file} did not listen: ${stderr}`)), 10_000); timer.unref(); })]);
      expect(message.original).toBe(expectedPort);
      const response = await fetch(`http://127.0.0.1:${message.port}${file === 'start.mjs' ? '/healthz' : '/sandboxes'}`);
      expect(response.status).toBe(file === 'start.mjs' ? 204 : 401);
      child.kill('SIGTERM'); await once(child, 'exit'); children.pop();
    }
  } finally { for (const child of children) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it('runs the bundled FTS compaction entry in read-only mode without changing the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-bundle-fts-'));
  try {
    const path = join(root, 'content.db'); const db = await (await import('./content/contentDb')).openContentDb(path); db.close();
    const before = createHash('sha256').update(await readFile(path)).digest('hex');
    const child = spawn(process.execPath, [resolve('server-dist/content-compact-fts.mjs'), '--db', path], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); }); child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ applied: false, removed: 0, retained: 0, integrity: 'ok' });
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps the bundled runner alive and recovers when sandboxd starts late', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-bundle-late-daemon-')); let child: ChildProcess | undefined; let daemon: Server | undefined;
  try {
    const project = join(root, 'runner'); const state = join(root, 'state'); await mkdir(join(project, 'server-dist'), { recursive: true }); await mkdir(join(state, 'interview-runner'), { recursive: true });
    await copyFile('server-dist/start.mjs', join(project, 'server-dist/start.mjs')); await copyFile('interview-runner.json', join(project, 'interview-runner.json'));
    for (const name of ['node_modules', 'sandbox', 'dist']) await symlink(resolve(name), join(project, name), 'dir');
    await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: project, supportedCourseSchema: 2 } }, courses: {} }));
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const address = probe.address(); if (!address || typeof address === 'string') throw new Error('test port unavailable'); const daemonPort = address.port; await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done()));
    const preload = join(root, 'listen.mjs'); await writeFile(preload, `import http from 'node:http'; const listen=http.Server.prototype.listen; http.Server.prototype.listen=function(port,...args){if(typeof port==='number'){this.once('listening',()=>process.send(this.address().port));return listen.call(this,0,'127.0.0.1')}return listen.call(this,port,...args)};`);
    child = spawn(process.execPath, ['--unhandled-rejections=strict', '--import', preload, join(project, 'server-dist/start.mjs')], { cwd: project, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_STATE_HOME: state, NODE_ENV: 'production', INTERVIEW_RUNNER_CONTENT_SOURCE: 'db', RUNNER_ACCESS_MODE: 'tailnet', RUNNER_TAILNET_HOSTNAME: '127.0.0.1', RUNNER_TRUSTED_PROXY_IP: '127.0.0.1', RUNNER_SANDBOX_DRIVER: 'podman', SANDBOXD_URL: `http://127.0.0.1:${daemonPort}`, SANDBOXD_TOKEN: 'a'.repeat(64), SANDBOX_UI_STATE_DIR: join(root, 'ui') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    const port = await Promise.race([once(child, 'message').then(([value]) => value as number), once(child, 'exit').then(([code]) => { throw new Error(`server exited ${code}: ${stderr}`); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`server did not listen: ${stderr}`)), 10_000); timer.unref(); })]);
    await vi.waitFor(() => expect(stderr).toContain('Sandbox initialization failed'));
    const origin = `http://127.0.0.1:${port}`; const headers = { 'x-forwarded-for': '100.64.0.1' };
    expect((await fetch(`${origin}/healthz`)).status).toBe(204);
    expect((await fetch(`${origin}/api/courses`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/sandboxes/missing-id`, { headers })).status).toBe(503);
    expect(child.exitCode).toBeNull();
    let listCalls = 0; let release!: () => void; const gate = new Promise<void>((done) => { release = done; });
    daemon = createServer((request, response) => { if (request.url !== '/sandboxes' || request.headers.authorization !== `Bearer ${'a'.repeat(64)}`) { response.writeHead(401).end(); return; } listCalls++; void gate.then(() => response.writeHead(200, { 'content-type': 'application/json' }).end('{"sandboxes":[]}')); });
    daemon.listen(daemonPort, '127.0.0.1'); await once(daemon, 'listening');
    const calls = Array.from({ length: 4 }, () => fetch(`${origin}/api/sandboxes/missing-id`, { headers }));
    try { await vi.waitFor(() => expect(listCalls).toBe(1)); } finally { release(); }
    expect((await Promise.all(calls)).map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(listCalls).toBe(1); expect(child.exitCode).toBeNull();
  } finally { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } if (daemon) { daemon.closeAllConnections(); await new Promise<void>((done) => daemon!.close(() => done())); } await rm(root, { recursive: true, force: true }); }
}, 30_000);

it('validates a bundle through the plain-node server with isolated databases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-bundle-api-')); let child: ChildProcess | undefined;
  try {
    const project = join(root, 'runner'); const state = join(root, 'state'); await mkdir(join(project, 'server-dist'), { recursive: true }); await mkdir(join(state, 'interview-runner'), { recursive: true });
    await copyFile('server-dist/start.mjs', join(project, 'server-dist/start.mjs')); await copyFile('interview-runner.json', join(project, 'interview-runner.json'));
    for (const name of ['node_modules', 'sandbox', 'dist']) await symlink(resolve(name), join(project, name), 'dir');
    await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: project, supportedCourseSchema: 2 } }, courses: {} }));
    const database = new DatabaseSync(join(project, 'progress.db')); ensureApiKeySchema(database); const key = issueApiKey(database, { name: 'fixture', scopes: ['content:write'], namespaces: ['fixture'] }); database.close();
    const preload = join(root, 'listen.mjs'); await writeFile(preload, `import http from 'node:http'; const listen=http.Server.prototype.listen; http.Server.prototype.listen=function(port,...args){if(typeof port==='number'){this.once('listening',()=>process.send(this.address().port));return listen.call(this,0,'127.0.0.1')}return listen.call(this,port,...args)};`);
    child = spawn(process.execPath, ['--import', preload, join(project, 'server-dist/start.mjs')], { cwd: project, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_STATE_HOME: state, NODE_ENV: 'production', INTERVIEW_RUNNER_CONTENT_SOURCE: 'db', RUNNER_ACCESS_MODE: 'tailnet', RUNNER_TAILNET_HOSTNAME: '127.0.0.1', RUNNER_TRUSTED_PROXY_IP: '127.0.0.1', RUNNER_SANDBOX_DRIVER: 'local', SANDBOX_UI_STATE_DIR: join(root, 'ui') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    const port = await Promise.race([once(child, 'message').then(([value]) => value as number), once(child, 'exit').then(([code]) => { throw new Error(`server exited ${code}: ${stderr}`); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`server did not listen: ${stderr}`)), 10_000); timer.unref(); })]);
    const origin = `http://127.0.0.1:${port}`; const auth = { authorization: `Bearer ${key}`, 'x-forwarded-for': '100.64.0.1' };
    const manifest = { id: 'bad', title: 'Bad', chapters: [{ id: 'one', title: 'One', drills: [{ id: 'solve', title: 'Solve', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/bad/solve/solve.ts', testPath: 'drills/bad/solve/solve.test.ts', instructions: 'Implement.' }] }] };
    const contents = { 'courses/bad.json': JSON.stringify(manifest), 'drills/bad/solve/solve.ts': 'export const solve = () => 1;', 'drills/bad/solve/solve.test.ts': "import {it,expect} from 'vitest'; it('bad',()=>expect(1).toBe(1));" };
    const files: Record<string, { sha256: string; size: number; mode: number }> = {};
    for (const [path, content] of Object.entries(contents)) { const bytes = Buffer.from(content); const sha256 = createHash('sha256').update(bytes).digest('hex'); files[path] = { sha256, size: bytes.length, mode: 0o644 }; const upload = await fetch(`${origin}/api/content/blobs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-blob-sha256': sha256 }, body: bytes }); expect(upload.status).toBe(201); }
    const result = await fetch(`${origin}/api/content/courses/bad/validate`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'fixture', manifest, files }) });
    expect(result.status).toBe(422); expect((await result.json()).errors.map((issue: { message: string }) => issue.message)).toEqual(['does not import the learner source module', 'test "bad" contains a literal-only assertion', 'test "bad" never exercises an export from the learner source module']);
  } finally { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(root, { recursive: true, force: true }); }
}, 30_000);
