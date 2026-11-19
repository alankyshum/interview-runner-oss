// @vitest-environment node
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import connect from 'connect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundleFromDirectory, imageReferences, writeBundleToDirectory } from './bundle';
import { openContentDb } from './contentDb';

// The storage tests use a synthetic outline-backed fixture, not the policy path.
vi.mock('../../shared/legacyReading', async (original) => {
  const actual = await original<typeof import('../../shared/legacyReading')>();
  return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'coding' && drill === 'read' };
});

const exec = promisify(execFile); const runner = process.cwd(); let temp: string; let repo: string; let oldState: string | undefined; let oldSource: string | undefined;
const course = { id: 'coding', title: 'Coding', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'sum', title: 'Sum', contentType: 'coding', kind: 'logic', estMinutes: 5, sourcePath: 'drills/coding/sum/sum.ts', testPath: 'drills/coding/sum/sum.test.ts', instructions: 'Compute quokka values.\n## Milestone 1' }, { id: 'read', title: 'Read', contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: 'reading/coding/read.md', outlinePath: 'outlines/coding/read.json', instructions: 'Read.' }] }] };
const map = { id: 'map', type: 'map-recall', title: 'Map', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/map/map.md', instructions: 'Study.' }] }] };
const sheet = { id: 'sheet', type: 'cheatsheet', title: 'Sheet', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/sheet/sections/one.html' }] }] };
const hints = { courseId: 'coding', drills: { sum: [{ title: 'Milestone 1', approach: 'Use addition', solution: 'Add' }] } };
async function file(path: string, text: string): Promise<void> { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), text); }
async function usePortableCourse(): Promise<void> {
  const portable = structuredClone(course);
  portable.chapters[0]!.drills[1] = { id: 'read', title: 'Read', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/coding/read.md', instructions: 'Read.' } as typeof portable.chapters[0]['drills'][number];
  await file('courses/coding.json', JSON.stringify(portable)); await file('mindmaps/coding/read.md', '# Read');
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'content-test-')); repo = join(temp, 'repo');
  await file('interview-courses.json', JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 }));
  for (const [id, manifest] of [['coding', course], ['map', map], ['sheet', sheet]] as const) await file(`courses/${id}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  await file('courses/coding.hints.json', `${JSON.stringify(hints, null, 2)}\n`);
  await file('drills/coding/sum/sum.ts', 'export const sum = (a: number, b: number) => a + b;\n');
  await file('drills/coding/sum/sum.test.ts', "import { it, expect } from 'vitest'; import { sum } from './sum'; it('adds', () => expect(sum(1, 2)).toBe(3));\n");
  await file('reading/coding/read.md', 'Read ![image](/images/example.png)\n');
  await file('outlines/coding/read.json', JSON.stringify({ courseId: 'coding', drillId: 'read', title: 'Read', nodes: [{ id: 'one', type: 'claim', text: 'A claim' }] }));
  await file('images/example.png', 'image bytes'); await file('mindmaps/map/map.md', '# Map\n'); await file('cheatsheets/sheet/sections/one.html', '<h2>One</h2>');
  await mkdir(join(temp, 'state/interview-runner'), { recursive: true });
  await writeFile(join(temp, 'state/interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: runner, supportedCourseSchema: 2 } }, courses: { 'owner/repo': { path: repo, runner: 'interview-runner/interview-runner', schema: 2 } } }));
  oldState = process.env.XDG_STATE_HOME; oldSource = process.env.INTERVIEW_RUNNER_CONTENT_SOURCE; process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'files'; process.env.XDG_STATE_HOME = join(temp, 'state'); vi.resetModules();
});
afterEach(async () => { if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState; if (oldSource === undefined) delete process.env.INTERVIEW_RUNNER_CONTENT_SOURCE; else process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = oldSource; await rm(temp, { recursive: true, force: true }); });

it.each(['files', 'db'] as const)('serves outline-backed reading and rejects the legacy Markdown route in %s mode', async (source) => {
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = source; vi.resetModules();
  let db: Awaited<ReturnType<typeof openContentDb>> | undefined;
  if (source === 'db') {
    db = await (await import('./reader')).contentDatabase();
    const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
    await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'namespace' });
  }
  const app = connect(); const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false });
  plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(`${origin}/api/reading/coding/read`);
    expect(response.status).toBe(404);
    const outline = await fetch(`${origin}/api/outlines/coding/read`);
    expect(outline.status).toBe(200); expect((await outline.json()).nodes[0].text).toBe('A claim');
    expect((await fetch(`${origin}/api/reading/coding/sum`)).status).toBe(404);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); db?.close(); }
});

it('publishes and serves a first-class whiteboard in database mode and rejects invalid milestones', async () => {
  const manifest = { id: 'board', title: 'Board', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'design', title: 'Design', contentType: 'whiteboard', kind: 'scratch', estMinutes: 40, sourcePath: 'recall/board/design.json', instructions: 'Practice.' }] }] };
  const lesson = { courseId: 'board', drillId: 'design', title: 'Design', milestones: [{ id: 'one', prompt: 'Prompt', expectation: 'Done', hint: 'Hint', answer: 'Answer' }] };
  await file('courses/board.json', JSON.stringify(manifest)); await file('recall/board/design.json', JSON.stringify(lesson));
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; vi.resetModules();
  const db = await (await import('./reader')).contentDatabase(); const { putCourseBundle } = await import('./writer');
  const original = await bundleFromDirectory(repo, 'board'); await putCourseBundle(db, original.bundle, original.blobs, { namespace: 'namespace' });
  const app = connect(); const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false }); plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await fetch(`${origin}/api/map-recall/board/design`); expect(result.status).toBe(200); expect((await result.json()).questions[0]).toMatchObject({ prompt: 'Prompt', expectation: 'Done', hint: 'Hint', answer: 'Answer' });
    expect((await fetch(`${origin}/api/recall-whiteboards/board/design`)).status).toBe(200);
    await file('recall/board/design.json', JSON.stringify({ ...lesson, milestones: [] }));
    const invalid = await bundleFromDirectory(repo, 'board'); await expect(putCourseBundle(db, invalid.bundle, invalid.blobs, { namespace: 'namespace', expectedRevision: 1 })).rejects.toThrow();
    expect((await fetch(`${origin}/api/map-recall/board/design`)).status).toBe(200);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); db.close(); }
});

it.each(['files', 'db'] as const)('lists only explicitly marked books in %s mode', async (source) => {
  for (const id of ['marked-book', 'standard-map']) {
    const manifest = { id, title: id, ...(id === 'marked-book' ? { book: true } : {}), chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'chapter-map', title: 'Chapter', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: `mindmaps/${id}/chapter-map.md`, instructions: 'Study.' }] }] };
    await file(`courses/${id}.json`, JSON.stringify(manifest)); await file(`mindmaps/${id}/chapter-map.md`, '# Chapter');
  }
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = source; vi.resetModules();
  let db: Awaited<ReturnType<typeof openContentDb>> | undefined;
  if (source === 'db') {
    db = await (await import('./reader')).contentDatabase();
    for (const id of ['coding', 'map', 'marked-book', 'standard-map']) {
      const { bundle, blobs } = await bundleFromDirectory(repo, id);
      await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'namespace' });
    }
  }
  const app = connect(); const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false });
  plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const books = await fetch(`${origin}/api/books`); expect(books.status).toBe(200);
    expect((await books.json() as Array<{ id: string }>).map(({ id }) => id).sort()).toEqual(['marked-book']);
    const book = await fetch(`${origin}/api/courses/marked-book`); expect((await book.json()).book).toBe(true);
    const chapter = await fetch(`${origin}/api/map-recall/marked-book/chapter-map`); expect(chapter.status).toBe(200); expect(JSON.stringify(await chapter.json())).toContain('# Chapter');
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); db?.close(); }
});

it('migrates linked edits and history without replacing an existing workspace', async () => {
  await usePortableCourse();
  const dbPath = join(temp, 'content.db'); const db = await openContentDb(dbPath);
  const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
  await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'namespace' }); db.close();
  await file('drills/coding/sum/sum.ts', 'learner work');
  await file('drills/coding/sum/sum.test.ts', 'obsolete test');
  const state = join(temp, 'migration-state'); const stateRoot = join(state, 'managed'); const history = join(state, 'workspace-git/coding/sum.git'); const gitRoot = join(temp, 'git');
  await mkdir(join(history, 'objects'), { recursive: true }); await writeFile(join(history, 'HEAD'), 'ref: refs/heads/main\n');
  const args = ['scripts/content-migrate-workspaces.ts', '--db', dbPath, '--state-dir', state, '--git-dir', gitRoot];
  const env = { ...process.env, XDG_STATE_HOME: join(temp, 'state'), INTERVIEW_RUNNER_CONTENT_SOURCE: 'db' };
  const dry = await exec(resolve('node_modules/.bin/tsx'), [...args, '--dry-run'], { env });
  expect(dry.stdout).toContain('seeded=1 skipped-existing=0 skipped-raced=0 no-source=0');
  await expect(lstat(join(stateRoot, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  const first = await Promise.all([exec(resolve('node_modules/.bin/tsx'), args, { env }), exec(resolve('node_modules/.bin/tsx'), args, { env })]);
  expect(first.filter((result) => result.stdout.includes('seeded=1'))).toHaveLength(1);
  expect(first.filter((result) => /skipped-(?:existing|raced)=1/.test(result.stdout))).toHaveLength(1);
  const workspace = join(stateRoot, 'workspaces/coding/sum');
  expect(await readFile(join(workspace, 'sum.ts'), 'utf8')).toBe('learner work');
  expect(await readFile(join(workspace, 'sum.test.ts'), 'utf8')).toContain("import { it, expect }");
  expect(await readFile(join(gitRoot, 'coding/sum.git/HEAD'), 'utf8')).toContain('refs/heads/main');
  await writeFile(join(workspace, 'sum.ts'), 'new managed work'); await writeFile(join(gitRoot, 'coding/sum.git/HEAD'), 'existing history');
  const again = await exec(resolve('node_modules/.bin/tsx'), args, { env }); expect(again.stdout).toContain('skipped-existing=1');
  expect(await readFile(join(workspace, 'sum.ts'), 'utf8')).toBe('new managed work');
  expect(await readFile(join(gitRoot, 'coding/sum.git/HEAD'), 'utf8')).toBe('existing history');
  await rm(join(repo, 'drills/coding/sum'), { recursive: true });
  const missing = await exec(resolve('node_modules/.bin/tsx'), [...args, '--dry-run'], { env }); expect(missing.stdout).toContain('no-source=1');
});

it('serves imported content and creates a LocalDriver sandbox with no linked repositories', async () => {
  const saved = { CODE_SERVER_BIN: process.env.CODE_SERVER_BIN, SANDBOX_UI_STATE_DIR: process.env.SANDBOX_UI_STATE_DIR, RUNNER_SANDBOX_DRIVER: process.env.RUNNER_SANDBOX_DRIVER };
  const fake = join(temp, 'code-server'); await writeFile(fake, `#!${process.execPath}\nconst net = require('node:net'); const port = Number(process.argv[process.argv.indexOf('--bind-addr') + 1].split(':').pop()); net.createServer(s => s.end()).listen(port, '127.0.0.1');\n`); await chmod(fake, 0o755);
  process.env.CODE_SERVER_BIN = fake; process.env.SANDBOX_UI_STATE_DIR = join(temp, 'ui'); process.env.RUNNER_SANDBOX_DRIVER = 'local'; process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db';
  await writeFile(join(temp, 'state/interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: runner, supportedCourseSchema: 2 } }, courses: {} })); vi.resetModules();
  const { contentDatabase } = await import('./reader'); const db = await contentDatabase(); const { putCourseBundle } = await import('./writer');
  for (const id of ['coding', 'sheet']) { const { bundle, blobs } = await bundleFromDirectory(repo, id); await putCourseBundle(db, bundle, blobs, { namespace: 'namespace' }); }
  const { SandboxManager } = await import('../sandboxClient'); const manager = SandboxManager.fromEnvironment(); await manager.start();
  const app = connect(); const plugin = (await import('../apiPlugin')).default({ sandboxManager: manager, allowCodingRequest: () => true, enableDeterministicWatchers: false }); plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const path of ['/api/library', '/api/courses/coding', '/api/outlines/coding/read', '/api/cheatsheets', '/api/cheatsheets/sheet/content', '/images/example.png']) expect((await fetch(origin + path)).status, path).toBe(200);
    const response = await fetch(`${origin}/api/sandboxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ courseId: 'coding', drillId: 'sum' }) });
    expect(response.status, await response.clone().text()).toBe(201);
    const record = await response.json() as { id: string }; await manager.remove(record.id);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); manager.close(); db.close();
    for (const key of Object.keys(saved) as Array<keyof typeof saved>) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

it.each(['files', 'db'] as const)('rejects raw image URL fragments and symlink escapes in %s mode', async (source) => {
  await file('secret.png', 'private image bytes');
  await symlink('../secret.png', join(repo, 'images/escape.png'));
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = source; vi.resetModules();
  let db: Awaited<ReturnType<typeof openContentDb>> | undefined;
  if (source === 'db') {
    db = await (await import('./reader')).contentDatabase();
    const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
    await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'namespace' });
  }
  const app = connect(); const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false });
  plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const rawRequest = (path: string) => new Promise<string>((done, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' }); const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('Raw HTTP request timed out')));
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk)); socket.on('error', reject);
    socket.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
  try {
    for (const path of ['/images/escape.png#/../example.png', '/images/example.png?query=#fragment']) {
      const response = await rawRequest(path);
      expect(response).toMatch(/^HTTP\/1\.1 400\b/); expect(response).not.toContain('private image bytes'); expect(response).not.toContain('image bytes');
    }
    const escaped = await rawRequest('/images/escape.png');
    expect(escaped).toMatch(/^HTTP\/1\.1 404\b/); expect(escaped).not.toContain('private image bytes');
    const valid = await rawRequest('/images/example.png?query=%23');
    expect(valid).toMatch(/^HTTP\/1\.1 200\b/); expect(valid).toContain('image bytes');
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); db?.close(); }
});

it('serves image directory indexes over HTTP with and without a trailing slash', async () => {
  await file('images/folder/index.html', '<p>Image index</p>');
  const apiPlugin = (await import('../apiPlugin')).default; const app = connect();
  const plugin = apiPlugin({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false });
  plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    for (const path of ['/images/folder/', '/images/folder']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(200); expect(await response.text()).toBe('<p>Image index</p>');
    }
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); }
});

it('lists executable file modes in both backends', async () => {
  await file('drills/coding/sum/tool.sh', '#!/bin/sh\nexit 0\n');
  await chmod(join(repo, 'drills/coding/sum/tool.sh'), 0o755);
  const { createContentReader } = await import('./reader'); const db = await openContentDb(':memory:');
  try {
    const writer = await import('./writer'); const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
    await writer.putCourseBundle(db, bundle, blobs, { namespace: 'namespace' });
    for (const reader of [createContentReader('files'), createContentReader('db', async () => db)]) {
      expect(await reader.listCourseFileEntries('coding', 'drills/coding/sum/tool')).toEqual([{ path: 'drills/coding/sum/tool.sh', mode: 0o755 }]);
      expect(await reader.listCourseFiles('coding', 'drills/coding/sum/tool')).toEqual(['drills/coding/sum/tool.sh']);
    }
    db.prepare("UPDATE lesson_file SET mode=NULL WHERE course_id='coding' AND path='drills/coding/sum/tool.sh'").run();
    expect(await createContentReader('db', async () => db).listCourseFileEntries('coding', 'drills/coding/sum/tool')).toEqual([{ path: 'drills/coding/sum/tool.sh', mode: null }]);
  } finally { db.close(); }
});

it('serves binary DB images and cheatsheet assets without copying their views', async () => {
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; vi.resetModules();
  const reader = (await import('./reader')).contentReader(); const db = await (await import('./reader')).contentDatabase();
  const writer = await import('./writer');
  for (const id of ['coding', 'sheet']) { const { bundle, blobs } = await bundleFromDirectory(repo, id); await writer.putCourseBundle(db, bundle, blobs, { namespace: 'namespace' }); }
  const bytes = new Uint8Array([0xff, 0x89, 0x50, 0, 0xfe, 0x7f]).subarray(1, 5);
  const blob = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  const originalRead = reader.readCourseBlob.bind(reader);
  const imageSpy = vi.spyOn(reader, 'readImage').mockResolvedValue(blob);
  const fileSpy = vi.spyOn(reader, 'readCourseBlob').mockImplementation((id, path) => path === 'cheatsheets/sheet/asset.png' ? Promise.resolve(blob) : originalRead(id, path));
  const app = connect(); const handlers: Array<(request: any, response: any, next: () => void) => Promise<void>> = [];
  const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false });
  plugin.configureServer({ httpServer: null, middlewares: { use: (handler: typeof handlers[number]) => { handlers.push(handler); app.use(handler as any); } } } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    for (const path of ['/images/example.png', '/cheatsheets/sheet/asset.png']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    let body: Uint8Array | undefined;
    const response = { statusCode: 0, setHeader: () => {}, end: (value: Uint8Array) => { body = value; } };
    await handlers[1]!({ url: '/images/example.png', method: 'GET' }, response, () => { throw new Error('Image fell through'); });
    expect(body).toBe(bytes);
    await handlers[0]!({ url: '/cheatsheets/sheet/asset.png', method: 'GET' }, response, () => { throw new Error('Cheatsheet fell through'); });
    expect(body?.buffer).toBe(bytes.buffer); expect(body?.byteOffset).toBe(bytes.byteOffset); expect(body?.byteLength).toBe(bytes.byteLength);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); imageSpy.mockRestore(); fileSpy.mockRestore(); db.close(); }
});

it('revalidates DB image and cheatsheet blobs and changes validators after publication', async () => {
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; vi.resetModules();
  const db = await (await import('./reader')).contentDatabase(); const writer = await import('./writer');
  for (const id of ['coding', 'sheet']) { const { bundle, blobs } = await bundleFromDirectory(repo, id); await writer.putCourseBundle(db, bundle, blobs, { namespace: 'namespace' }); }
  const app = connect(); const plugin = (await import('../apiPlugin')).default({ sandboxManager: { all: () => [], close: () => {} } as any, enableDeterministicWatchers: false });
  plugin.configureServer({ httpServer: null, middlewares: app } as any);
  const server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const [id, path, sourcePath, nextBytes] of [['coding', '/images/example.png', 'images/example.png', 'new image bytes'], ['sheet', '/cheatsheets/sheet/sections/one.html', 'cheatsheets/sheet/sections/one.html', '<h2>Updated</h2>']] as const) {
      const first = await fetch(origin + path); expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-cache');
      const old = first.headers.get('etag'); expect(old).toMatch(/^"[a-f0-9]{64}"$/);
      const cached = await fetch(origin + path, { headers: { 'if-none-match': `"other", W/${old}` } }); expect(cached.status).toBe(304); expect(await cached.text()).toBe(''); expect(cached.headers.get('etag')).toBe(old);
      const head = await fetch(origin + path, { method: 'HEAD', headers: { 'if-none-match': old! } }); expect(head.status).toBe(304); expect(await head.text()).toBe('');
      await file(sourcePath, nextBytes); const { bundle, blobs } = await bundleFromDirectory(repo, id); expect(await writer.putCourseBundle(db, bundle, blobs, { namespace: 'namespace', expectedRevision: 1 })).toBe(2);
      const changed = await fetch(origin + path, { headers: { 'if-none-match': old! } }); expect(changed.status).toBe(200); expect(changed.headers.get('etag')).not.toBe(old); expect(await changed.text()).toBe(nextBytes);
    }
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); plugin.closeBundle?.(); db.close(); }
});

it('serves imported catalog and content in both modes and observes publishes', async () => {
  const enriched = structuredClone(course) as any;
  enriched.chapters[0].drills[1].scaffold = { seedPath: 'reading/coding/read.seed.md' };
  enriched.chapters[0].drills.push({ id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 10, sourcePath: 'drills/coding/pair/workspace/main.ts', workspacePath: 'drills/coding/pair/workspace', testRunner: 'vitest', handoffPath: 'guides/coding/handoff.md', rubricPath: 'guides/coding/rubric.md', instructions: '## Milestone 1\nFirst\n## Milestone 2\nSecond' });
  await file('courses/coding.json', JSON.stringify(enriched));
  await file('courses/coding.hints.json', JSON.stringify({ ...hints, drills: { ...hints.drills, pair: [{ title: 'Milestone 1', approach: 'First', solution: 'First' }, { title: 'Milestone 2', approach: 'Second', solution: 'Second' }] } }));
  await file('reading/coding/read.seed.md', 'Baseline');
  await file('drills/coding/pair/workspace/main.ts', 'export const value = 1;');
  await file('drills/coding/pair/workspace/package.json', '{}');
  await file('guides/coding/handoff.md', '{{drillTitle}} {{rubric}}'); await file('guides/coding/rubric.md', 'Rubric');
  await writeFile(join(temp, 'outside.json'), 'secret'); await symlink(join(temp, 'outside.json'), join(repo, 'outlines/coding/escape.json'));
  await symlink(join(temp, 'outside.json'), join(repo, 'images/escape.png'));
  const digest = createHash('sha256').update('one').update('\0').update('<h2>One</h2>').update('\0').digest('hex');
  await file('cheatsheets/sheet/page.html', `<!-- interview-runner-sections-sha256:${digest} -->\n<div>layout</div>`);
  const readSnapshot = async () => {
    const courses = await import('../courses'); const reader = await import('./reader');
    const outlines = await import('../outlines'); const maps = await import('../mapRecall'); const sheets = await import('../cheatsheets');
    const apiPlugin = (await import('../apiPlugin')).default;
    const handlers: Array<(request: any, response: any, next: () => void) => Promise<void>> = [];
    const manager = { all: () => [], close: () => {} };
    const plugin = apiPlugin({ sandboxManager: manager as any, allowCodingRequest: () => true, enableDeterministicWatchers: false });
    plugin.configureServer({ httpServer: null, middlewares: { use: (handler: typeof handlers[number]) => handlers.push(handler) } } as any);
    const request = async (path: string) => {
      let payload = ''; let status = 0;
      const response = { setHeader: () => {}, set statusCode(value: number) { status = value; }, end: (value: string) => { payload = value; } };
      await handlers.at(-1)!({ url: path, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response, () => {});
      return { status, body: JSON.parse(payload) as unknown };
    };
    const all = await courses.loadCourses(); const mapCourse = all.find((item) => item.id === 'map')!;
    const sheetManifest = (await courses.loadCheatsheet('sheet'))!;
    const fileReader = reader.contentReader();
    await expect(fileReader.readCourseFile('coding', '../escape')).rejects.toThrow();
    expect(await fileReader.readCourseFile('coding', 'outlines/coding/missing.json')).toBeUndefined();
    expect(await fileReader.courseFileExists('coding', 'outlines/coding/read.json')).toBe(true);
    expect(await fileReader.courseFileExists('coding', 'outlines/coding/missing.json')).toBe(false);
    expect(await fileReader.listCourseFiles('coding', 'outlines/coding/re')).toEqual(['outlines/coding/read.json']);
    if (reader.contentSource() === 'files') await expect(fileReader.readCourseFile('coding', 'outlines/coding/escape.json')).rejects.toThrow();
    else expect(await fileReader.readCourseFile('coding', 'outlines/coding/escape.json')).toBeUndefined();
    expect(await outlines.loadOutline('coding', 'missing')).toBeUndefined();
    expect(await sheets.readCheatsheetAsset(['sheet', '..', 'page.html'])).toBeUndefined();
    expect(await request('/api/outlines/coding/missing')).toMatchObject({ status: 404 });
    const books = await request('/api/books'); const apiCourses = await request('/api/courses'); const handoff = await request('/api/drills/coding/pair/handoff');
    expect(handoff).toMatchObject({ status: 200, body: { prompt: 'Pair Rubric' } });
    const expectedOwner = reader.contentSource() === 'db' ? 'namespace' : 'owner/repo';
    expect(apiCourses.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'coding', repo: expectedOwner })]));
    const library = await request(reader.contentSource() === 'db' ? '/api/library?workspace=namespace' : '/api/library'); expect(JSON.stringify(library.body)).toContain(`"repo":"${expectedOwner}"`);
    if (reader.contentSource() === 'db') {
      let data: Uint8Array | undefined; let nextCalled = false; let status = 0;
      const response = { setHeader: () => {}, set statusCode(value: number) { status = value; }, end: (value: Uint8Array) => { data = value; } };
      await handlers[1]!({ url: '/images/example.png', method: 'GET' }, response, () => { nextCalled = true; });
      expect(status).toBe(200); expect(Buffer.from(data!).toString()).toBe('image bytes');
      await handlers[1]!({ url: '/images/%2e%2e/example.png', method: 'GET' }, response, () => { nextCalled = true; }); expect(nextCalled).toBe(true);
    } else {
      let nextCalled = false;
      await handlers[1]!({ url: '/images/escape.png', method: 'GET', headers: {} }, {}, () => { nextCalled = true; });
      expect(nextCalled).toBe(true); expect(await fileReader.readImage('escape.png')).toBeUndefined();
    }
    const apiRows = (apiCourses.body as Array<{ repo: string }>).map(({ repo: _repo, ...item }) => item);
    return { all, hints: await courses.loadCourseHints('coding'), outline: await outlines.loadOutline('coding', 'read'), map: await maps.readMapRecall(mapCourse, mapCourse.chapters[0]!.drills[0]!), document: await sheets.readCheatsheetDocument(sheetManifest), asset: await sheets.readCheatsheetAsset(['sheet', 'page.html']), image: Buffer.from((await fileReader.readImage('example.png'))!.bytes).toString(), owner: await fileReader.courseOwner('coding'), books, apiRows, handoff };
  };
  const files = await readSnapshot();
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; vi.resetModules();
  const reader = await import('./reader'); const db = await reader.contentDatabase(); const writer = await import('./writer');
  for (const id of ['coding', 'map', 'sheet']) { const { bundle, blobs } = await bundleFromDirectory(repo, id); await writer.putCourseBundle(db, bundle, blobs, { namespace: 'namespace' }); }
  const otherImage = Buffer.from('other image'); const hash = writer.putBlob(db, otherImage);
  db.prepare("INSERT INTO lesson_file(course_id,lesson_id,path,role,blob_sha256) VALUES('map',NULL,'images/example.png','image',?)").run(hash);
  expect(Buffer.from((await reader.contentReader().readImage('example.png'))!.bytes).toString()).toBe('image bytes');
  const changedPaths = ['reading/coding/read.seed.md', 'guides/coding/handoff.md', 'guides/coding/rubric.md', 'outlines/coding/read.json', 'mindmaps/map/map.md', 'cheatsheets/sheet/sections/one.html', 'cheatsheets/sheet/page.html', 'images/example.png'];
  const original = await Promise.all(changedPaths.map((path) => readFile(join(repo, path))));
  for (const path of changedPaths) await file(path, 'different on disk');
  const database = await readSnapshot();
  for (const [index, path] of changedPaths.entries()) await writeFile(join(repo, path), original[index]!);
  expect({ ...database, owner: files.owner }).toEqual(files);
  expect(database.owner).toEqual({ kind: 'namespace', id: 'namespace' });
  expect(await reader.contentReader().listCourseFiles('coding', 'outlines/coding/')).toEqual(['outlines/coding/read.json']);
  const sheets = await import('../cheatsheets'); const changedSection = writer.putBlob(db, Buffer.from('<h2>Changed</h2>'));
  const originalSection = db.prepare("SELECT blob_sha256 FROM lesson_file WHERE course_id='sheet' AND path='cheatsheets/sheet/sections/one.html'").get() as { blob_sha256: string };
  db.prepare("UPDATE lesson_file SET blob_sha256=? WHERE course_id='sheet' AND path='cheatsheets/sheet/sections/one.html'").run(changedSection);
  expect(await sheets.readCheatsheetAsset(['sheet', 'page.html'])).toBeUndefined();
  db.prepare("UPDATE lesson_file SET blob_sha256=? WHERE course_id='sheet' AND path='cheatsheets/sheet/sections/one.html'").run(originalSection.blob_sha256);
  const courses = await import('../courses');
  expect((await courses.listCheatsheets())[0]?.repo).toBe('namespace');
  expect(await courses.loadCourses(join(repo, 'courses'))).toEqual(files.all);
  await file('courses/coding.json', JSON.stringify({ ...enriched, title: 'Updated' }));
  const update = await bundleFromDirectory(repo, 'coding'); await writer.putCourseBundle(db, update.bundle, update.blobs, { namespace: 'namespace', expectedRevision: 1 });
  expect((await courses.loadCourse('coding'))?.title).toBe('Updated');
  db.prepare("UPDATE course SET manifest_json=replace(manifest_json,'Updated','External') WHERE id='coding'").run();
  expect((await courses.loadCourse('coding'))?.title).toBe('Updated');
  courses.invalidateCourseCatalog(); expect((await courses.loadCourse('coding'))?.title).toBe('External');
  db.prepare("UPDATE course SET manifest_json=replace(manifest_json,'External','Remote') WHERE id='coding'").run();
  db.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
  expect((await courses.loadCourse('coding'))?.title).toBe('Remote');
  writer.deleteCourse(db, 'coding'); expect(await courses.loadCourse('coding')).toBeUndefined();
  db.close();
});

it('imports and exports exact bytes, deduplicates, and revisions only changed content', async () => {
  await usePortableCourse();
  const dbPath = join(temp, 'content.db'); const env = { ...process.env, VITEST: '1' };
  const run = (script: string, args: string[]) => exec(resolve(runner, 'node_modules/.bin/tsx'), [script, ...args], { cwd: runner, env });
  await chmod(join(repo, 'reading/coding/read.md'), 0o666);
  expect((await run('scripts/content-import.ts', ['--db', dbPath])).stdout).toContain('Imported 3');
  expect((await run('scripts/content-import.ts', ['--db', dbPath])).stdout).toContain('skipped 3');
  for (const id of ['coding', 'map', 'sheet']) {
    const output = join(temp, `export-${id}`); await run('scripts/content-export.ts', [id, output, '--db', dbPath]);
    const original = await bundleFromDirectory(repo, id); const exported = await bundleFromDirectory(output, id);
    expect(exported.bundle).toEqual(original.bundle);
    for (const path of Object.keys(original.bundle.files)) {
      expect(await readFile(join(output, path))).toEqual(await readFile(join(repo, path)));
      expect((await lstat(join(output, path))).mode & 0o777).toBe((await lstat(join(repo, path))).mode & 0o777);
    }
  }
  const db = await openContentDb(dbPath); const before = db.prepare('SELECT count(*) AS n FROM blob').get() as { n: number }; db.close();
  await file('drills/coding/sum/sum.ts', 'export const sum = (a: number, b: number) => a + b + 0;\n');
  expect((await run('scripts/content-import.ts', ['--db', dbPath])).stdout).toContain('Imported 1');
  const updated = await openContentDb(dbPath);
  expect(updated.prepare('SELECT count(*) AS n FROM blob').get()).toMatchObject({ n: before.n + 1 });
  expect(updated.prepare('SELECT course_id,revision FROM course_revision ORDER BY course_id,revision').all()).toMatchObject([{ course_id: 'coding', revision: 1 }, { course_id: 'coding', revision: 2 }, { course_id: 'map', revision: 1 }, { course_id: 'sheet', revision: 1 }]);
  expect(updated.prepare("SELECT lesson_id FROM lesson_fts WHERE lesson_fts MATCH 'quokka'").all()).toMatchObject([{ lesson_id: 'sum' }]);
  expect(updated.prepare("SELECT path FROM asset_fts WHERE asset_fts MATCH 'claim'").all()).toMatchObject([{ path: 'outlines/coding/read.json' }]); updated.close();
  const historical = join(temp, 'historical'); await run('scripts/content-export.ts', ['coding', historical, '--revision', '1', '--db', dbPath]);
  expect(await readFile(join(historical, 'drills/coding/sum/sum.ts'), 'utf8')).toBe('export const sum = (a: number, b: number) => a + b;\n');
});

it('indexes searchable text but never PNG, PDF, SVG, or disguised binary assets', async () => {
  await file('cheatsheets/sheet/notes.md', 'Distinctive text quokka.');
  await file('cheatsheets/sheet/assets/icon.PNG', 'pngsecret');
  await file('cheatsheets/sheet/assets/report.pdf', '%PDF-1.7 pdfsecret');
  await file('cheatsheets/sheet/assets/image.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>svgsecret</text></svg>');
  await file('cheatsheets/sheet/assets/disguised-pdf.txt', '%PDF-1.7 hiddenpdf');
  await file('cheatsheets/sheet/assets/disguised-svg.txt', '<?xml version="1.0"?><svg>hiddensvg</svg>');
  await mkdir(join(repo, 'cheatsheets/sheet/assets'), { recursive: true });
  await writeFile(join(repo, 'cheatsheets/sheet/assets/disguised.txt'), Buffer.from([0, 98, 105, 110, 97, 114, 121]));
  const { bundle, blobs } = await bundleFromDirectory(repo, 'sheet'); const db = await openContentDb(':memory:');
  try {
    await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'owner' });
    expect(db.prepare("SELECT path FROM asset_fts WHERE asset_fts MATCH 'quokka'").all()).toMatchObject([{ path: 'cheatsheets/sheet/notes.md' }]);
    for (const token of ['pngsecret', 'pdfsecret', 'svgsecret', 'hiddenpdf', 'hiddensvg', 'binary']) expect(db.prepare('SELECT path FROM asset_fts WHERE asset_fts MATCH ?').all(token)).toEqual([]);
    for (const path of ['icon.PNG', 'report.pdf', 'image.svg', 'disguised-pdf.txt', 'disguised-svg.txt', 'disguised.txt']) {
      const file = bundle.files[`cheatsheets/sheet/assets/${path}`]!;
      const stored = db.prepare('SELECT bytes FROM blob WHERE sha256=?').get(file.sha256) as { bytes: Uint8Array };
      expect(Buffer.from(stored.bytes)).toEqual(Buffer.from(blobs.get(file.sha256)!));
    }
  } finally { db.close(); }
});

it.each(['node:sqlite', 'better-sqlite3'] as const)('compacts legacy binary FTS rows without changing text, blobs or revisions using %s', async (provider) => {
  for (const [path, content] of [['image.png', 'pngsecret'], ['doc.pdf', '%PDF-1.7 pdfsecret'], ['image.svg', '<svg>svgsecret</svg>'], ['notes.md', 'Text quokka']]) await file(`cheatsheets/sheet/${path}`, content);
  const path = join(temp, `compact-${provider.replace(':', '-')}.db`); let db = await openContentDb(path);
  const output = join(temp, `output-${provider.replace(':', '-')}.db`);
  if (provider === 'better-sqlite3') { db.close(); const Better = (await import('better-sqlite3')).default; db = new Better(path); }
  try {
    const { bundle, blobs } = await bundleFromDirectory(repo, 'sheet'); await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'owner' });
    const insert = db.prepare('INSERT INTO asset_fts(course_id,path,text) VALUES(?,?,?)');
    for (const [name, text] of [['image.png', 'pngsecret'], ['doc.pdf', 'pdfsecret'], ['image.svg', 'svgsecret']]) insert.run('sheet', `cheatsheets/sheet/${name}`, text);
    const files = db.prepare('SELECT * FROM lesson_file ORDER BY course_id,path').all(); const revisions = db.prepare('SELECT * FROM course_revision ORDER BY course_id,revision').all();
    const text = db.prepare("SELECT course_id,path,text FROM asset_fts WHERE path NOT LIKE '%.png' AND path NOT LIKE '%.pdf' AND path NOT LIKE '%.svg' ORDER BY path").all();
    const { compactAssetIndex } = await import('./compactAssetIndex');
    expect(compactAssetIndex(db, false)).toEqual({ removed: 3, retained: text.length });
    expect(db.prepare('SELECT count(*) AS n FROM asset_fts').get()).toMatchObject({ n: text.length + 3 });
    insert.run('sheet', 'cheatsheets/sheet/orphan.png', 'orphansecret');
    expect(() => compactAssetIndex(db, true, output)).toThrow('does not have exactly one associated blob');
    expect(db.prepare('SELECT count(*) AS n FROM asset_fts').get()).toMatchObject({ n: text.length + 4 });
    db.prepare('DELETE FROM asset_fts WHERE path=?').run('cheatsheets/sheet/orphan.png');
    const failingVacuum = { prepare: (sql: string) => sql === 'VACUUM INTO ?' ? { run: () => { throw new Error('disk full'); } } : db.prepare(sql), close: () => {}, exec: db.exec.bind(db) };
    expect(() => compactAssetIndex(failingVacuum, true, output)).toThrow('Working snapshot FTS rows were updated but VACUUM INTO failed');
    expect(db.prepare('SELECT course_id,path,text FROM asset_fts ORDER BY path').all()).toEqual(text);
    expect(db.prepare("SELECT path FROM asset_fts WHERE asset_fts MATCH 'quokka'").all()).toMatchObject([{ path: 'cheatsheets/sheet/notes.md' }]);
    expect(db.prepare('SELECT * FROM lesson_file ORDER BY course_id,path').all()).toEqual(files);
    expect(db.prepare('SELECT * FROM course_revision ORDER BY course_id,revision').all()).toEqual(revisions);
    for (const [hash, bytes] of blobs) { const stored = db.prepare('SELECT bytes FROM blob WHERE sha256=?').get(hash) as { bytes: Uint8Array }; expect(Buffer.from(stored.bytes)).toEqual(Buffer.from(bytes)); }
    expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    expect(compactAssetIndex(db, true, output)).toEqual({ removed: 0, retained: text.length });
    const copy = await openContentDb(output);
    try { expect(copy.prepare('SELECT course_id,path,text FROM asset_fts ORDER BY path').all()).toEqual(text); expect(copy.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' }); } finally { copy.close(); }
  } finally { db.close(); }
});

it('requires an existing non-symlink database and applies compaction only when explicitly requested', async () => {
  await file('cheatsheets/sheet/icon.png', 'pngsecret');
  const path = join(temp, 'cli.db'); const db = await openContentDb(path);
  const { bundle, blobs } = await bundleFromDirectory(repo, 'sheet'); await (await import('./writer')).putCourseBundle(db, bundle, blobs, { namespace: 'owner' });
  db.prepare('INSERT INTO asset_fts(course_id,path,text) VALUES(?,?,?)').run('sheet', 'cheatsheets/sheet/icon.png', 'pngsecret'); db.close();
  const env = { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, XDG_STATE_HOME: join(temp, 'state') };
  const run = (...args: string[]) => exec(process.execPath, ['--import', 'tsx', 'scripts/content-compact-fts.ts', ...args], { cwd: runner, env });
  const output = join(temp, 'compacted.db'); const missing = join(temp, 'missing.db'); await expect(run('--db', missing, '--output', output, '--apply')).rejects.toThrow(); await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  const link = join(temp, 'link.db'); await symlink(path, link); await expect(run('--db', link, '--output', output, '--apply')).rejects.toThrow('not a symlink');
  const before = createHash('sha256').update(await readFile(path)).digest('hex');
  expect(JSON.parse((await run('--db', path)).stdout)).toMatchObject({ applied: false, removed: 1 });
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before);
  expect(JSON.parse((await run('--db', path, '--output', output, '--apply')).stdout)).toMatchObject({ applied: true, removed: 1, integrity: 'ok' });
  const outputHash = createHash('sha256').update(await readFile(output)).digest('hex');
  await expect(run('--db', path, '--output', output, '--apply')).rejects.toThrow();
  expect(createHash('sha256').update(await readFile(output)).digest('hex')).toBe(outputHash);
  expect(JSON.parse((await run('--db', path, '--output', join(temp, 'again.db'), '--apply')).stdout)).toMatchObject({ applied: true, removed: 0, integrity: 'ok' });
});

it('imports a mode-only change as a revision without uploading another blob', async () => {
  await usePortableCourse();
  const dbPath = join(temp, 'content.db'); const env = { ...process.env, VITEST: '1' };
  const run = () => exec(resolve(runner, 'node_modules/.bin/tsx'), ['scripts/content-import.ts', '--db', dbPath], { cwd: runner, env });
  const path = join(repo, 'reading/coding/read.md'); await chmod(path, 0o666); await run();
  const before = await openContentDb(dbPath); const count = before.prepare('SELECT count(*) AS n FROM blob').get(); before.close();
  await chmod(path, 0o777); expect((await run()).stdout).toContain('Imported 1');
  const db = await openContentDb(dbPath);
  expect(db.prepare('SELECT revision FROM course WHERE id=?').get('coding')).toMatchObject({ revision: 2 });
  expect(db.prepare('SELECT count(*) AS n FROM blob').get()).toEqual(count);
  expect(db.prepare('SELECT mode FROM lesson_file WHERE course_id=? AND path=?').get('coding', 'reading/coding/read.md')).toMatchObject({ mode: 0o777 }); db.close();
  expect((await run()).stdout).toContain('skipped 3');
});

it('excludes workspace junk and skips symlinks without following them', async () => {
  for (const path of ['.pytest_cache/cache', '.ruff_cache/cache', '.mypy_cache/cache', '.tox/file', 'build/file', '.ir-seeded']) await file(`drills/coding/sum/${path}`, 'junk');
  await symlink(temp, join(repo, 'drills/coding/sum/.venv')); await symlink(join(repo, 'reading/coding/read.md'), join(repo, 'drills/coding/sum/link.md'));
  const { bundle } = await bundleFromDirectory(repo, 'coding');
  for (const path of Object.keys(bundle.files)) expect(path).not.toMatch(/\.pytest_cache|\.ruff_cache|\.mypy_cache|\.tox|\/build\/|\.ir-seeded|\.venv|link\.md/);
  expect(bundle.files['drills/coding/sum/sum.ts']).toBeDefined();
});

it('reports missing referenced images during gathering and publishing', async () => {
  await file('reading/coding/read.md', 'See https://example.com/images/reference.html and https://example.com/?next=/images/external.png\n![image](/images/example.png)\n');
  const { bundle, blobs } = await bundleFromDirectory(repo, 'coding'); delete bundle.files['images/example.png'];
  const { putCourseBundle } = await import('./writer'); const db = await openContentDb(':memory:');
  await expect(putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: expect.arrayContaining([{ field: 'reading/coding/read.md', message: 'Missing referenced image: images/example.png' }]) });
  await rm(join(repo, 'images/example.png'));
  await expect(bundleFromDirectory(repo, 'coding')).rejects.toMatchObject({ errors: [{ field: 'reading/coding/read.md', message: 'Missing referenced image: images/example.png' }] }); db.close();
});

it('gathers and publishes root-relative images while ignoring external URLs', async () => {
  await file('reading/coding/read.md', 'See https://example.com/images/reference.html and https://example.com/?next=/images/external.png\n![image](/images/example.png)\n');
  const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
  expect(bundle.files['images/example.png']).toBeDefined();
  const { putCourseBundle } = await import('./writer'); const db = await openContentDb(':memory:');
  expect(await putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).toBe(1); db.close();
});

it('extracts only root-relative image tokens across supported delimiters', () => {
  const text = ['/images/first.png', '"/images/quoted.png"', "'/images/single.png'", '`/images/tick.png`', '(/images/paren.png)', 'src=/images/equals.png', ' /images/space.png', 'https://example.com/images/external.png', 'https://example.com/?next=/images/external-query.png', 'https://example.com/path(redirect=/images/external-nested.png', 'prefix/images/not-root.png', 'https://example.com/a)![local](/images/adjacent.png'].join('\n');
  expect(imageReferences(Buffer.from(text))).toEqual(['images/first.png', 'images/quoted.png', 'images/single.png', 'images/tick.png', 'images/paren.png', 'images/equals.png', 'images/space.png', 'images/adjacent.png']);
});

it('exports recorded mode despite a restrictive umask', async () => {
  await chmod(join(repo, 'reading/coding/read.md'), 0o666);
  const { bundle, blobs } = await bundleFromDirectory(repo, 'coding'); const previous = process.umask(0o077);
  try { await writeBundleToDirectory(bundle, blobs, join(temp, 'mode-export')); } finally { process.umask(previous); }
  expect((await lstat(join(temp, 'mode-export/reading/coding/read.md'))).mode & 0o777).toBe(0o666);
});

it('rejects invalid manifest, missing files, bad hints, unsafe paths and stale revisions', async () => {
  const { putCourseBundle, ContentConflictError } = await import('./writer'); const db = await openContentDb(':memory:');
  const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
  expect(await putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).toBe(1);
  await expect(putCourseBundle(db, { ...bundle, manifest: {} }, blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: [{ field: 'id', message: expect.stringContaining('Invalid course manifest bundle: id') }] });
  const missing = structuredClone(bundle); delete missing.files['reading/coding/read.md']; delete missing.files['drills/coding/sum/sum.test.ts'];
  await expect(putCourseBundle(db, missing, blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: expect.arrayContaining([
    { field: 'chapters[0].drills[1].sourcePath', message: 'Missing reading/coding/read.md' },
    { field: 'chapters[0].drills[0].testPath', message: 'Missing drills/coding/sum/sum.test.ts' },
  ]) });
  await file('courses/coding.hints.json', JSON.stringify({ courseId: 'coding', drills: { sum: [{ title: 'Milestone 99', approach: 'x', solution: 'y' }] } }));
  const badHints = await bundleFromDirectory(repo, 'coding');
  await expect(putCourseBundle(db, badHints.bundle, badHints.blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ field: 'drills.sum[0].title' })]) });
  const unsafe = structuredClone(bundle); unsafe.files['../escape'] = Object.values(unsafe.files)[0]!;
  unsafe.files['other'] = { sha256: 'bad', size: 1 };
  await expect(putCourseBundle(db, unsafe, blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ field: '../escape' }), expect.objectContaining({ field: 'other' })]) });
  await expect(putCourseBundle(db, bundle, blobs, { namespace: 'owner', expectedRevision: 0 })).rejects.toBeInstanceOf(ContentConflictError);
  expect(db.prepare('SELECT count(*) AS n FROM course_revision').get()).toMatchObject({ n: 1 }); db.close();
});

it('reuses directory validator output and rejects non-behavioral tests', async () => {
  await usePortableCourse();
  await file('drills/coding/sum/sum.test.ts', "import { it, expect } from 'vitest'; it('bad', () => expect(1).toBe(1));\n");
  const { findTestQualityIssues } = await import('../../scripts/validate-course-tests');
  const { findMissingPaths } = await import('../../scripts/validate-course-paths');
  expect(await findMissingPaths(join(repo, 'courses'))).toEqual([]);
  const findings = await findTestQualityIssues(join(repo, 'courses'));
  expect(findings.findings.length).toBeGreaterThan(0);
  const env = { ...process.env, VITEST: '1' };
  try { await exec(resolve(runner, 'node_modules/.bin/tsx'), ['scripts/validate-course-tests-entry.ts', '--repo', repo], { cwd: runner, env }); throw new Error('Expected validation failure'); }
  catch (error) { expect((error as { stderr: string }).stderr).toContain(findings.findings[0]!.issue); }
  const { putCourseBundle, ContentValidationError } = await import('./writer'); const db = await openContentDb(':memory:'); const { bundle, blobs } = await bundleFromDirectory(repo, 'coding');
  await expect(putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: findings.findings.map(({ testPath, issue }) => ({ field: testPath, message: issue })) });
  await expect(putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).rejects.toBeInstanceOf(ContentValidationError); db.close();
  await rm(join(repo, 'mindmaps/coding/read.md'));
  const missing = await findMissingPaths(join(repo, 'courses')); expect(missing).toHaveLength(1);
  try { await exec(resolve(runner, 'node_modules/.bin/tsx'), ['scripts/validate-course-paths-entry.ts', '--repo', repo], { cwd: runner, env }); throw new Error('Expected path validation failure'); }
  catch (error) { const stderr = (error as { stderr: string }).stderr; expect(stderr).toContain(missing[0]!.field); expect(stderr).toContain(missing[0]!.path); }
});

it('migrates both SQLite providers idempotently and maintains FTS triggers', async () => {
  const { migrate } = await import('./contentDb'); const Better = (await import('better-sqlite3')).default;
  const sqlite = await import('node:sqlite');
  for (const db of [new sqlite.DatabaseSync(':memory:'), new Better(':memory:')]) {
    migrate(db); migrate(db);
    db.exec("INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES('id','owner','course','Title','now','now',1,'{}'); INSERT INTO chapter VALUES('id','chapter',0,'Chapter'); INSERT INTO lesson VALUES('id','lesson','chapter',0,'Title','reading','scratch',1,'koala','{}');");
    expect(db.prepare("SELECT lesson_id FROM lesson_fts WHERE lesson_fts MATCH 'koala'").all()).toMatchObject([{ lesson_id: 'lesson' }]);
    db.exec("UPDATE lesson SET instructions='platypus' WHERE id='lesson'");
    expect(db.prepare("SELECT lesson_id FROM lesson_fts WHERE lesson_fts MATCH 'platypus'").all()).toMatchObject([{ lesson_id: 'lesson' }]);
    db.exec("DELETE FROM course WHERE id='id'"); expect(db.prepare('SELECT count(*) AS n FROM lesson_fts').get()).toMatchObject({ n: 0 }); db.close();
  }
});

it('retains shared file associations and revisions after soft deletion', async () => {
  const shared = structuredClone(course);
  shared.chapters[0]!.drills.push({ ...shared.chapters[0]!.drills[0]!, id: 'second', title: 'Second', instructions: 'Compute again.' });
  await file('courses/coding.json', `${JSON.stringify(shared, null, 2)}\n`);
  const { putCourseBundle, getCourseBundle, listCourses, deleteCourse } = await import('./writer'); const db = await openContentDb(':memory:');
  const { bundle, blobs } = await bundleFromDirectory(repo, 'coding'); await putCourseBundle(db, bundle, blobs, { namespace: 'owner' });
  expect(db.prepare("SELECT lesson_id FROM lesson_file WHERE path='drills/coding/sum/sum.ts' ORDER BY lesson_id").all()).toMatchObject([{ lesson_id: 'second' }, { lesson_id: 'sum' }]);
  deleteCourse(db, 'coding'); expect(listCourses(db)).toHaveLength(0); expect(getCourseBundle(db, 'coding')).toBeUndefined(); expect(getCourseBundle(db, 'coding', 1)).toEqual(bundle);
  expect(db.prepare("SELECT value FROM content_meta WHERE key='revision'").get()).toMatchObject({ value: '2' }); db.close();
});
