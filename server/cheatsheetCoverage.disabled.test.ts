// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../shared/cheatsheetCoverage', async (original) => ({ ...(await original() as object), CHEATSHEET_COVERAGE_ENABLED: false }));
import apiPlugin from './apiPlugin';
import { courseRepos } from './courseRepos';
import { stateDb } from './db';
const root = await mkdtemp(join(tmpdir(), 'coverage-disabled-')); const previous = [...courseRepos];
beforeAll(async () => {
  await mkdir(join(root, 'courses'), { recursive: true }); await mkdir(join(root, 'cheatsheets/sheet/sections'), { recursive: true });
  await writeFile(join(root, 'courses/sheet.json'), JSON.stringify({ type: 'cheatsheet', id: 'sheet', title: 'Sheet', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/sheet/sections/one.html' }] }] }));
  courseRepos.splice(0, courseRepos.length, { id: 'fixture/courses', name: 'courses', root });
});
afterAll(async () => { courseRepos.splice(0, courseRepos.length, ...previous); await rm(root, { recursive: true, force: true }); });
it('disables coverage reads and writes without creating its tables', async () => {
  let handler: any; (apiPlugin().configureServer as any)({ middlewares: { use: (fn: any) => { handler = fn; } } });
  const request = async (method: string) => {
    let output = ''; const response = { statusCode: 0, setHeader: () => {}, end: (value: string) => { output = value; } };
    await handler({ url: '/api/cheatsheet-coverage/sheet', method, headers: {}, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} }, response, () => {});
    return { status: response.statusCode, body: JSON.parse(output) };
  };
  expect(await request('GET')).toEqual({ status: 200, body: { enabled: false } });
  expect((await request('POST')).status).toBe(403); expect((await request('DELETE')).status).toBe(403);
  expect(stateDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cheatsheet_coverage_%'").all()).toHaveLength(0);
});
it('does not forward disabled coverage to an authoritative state origin', async () => {
  let handler: any; (apiPlugin({ remoteStateOrigin: 'http://127.0.0.1:9' }).configureServer as any)({ middlewares: { use: (fn: any) => { handler = fn; } } });
  const upstream = vi.spyOn(globalThis, 'fetch');
  try {
    for (const [url, method] of ['/api/cheatsheet-coverage/sheet', '/api/cheatsheet-coverage/sheet/extra', '/api/cheatsheet-coverage', '/api//cheatsheet-coverage/sheet'].flatMap((url) => ['POST', 'DELETE'].map((method) => [url, method]))) {
      let output = ''; const response = { statusCode: 0, setHeader: () => {}, end: (value: string) => { output = value; } };
      await handler({ url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} }, response, () => {});
      expect(response.statusCode).toBe(403); expect(JSON.parse(output)).toEqual({ error: 'Coverage is disabled' });
    }
    expect(upstream).not.toHaveBeenCalled();
  } finally { upstream.mockRestore(); }
});
