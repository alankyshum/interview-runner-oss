// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import connect from 'connect';
import { expect, it, vi } from 'vitest';

const manifest = { id: 'api-map', type: 'map-recall', title: 'API Map', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/api-map/map.md', instructions: 'Study.' }, { id: 'recall', title: 'Recall', contentType: 'recall', whiteboard: true, kind: 'scratch', estMinutes: 1, sourcePath: 'recall/api-map/recall.json', instructions: 'Study.' }] }, { id: 'chapter-two', title: 'More', drills: [{ id: 'map-two', title: 'Second map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/api-map/map-two.md', instructions: 'Study.' }] }] };

it('retries content database initialization after a failure without exposing the error', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'content-retry-')); const previous = process.env.XDG_STATE_HOME; const previousSource = process.env.INTERVIEW_RUNNER_CONTENT_SOURCE;
  await mkdir(join(temp, 'interview-runner')); await writeFile(join(temp, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
  process.env.XDG_STATE_HOME = temp; process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; vi.resetModules();
  const failure = new Error('private database details'); let opens = 0;
  vi.doMock('./contentDb', async (original) => {
    const actual = await original<typeof import('./contentDb')>();
    return { ...actual, openContentDb: () => { if (++opens === 1) return Promise.reject(failure); return actual.openContentDb(join(temp, 'content.db')); } };
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { stateDb } = await import('../db'); const { issueApiKey } = await import('./apiKeys'); const { contentDatabase } = await import('./reader');
  const key = issueApiKey(stateDb(), { name: 'retry', scopes: ['content:write'], namespaces: ['author'] });
  const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as never });
  const app = connect(); plugin.configureServer({ httpServer: null, middlewares: app } as never);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/content/me`;
    const request = () => fetch(url, { headers: { authorization: `Bearer ${key}` } });
    const first = await request(); expect(first.status).toBe(500); expect(await first.json()).toEqual({ error: 'Content API unavailable' });
    expect(log).toHaveBeenCalledWith('Content API initialization failed', failure);
    const second = await request(); expect(second.status).toBe(200); expect(await second.json()).toMatchObject({ name: 'retry' }); expect(opens).toBe(2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    (await contentDatabase()).close(); plugin.closeBundle?.(); log.mockRestore(); vi.doUnmock('./contentDb'); vi.resetModules();
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    if (previousSource === undefined) delete process.env.INTERVIEW_RUNNER_CONTENT_SOURCE; else process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = previousSource;
    await rm(temp, { recursive: true, force: true });
  }
});

it.each(['db', 'files'] as const)('mounts content publishing and respects %s catalog mode', async (source) => {
  const temp = await mkdtemp(join(tmpdir(), 'mounted-content-test-')); const state = join(temp, 'state'); const repo = join(temp, 'repo');
  const previousState = process.env.XDG_STATE_HOME; const previousSource = process.env.INTERVIEW_RUNNER_CONTENT_SOURCE;
  await mkdir(join(state, 'interview-runner'), { recursive: true }); await mkdir(join(repo, 'courses'), { recursive: true });
  await writeFile(join(repo, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 }));
  await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: { 'fixture/repo': { path: repo, runner: 'interview-runner/interview-runner', schema: 2 } } }));
  process.env.XDG_STATE_HOME = state; process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = source; vi.resetModules();
  vi.doMock('./contentDb', async (original) => {
    const actual = await original<typeof import('./contentDb')>();
    return { ...actual, openContentDb: (path?: string) => actual.openContentDb(path ?? join(temp, 'content.db')) };
  });
  const { stateDb } = await import('../db'); const { issueApiKey } = await import('./apiKeys'); const { contentDatabase } = await import('./reader');
  const key = issueApiKey(stateDb(), { name: 'integration', scopes: ['content:write'], namespaces: ['author'] });
  const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as never, enableDeterministicWatchers: false });
  const app = connect(); plugin.configureServer({ httpServer: null, middlewares: app } as never);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, method = 'GET', body?: BodyInit, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, ...extra }, ...(body === undefined ? {} : { body }) });
  const blobs = new Map<string, Buffer>();
  const file = (text: string) => { const bytes = Buffer.from(text); const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes); return { sha256, size: bytes.length }; };
  const recall = { courseId: 'api-map', drillId: 'recall', title: 'Recall', questions: [{ id: 'one', prompt: 'What?', answer: 'Secret answer.' }, { id: 'two', prompt: 'Why?', answer: 'Another answer.' }] };
  const bundle = { manifest, namespace: 'author', files: { 'courses/api-map.json': file(`${JSON.stringify(manifest)}\n`), 'mindmaps/api-map/map.md': file('# API Map\n'), 'mindmaps/api-map/map-two.md': file('# Second Map\n'), 'recall/api-map/recall.json': file(JSON.stringify(recall)) } };
  try {
    expect((await fetch(`${base}/api/content/courses`)).status).toBe(401);
    expect(await (await request('/api/content/me')).json()).toEqual({ id: key.split('_')[1], name: 'integration', scopes: ['content:write'], namespaces: ['author'] });
    const missing = await request('/api/content/blobs/missing', 'POST', JSON.stringify({ sha256: [...blobs.keys()] })); expect(await missing.json()).toEqual({ missing: [...blobs.keys()] });
    for (const [hash, bytes] of blobs) expect((await request('/api/content/blobs', 'POST', bytes, { 'content-type': 'application/octet-stream', 'x-blob-sha256': hash })).status).toBe(201);
    expect((await request('/api/content/courses/api-map/validate', 'POST', JSON.stringify(bundle))).status).toBe(200);
    const put = await request('/api/content/courses/api-map', 'PUT', JSON.stringify(bundle)); expect(await put.json()).toMatchObject({ id: 'api-map', revision: 1 });
    expect((await request('/api/content/courses')).status).toBe(200);
    if (source === 'db') {
      expect(await (await fetch(`${base}/api/courses`)).json()).toEqual([expect.objectContaining({ id: 'api-map' })]);
      expect((await (await fetch(`${base}/api/library`)).json()).items).toEqual([]);
      expect((await (await fetch(`${base}/api/library?workspace=author`)).json()).items).toEqual([expect.objectContaining({ id: 'api-map' })]);
      expect(await (await fetch(`${base}/api/courses/api-map`)).json()).toMatchObject(manifest);
      expect(await (await fetch(`${base}/api/map-recall/api-map/map`)).json()).toEqual({ source: '# API Map\n' });
      expect(await (await fetch(`${base}/api/map-recall/api-map/map-two`)).json()).toEqual({ source: '# Second Map\n' });
      expect((await (await fetch(`${base}/api/library?workspace=author`)).json()).items).toEqual([expect.objectContaining({ mapLessonCount: 2, totalDrills: 1 })]);
      const snapshot = { scene: { elements: [{ id: 'shape' }], appState: {}, files: {} }, svg: '<svg></svg>', updatedAt: Date.now() };
      expect((await fetch(`${base}/api/recall-whiteboards/api-map/recall`, { method: 'PUT', headers: { 'content-type': 'application/json', 'If-None-Match': '*' }, body: JSON.stringify(snapshot) })).status).toBe(200);
      const boards = await request('/api/content/courses/api-map/whiteboards/recall');
      expect(boards.status).toBe(200); const payload = await boards.json();
      expect(payload).toEqual({ questions: [{ id: 'one', prompt: 'What?' }, { id: 'two', prompt: 'Why?' }], snapshot });
      expect(JSON.stringify(payload)).not.toContain('Secret answer');
      expect((await fetch(`${base}/api/content/courses/api-map/whiteboards/recall`)).status).toBe(401);
      const proxyPlugin = (await import('../apiPlugin')).default({ remoteStateOrigin: 'https://state.example.test', sandboxManager: { all: () => [], close: () => {} } as never, enableDeterministicWatchers: false });
      const proxyApp = connect(); proxyPlugin.configureServer({ httpServer: null, middlewares: proxyApp } as never);
      const proxyServer = createServer(proxyApp); await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
      try {
        const proxyBase = `http://127.0.0.1:${(proxyServer.address() as { port: number }).port}`;
        const remote = await fetch(`${proxyBase}/api/content/courses/api-map/whiteboards/recall`, { headers: { authorization: `Bearer ${key}` } });
        expect(remote.status).toBe(503); expect(await remote.json()).toMatchObject({ error: expect.stringContaining('https://state.example.test') });
      } finally { await new Promise<void>((resolve, reject) => proxyServer.close((error) => error ? reject(error) : resolve())); proxyPlugin.closeBundle?.(); }
      expect((await request('/api/content/courses/api-map', 'PUT', JSON.stringify(bundle), { 'if-match': '2' })).status).toBe(412);
      expect((await request('/api/content/courses/api-map', 'DELETE')).status).toBe(204);
      expect((await (await fetch(`${base}/api/library`)).json()).items).toEqual([]);
      expect(await (await request('/api/content/courses/api-map/revisions/1/restore', 'POST')).json()).toMatchObject({ revision: 2 });
      expect((await (await fetch(`${base}/api/library?workspace=author`)).json()).items).toEqual([expect.objectContaining({ id: 'api-map' })]);
    } else expect(await (await fetch(`${base}/api/courses`)).json()).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    (await contentDatabase()).close(); vi.doUnmock('./contentDb'); vi.resetModules();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    if (previousSource === undefined) delete process.env.INTERVIEW_RUNNER_CONTENT_SOURCE; else process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = previousSource;
    await rm(temp, { recursive: true, force: true });
  }
});
