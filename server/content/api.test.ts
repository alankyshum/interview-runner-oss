// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createContentApi } from './api';
import { issueApiKey } from './apiKeys';
import { openContentDb, type ContentDb } from './contentDb';
import { writeBundleToDirectory, type CourseBundle } from './bundle';

let state: DatabaseSync; let db: ContentDb; let server: Server; let base: string; let temp: string; let key: string; let other: string; let readonly: string;
const manifest = { id: 'map', type: 'map-recall', title: 'Map', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/map/map.md', instructions: 'Study.' }] }] };
const blobs = new Map<string, Uint8Array>();
function file(text: string) { const data = Buffer.from(text); const sha256 = createHash('sha256').update(data).digest('hex'); blobs.set(sha256, data); return { sha256, size: data.length, mode: 0o640 }; }
const bundle: CourseBundle = { manifest, files: { 'courses/map.json': file(`${JSON.stringify(manifest)}\n`), 'mindmaps/map/map.md': file('# Map\n'), [`mindmaps/map/${'long-name-'.repeat(12)}.txt`]: file('extra\0bytes\n') } };
function request(path: string, method = 'GET', body?: BodyInit, token = key, extra: Record<string, string> = {}) { return fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...extra }, ...(body === undefined ? {} : { body }) }); }
const payload = (ns = 'me', value = bundle) => JSON.stringify({ ...value, namespace: ns });
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'content-api-test-')); state = new DatabaseSync(':memory:'); db = await openContentDb(join(temp, 'content.db'));
  const api = createContentApi({ stateDb: state, contentDb: db, readWhiteboards: async (courseId, drillId) => drillId === 'recall' ? { questions: [{ id: 'one', prompt: 'Question' }], snapshot: null, courseId } : null });
  key = issueApiKey(state, { name: 'owner', scopes: ['content:write'], namespaces: ['me'] }); other = issueApiKey(state, { name: 'other', scopes: ['content:write'], namespaces: ['sam'] }); readonly = issueApiKey(state, { name: 'reader', scopes: ['content:read'], namespaces: ['me'] });
  server = createServer((req, res) => { const url = new URL(req.url!, 'http://localhost'); void api.handle(req, res, url.pathname.split('/').filter(Boolean), req.method!).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.close(); state.close(); await rm(temp, { recursive: true, force: true }); });
async function upload() {
  for (const [hash, data] of blobs) expect((await request('/api/content/blobs', 'POST', Buffer.from(data), key, { 'content-type': 'application/octet-stream', 'x-blob-sha256': hash })).status).toBe(201);
}
async function publish() { await upload(); expect((await request('/api/content/courses/map', 'PUT', payload())).status).toBe(200); }

it('ensures only an allowed workspace with write scope, idempotently', async () => {
  expect((await request('/api/content/workspaces/me', 'PUT', undefined, readonly)).status).toBe(403);
  expect((await request('/api/content/workspaces/sam', 'PUT')).status).toBe(403);
  expect((await request('/api/content/workspaces/INVALID', 'PUT')).status).toBe(400);
  for (let i = 0; i < 2; i++) expect(await (await request('/api/content/workspaces/me', 'PUT')).json()).toEqual({ workspace: 'me' });
  expect(db.prepare("SELECT COUNT(*) AS count FROM content_meta WHERE key='workspace:me'").get()).toMatchObject({ count: 1 });
});

it('refuses a globally occupied course id in another authorized workspace', async () => {
  await publish();
  const response = await request('/api/content/courses/map/validate', 'POST', payload('sam'), other);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'Course ID already belongs to another workspace' });
});

it('allows namespace-scoped bearer reads of whiteboards only after authentication', async () => {
  await publish();
  const path = '/api/content/courses/map/whiteboards/recall';
  expect((await request(path, 'GET', undefined, 'invalid')).status).toBe(401);
  expect((await request(path, 'GET', undefined, other)).status).toBe(403);
  expect(await (await request(path, 'GET', undefined, readonly)).json()).toEqual({ courseId: 'map', questions: [{ id: 'one', prompt: 'Question' }], snapshot: null });
  expect((await request('/api/content/courses/map/whiteboards/missing')).status).toBe(404);
  expect((await request(path, 'PUT', '{}')).status).toBe(404);
  expect((await request('/api/content/courses/map', 'DELETE')).status).toBe(204);
  expect((await request(path)).status).toBe(404);
});

