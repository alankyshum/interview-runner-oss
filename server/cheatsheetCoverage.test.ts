// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import apiPlugin from './apiPlugin';
import { courseRepos } from './courseRepos';
import { emptyCoverageSignals, coverageScore } from '../shared/cheatsheetCoverage';
import { addCheatsheetCoverage, getCheatsheetCoverage, resetCheatsheetCoverage } from './cheatsheetCoverage';
import { stateDb } from './db';

const root = await mkdtemp(join(tmpdir(), 'coverage-api-')); const previous = [...courseRepos];
beforeAll(async () => {
  await mkdir(join(root, 'courses'), { recursive: true });
  await mkdir(join(root, 'cheatsheets/sheet/sections'), { recursive: true });
  await writeFile(join(root, 'courses/sheet.json'), JSON.stringify({ type: 'cheatsheet', id: 'sheet', title: 'Sheet', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/sheet/sections/one.html' }] }] }));
  courseRepos.splice(0, courseRepos.length, { id: 'fixture/courses', name: 'courses', root });
});
afterAll(async () => { courseRepos.splice(0, courseRepos.length, ...previous); await rm(root, { recursive: true, force: true }); });
async function request(method: string, url: string, value?: unknown, headers: Record<string, string> = {}) {
  let handler: any; (apiPlugin().configureServer as any)({ middlewares: { use: (fn: any) => { handler = fn; } } });
  let output = ''; const response = { statusCode: 0, setHeader: () => {}, end: (value: string) => { output = value; } };
  const encoded = value === undefined ? '' : JSON.stringify(value);
  await handler({ url, method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (encoded) yield encoded; } }, response, () => {});
  return { status: response.statusCode, body: JSON.parse(output) };
}
describe('cheatsheet engagement coverage', () => {
  it('only lets explicit interaction reach covered', () => {
    expect(coverageScore()).toBe(0); expect(coverageScore({ ...emptyCoverageSignals(), dwellMs: 999_999 })).toBe(0.25);
    for (const signal of ['selection', 'deep', 'map', 'link', 'copy']) expect(coverageScore({ ...emptyCoverageSignals(), [signal]: 1 })).toBe(1);
  });
  it('merges idempotent writes and guards resets from stale clients', async () => {
    const url = '/api/cheatsheet-coverage/sheet'; const blank = await request('GET', url); expect(blank.body).toEqual({ generation: 0, revision: 0, regions: {} });
    const batch = { generation: 0, writer: 'a'.repeat(32), sequence: 1, createdAt: Date.now(), events: { p2: { ...emptyCoverageSignals(), selection: 1, dwellMs: 1000 } } };
    const first = await request('POST', url, batch); expect(first.status).toBe(200); expect(first.body.snapshot.regions.p2).toMatchObject({ selection: 1, dwellMs: 1000 });
    expect((await request('POST', url, batch)).body.applied).toBe(false);
    expect((await request('POST', url, { ...batch, writer: 'b'.repeat(32), events: { p2: { ...emptyCoverageSignals(), copy: 1 } } })).body.snapshot.regions.p2).toMatchObject({ selection: 1, copy: 1 });
    expect((await request('DELETE', url)).status).toBe(428); expect((await request('DELETE', url, undefined, { 'if-match': '"1"' })).status).toBe(409);
    const reset = await request('DELETE', url, undefined, { 'if-match': '"2"' }); expect(reset.body).toEqual({ generation: 1, revision: 3, regions: {} });
    expect((await request('POST', url, { ...batch, sequence: 2 })).status).toBe(409);
    expect((await request('POST', url, { ...batch, generation: 1, sequence: 1 })).status).toBe(200);
    for (const bad of [{ ...batch, writer: 'bad' }, { ...batch, events: { '../x': emptyCoverageSignals() } }, { ...batch, events: { p2: { ...emptyCoverageSignals(), selection: -1 } } }, { ...batch, events: { p2: { ...emptyCoverageSignals(), other: 1 } } }]) expect((await request('POST', url, bad)).status).toBe(400);
    expect((await request('GET', '/api/cheatsheet-coverage/missing')).status).toBe(404);
  });
  it('bounds writers without evicting replay protection and rate limits each writer', () => {
    const course = 'bounded-fixture'; const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const batch = (n: number, sequence = 1, signal = 1) => ({ generation: 0, writer: n.toString(16).padStart(32, '0'), sequence, createdAt: Date.now(), events: { p2: { ...emptyCoverageSignals(), selection: signal } } });
    try {
      expect(() => addCheatsheetCoverage(course, batch(0, 1, 0))).toThrow('Empty coverage batch');
      for (let n = 0; n < 64; n++) expect(addCheatsheetCoverage(course, batch(n))?.applied).toBe(true);
      expect(() => addCheatsheetCoverage(course, batch(64))).toThrow('Coverage writer limit reached');
      expect(addCheatsheetCoverage(course, batch(0))?.applied).toBe(false);
      for (let sequence = 2; sequence <= 59; sequence++) expect(addCheatsheetCoverage(course, batch(0, sequence))?.applied).toBe(true);
      expect(() => addCheatsheetCoverage(course, batch(0, 60))).toThrow('Coverage writer rate limit exceeded');
      expect(() => addCheatsheetCoverage(course, batch(0, 59))).toThrow('Coverage writer rate limit exceeded');
      now.mockReturnValue(1_060_001); expect(addCheatsheetCoverage(course, batch(0, 60))?.applied).toBe(true);
      expect((stateDb().prepare('SELECT COUNT(*) AS count FROM cheatsheet_coverage_writers WHERE course_id = ?').get(course) as { count: number }).count).toBe(64);
      const oldReplay = { ...batch(1), createdAt: 1_000_000 }; now.mockReturnValue(1_000_000 + 14 * 24 * 60 * 60 * 1000 + 1);
      // The more recently active writer survives; the oldest inactive one is evicted.
      expect(addCheatsheetCoverage(course, batch(64))?.applied).toBe(true);
      expect((stateDb().prepare('SELECT writer FROM cheatsheet_coverage_writers WHERE course_id = ? AND writer = ?').get(course, batch(0).writer))).toBeTruthy();
      expect((stateDb().prepare('SELECT writer FROM cheatsheet_coverage_writers WHERE course_id = ? AND writer = ?').get(course, batch(1).writer))).toBeUndefined();
      expect(() => addCheatsheetCoverage(course, oldReplay)).toThrow('Coverage writer expired');
      const current = getCheatsheetCoverage(course); expect(resetCheatsheetCoverage(course, current.revision)?.generation).toBe(1);
      expect(addCheatsheetCoverage(course, { ...batch(64), generation: 1 })?.applied).toBe(true);
    } finally { now.mockRestore(); }
  });
});