it('rejects agent whiteboard reads in state-proxy mode after key and namespace checks', async () => {
  await publish();
  const readWhiteboards = vi.fn(async () => ({ questions: [] }));
  const api = createContentApi({ stateDb: state, contentDb: db, readWhiteboards, whiteboardStateOrigin: 'https://state.example.test' });
  const proxy = createServer((req, res) => { void api.handle(req, res, new URL(req.url!, 'http://localhost').pathname.split('/').filter(Boolean), req.method!); });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/api/content/courses/map/whiteboards/recall`;
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${other}` } })).status).toBe(403);
    const response = await fetch(url, { headers: { authorization: `Bearer ${readonly}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Whiteboard state is authoritative at https://state.example.test/api/content/courses/map/whiteboards/recall' });
    expect(readWhiteboards).not.toHaveBeenCalled();
  } finally { await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())); }
});

it('handles upload, validation, publish, history, restore, export and deletion with namespace authorization', async () => {
  expect((await request('/api/content/courses', 'GET', undefined, 'invalid')).status).toBe(401);
  expect(await (await request('/api/content/me')).json()).toEqual({ id: key.split('_')[1], name: 'owner', scopes: ['content:write'], namespaces: ['me'] });
  expect((await request('/api/content/me', 'GET', undefined, 'invalid')).status).toBe(401);
  expect((await request('/api/content/courses/map', 'PUT', payload(), readonly)).status).toBe(403);
  const missing = await request('/api/content/blobs/missing', 'POST', JSON.stringify({ sha256: [...blobs.keys()] })); expect((await missing.json()).missing).toHaveLength(3);
  expect((await request('/api/content/courses/map', 'PUT', payload())).status).toBe(409);
  const validation = await request('/api/content/courses/map/validate', 'POST', payload()); expect(validation.status).toBe(409); expect((await validation.json()).missing).toEqual([...blobs.keys()]);
  await upload();
  expect((await request('/api/content/courses/map/validate', 'POST', payload())).status).toBe(200);
  expect((await request('/api/content/courses', 'GET')).headers.get('cache-control')).toBe('no-store');
  expect((await (await request('/api/content/courses')).json())).toEqual([]);
  expect(await (await request('/api/content/courses/map', 'PUT', JSON.stringify({ ...bundle, namespace: 'me', message: 'First publish' }))).json()).toMatchObject({ revision: 1 });
  expect((await request('/api/content/courses/map', 'PUT', payload(), other)).status).toBe(403);
  expect((await request('/api/content/courses/map', 'GET', undefined, other)).status).toBe(403);
  expect((await request('/api/content/courses/map', 'PUT', payload())).status).toBe(428);
  expect((await request('/api/content/courses/map', 'PUT', payload(), key, { 'if-match': '2' })).status).toBe(412);
  expect((await request('/api/content/courses/map', 'PUT', JSON.stringify({ ...bundle, namespace: 'me', message: 'x'.repeat(500) }), key, { 'if-match': '1' })).status).toBe(200);
  expect((await (await request('/api/content/courses?namespace=me', 'GET', undefined, readonly)).json())[0]).toMatchObject({ id: 'map', namespace: 'me', revision: 2 });
  expect(await (await request('/api/content/courses/map?revision=1')).json()).toMatchObject({ ...bundle, namespace: 'me', revision: 1 });
  const revisions = await (await request('/api/content/courses/map/revisions')).json(); expect(revisions).toHaveLength(2); expect(revisions[0].actor_api_key_id).toBe(key.split('_')[1]); expect(revisions[0].message).toBe('First publish'); expect(revisions[1].message).toBe('x'.repeat(500));
  expect(await (await request('/api/content/courses/map/revisions/1/restore', 'POST')).json()).toMatchObject({ revision: 3 });
  expect(await (await request('/api/content/courses/map')).json()).toMatchObject({ ...bundle, revision: 3 });
  const hash = [...blobs.keys()][0]!; expect(Buffer.from(await (await request(`/api/content/blobs/${hash}`)).arrayBuffer())).toEqual(Buffer.from(blobs.get(hash)!));
  expect((await request(`/api/content/blobs/${hash}`, 'GET', undefined, other)).status).toBe(404);
  const archive = Buffer.from(await (await request('/api/content/courses/map/export?revision=1')).arrayBuffer());
  const actual = join(temp, 'actual'); const expected = join(temp, 'expected'); await mkdir(actual); await writeBundleToDirectory(bundle, blobs, expected);
  execFileSync('tar', ['-xf', '-', '-C', actual], { input: archive });
  for (const path of Object.keys(bundle.files)) { expect(await readFile(join(actual, path))).toEqual(await readFile(join(expected, path))); expect((await stat(join(actual, path))).mode & 0o777).toBe((await stat(join(expected, path))).mode & 0o777); }
  expect((await request('/api/content/courses/map', 'DELETE')).status).toBe(204); expect((await request('/api/content/courses/map')).status).toBe(404);
  expect((await request('/api/content/courses/map?revision=1')).status).toBe(200); expect((await request('/api/content/courses/nope')).status).toBe(404);
});

it('rejects invalid inputs, bad blob hashes and oversized requests', async () => {
  await publish();
  expect((await request('/api/content/courses/map/validate', 'POST', payload('me', { ...bundle, manifest: { id: 'other' } }))).status).toBe(422);
  expect((await request('/api/content/courses/map/validate', 'POST', '{')).status).toBe(400);
  for (const message of [123, 'x'.repeat(501)]) {
    const invalid = await request('/api/content/courses/map/validate', 'POST', JSON.stringify({ ...bundle, namespace: 'me', message }));
    expect(invalid.status).toBe(422); expect((await invalid.json()).errors[0].field).toBe('message');
  }
  expect((await request('/api/content/courses/map', 'PUT', JSON.stringify({ ...bundle, namespace: 'me', message: 'x'.repeat(501) }), key, { 'if-match': '1' })).status).toBe(422);
  expect((await request('/api/content/blobs', 'POST', 'wrong', key, { 'content-type': 'application/octet-stream', 'x-blob-sha256': '0'.repeat(64) })).status).toBe(400);
  expect((await request('/api/content/courses/map/validate', 'POST', 'x'.repeat(8 * 1024 * 1024 + 1))).status).toBe(413);
  expect((await request('/api/content/blobs', 'POST', 'x'.repeat(16 * 1024 * 1024 + 1), key, { 'content-type': 'application/octet-stream', 'x-blob-sha256': '0'.repeat(64) })).status).toBe(413);
});

it('returns the original behavioral validation issues as 422', async () => {
  const invalid = { id: 'bad', title: 'Bad', chapters: [{ id: 'one', title: 'One', drills: [{ id: 'solve', title: 'Solve', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/bad/solve/solve.ts', testPath: 'drills/bad/solve/solve.test.ts', instructions: 'Implement.' }] }] };
  const value: CourseBundle = { manifest: invalid, files: { 'courses/bad.json': file(JSON.stringify(invalid)), 'drills/bad/solve/solve.ts': file('export const solve = () => 1;'), 'drills/bad/solve/solve.test.ts': file("import {it,expect} from 'vitest'; it('bad',()=>expect(1).toBe(1));") } };
  await upload(); const result = await request('/api/content/courses/bad/validate', 'POST', payload('me', value));
  expect(result.status).toBe(422);
  expect((await result.json()).errors).toEqual([
    { field: 'drills/bad/solve/solve.test.ts', message: 'does not import the learner source module' },
    { field: 'drills/bad/solve/solve.test.ts', message: 'test "bad" contains a literal-only assertion' },
    { field: 'drills/bad/solve/solve.test.ts', message: 'test "bad" never exercises an export from the learner source module' },
  ]);
});

it('rejects new reading chapters in validate and publish with map guidance', async () => {
  const book = { id: 'new-book', title: 'Book', chapters: [{ id: 'one', title: 'One', drills: [{ id: 'chapter', title: 'Chapter', contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: 'reading/new-book/chapter.md', outlinePath: 'outlines/new-book/chapter.json', instructions: 'Read.' }] }] };
  const value: CourseBundle = { manifest: book, files: { 'courses/new-book.json': file(JSON.stringify(book)) } };
  // Even with a missing manifest blob, the policy error takes precedence over 409.
  for (const [path, method] of [['/api/content/courses/new-book/validate', 'POST'], ['/api/content/courses/new-book', 'PUT']] as const) {
    const response = await request(path, method, payload('me', value));
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toMatch(/contentType:.*map.*mindmaps\/<course-id>\/<drill-id>\.md/);
  }
  expect((await request('/api/content/courses/new-book')).status).toBe(404);
});

it('rejects coding example findings in validation and publication without creating a revision', async () => {
  const drill = { id: 'sum', title: 'Sum', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/examples/sum/sum.ts', testPath: 'drills/examples/sum/sum.test.ts', instructions: '### Example 1\nInput: 2 and 3. Output: 5.' };
  const example = { id: 'examples', title: 'Examples', chapters: [{ id: 'one', title: 'One', drills: [drill] }] };
  const value: CourseBundle = { manifest: example, files: { 'courses/examples.json': file(JSON.stringify(example)), 'drills/examples/sum/sum.ts': file('export const sum = (a: number, b: number) => a + b;'), 'drills/examples/sum/sum.test.ts': file("import {it,expect} from 'vitest'; import {sum} from './sum'; it('adds',()=>expect(sum(2,3)).toBe(5));") } };
  await upload();
  const validation = await request('/api/content/courses/examples/validate', 'POST', payload('me', value)); expect(validation.status).toBe(422); expect((await validation.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'chapters[0].drills[0].instructions', message: expect.stringContaining('requires a fenced code block') })]));
  const published = await request('/api/content/courses/examples', 'PUT', payload('me', value)); expect(published.status).toBe(422); expect((await published.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'chapters[0].drills[0].instructions' })]));
  expect((await request('/api/content/courses/examples')).status).toBe(404);
  const corrected = { ...example, chapters: [{ ...example.chapters[0], drills: [{ ...drill, instructions: '## Examples\n```typescript\nsum(2, 3) // -> 5\n```' }] }] };
  const next: CourseBundle = { manifest: corrected, files: { ...value.files, 'courses/examples.json': file(JSON.stringify(corrected)) } }; await upload();
  const clean = await request('/api/content/courses/examples', 'PUT', payload('me', next)); expect(clean.status).toBe(200); expect((await clean.json()).warnings).toEqual([]);
  const rejectedUpdate = await request('/api/content/courses/examples', 'PUT', payload('me', value), key, { 'if-match': '1' }); expect(rejectedUpdate.status).toBe(422);
  expect((await (await request('/api/content/courses/examples')).json()).revision).toBe(1);
});

it('makes a publish visible in the DB-backed catalog without a restart', async () => {
  const previous = process.env.INTERVIEW_RUNNER_CONTENT_SOURCE;
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; vi.resetModules();
  const reader = await import('./reader'); const catalog = await import('../courses'); const dynamicApi = await import('./api'); const runtimeDb = await reader.contentDatabase();
  const api = dynamicApi.createContentApi({ stateDb: state, contentDb: runtimeDb });
  const runtime = createServer((req, res) => { void api.handle(req, res, new URL(req.url!, 'http://localhost').pathname.split('/').filter(Boolean), req.method!); });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`;
  try {
    expect(await catalog.loadCourses()).toEqual([]);
    for (const [hash, data] of blobs) expect((await fetch(`${url}/api/content/blobs`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream', 'x-blob-sha256': hash }, body: Buffer.from(data) })).status).toBe(201);
    expect((await fetch(`${url}/api/content/courses/map`, { method: 'PUT', headers: { authorization: `Bearer ${key}` }, body: payload() })).status).toBe(200);
    expect((await catalog.loadCourses()).map((course) => course.id)).toEqual(['map']);
  } finally {
    await new Promise<void>((resolve) => runtime.close(() => resolve())); runtimeDb.close();
    if (previous === undefined) delete process.env.INTERVIEW_RUNNER_CONTENT_SOURCE; else process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = previous;
    vi.resetModules();
  }
});
