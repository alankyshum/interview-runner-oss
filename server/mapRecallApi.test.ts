// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import apiPlugin from './apiPlugin';
import { courseRepos } from './courseRepos';
import { MAP_FOLD_MAX_NODES } from '../shared/mapFoldState';
import { MAP_HIGHLIGHT_MAX_RECORDS } from '../shared/mapHighlights';

const root = await mkdtemp(join(tmpdir(), 'map-recall-api-'));
const previous = [...courseRepos];
const lesson = (id: string, type: 'map' | 'recall') => ({ id, title: id, contentType: type, kind: 'scratch', estMinutes: 1, sourcePath: `${type === 'map' ? 'mindmaps' : 'recall'}/sample/${id}.${type === 'map' ? 'md' : 'json'}`, instructions: 'Study.' });
const quiz = (id: string) => ({ courseId: 'sample', drillId: id, title: id, questions: [{ id: 'one', prompt: 'Why?', answer: 'Because.' }, { id: 'two', prompt: 'How?', answer: 'Like this.' }] });
beforeAll(async () => {
  for (const dir of ['courses', 'mindmaps/sample', 'mindmaps/other', 'recall/sample']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'courses/sample.json'), JSON.stringify({ type: 'map-recall', id: 'sample', title: 'Sample', company: 'Acme', tier: 2, deadline: '2027-01-15', chapters: [{ id: 'chapter', title: 'Chapter', drills: [lesson('map', 'map'), lesson('first', 'recall')] }, { id: 'chapter-two', title: 'Chapter Two', drills: [lesson('map-two', 'map'), lesson('second', 'recall'), lesson('map-three', 'map')] }] }));
  await writeFile(join(root, 'courses/other.json'), JSON.stringify({ id: 'other', title: 'Other', company: 'Acme', tier: 1, chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'code', title: 'Code', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/other/code.ts', testPath: 'drills/other/code.test.ts', instructions: 'Study.' }, { ...lesson('map', 'map'), sourcePath: 'mindmaps/other/map.md' }] }] }));
  await writeFile(join(root, 'mindmaps/other/map.md'), '# Other map\n');
  await writeFile(join(root, 'mindmaps/sample/map.md'), '# Sample\n');
  await writeFile(join(root, 'mindmaps/sample/map-two.md'), '# Second\n');
  await writeFile(join(root, 'mindmaps/sample/map-three.md'), '# Third\n');
  await writeFile(join(root, 'recall/sample/first.json'), JSON.stringify(quiz('first')));
  await writeFile(join(root, 'recall/sample/second.json'), JSON.stringify(quiz('second')));
  await mkdir(join(root, 'recall/board-course'), { recursive: true });
  await writeFile(join(root, 'courses/board-course.json'), JSON.stringify({ type: 'map-recall', id: 'board-course', title: 'Board', chapters: [{ id: 'chapter', title: 'Chapter', drills: [lesson('map', 'map'), { ...lesson('first', 'recall'), whiteboard: true }, lesson('second', 'recall')].map((drill) => ({ ...drill, sourcePath: drill.sourcePath.replace('/sample/', '/board-course/') })) }] }));
  await writeFile(join(root, 'recall/board-course/first.json'), JSON.stringify({ ...quiz('first'), courseId: 'board-course' }));
  await writeFile(join(root, 'recall/board-course/second.json'), JSON.stringify({ ...quiz('second'), courseId: 'board-course' }));
  await mkdir(join(root, 'recall/standard-board'), { recursive: true });
  await writeFile(join(root, 'courses/standard-board.json'), JSON.stringify({ id: 'standard-board', title: 'Standard', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ ...lesson('first', 'recall'), whiteboard: true, sourcePath: 'recall/standard-board/first.json' }, { ...lesson('new', 'recall'), contentType: 'whiteboard', sourcePath: 'recall/standard-board/new.json' }] }] }));
  await writeFile(join(root, 'recall/standard-board/first.json'), JSON.stringify({ ...quiz('first'), courseId: 'standard-board' }));
  await writeFile(join(root, 'recall/standard-board/new.json'), JSON.stringify({ courseId: 'standard-board', drillId: 'new', title: 'New board', milestones: [{ id: 'one', prompt: 'Design', expectation: 'State the invariant', hint: 'Think', answer: 'Answer' }] }));
  await mkdir(join(root, 'mindmaps/map-board'), { recursive: true }); await mkdir(join(root, 'recall/map-board'), { recursive: true });
  await writeFile(join(root, 'courses/map-board.json'), JSON.stringify({ type: 'map-recall', id: 'map-board', title: 'Map board', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ ...lesson('map', 'map'), sourcePath: 'mindmaps/map-board/map.md' }, { ...lesson('new', 'recall'), contentType: 'whiteboard', sourcePath: 'recall/map-board/new.json' }] }] }));
  await writeFile(join(root, 'mindmaps/map-board/map.md'), '# Map\n');
  await writeFile(join(root, 'recall/map-board/new.json'), JSON.stringify({ courseId: 'map-board', drillId: 'new', title: 'New board', milestones: [{ id: 'one', prompt: 'Design', answer: 'Answer' }] }));
  courseRepos.splice(0, courseRepos.length, { id: 'fixture/courses', name: 'courses', root });
});
afterAll(async () => { courseRepos.splice(0, courseRepos.length, ...previous); await rm(root, { recursive: true, force: true }); });

async function request(method: string, url: string, value?: unknown, remoteStateOrigin?: string, headers: Record<string, string> = {}) {
  let handler: any;
  const plugin = apiPlugin({ remoteStateOrigin });
  (plugin.configureServer as any)({ middlewares: { use: (fn: any) => { handler = fn; } } });
  let output = '';
  const response = { statusCode: 0, setHeader: () => {}, end: (value: string) => { output = value; } };
  const encoded = value === undefined ? '' : JSON.stringify(value);
  await handler({ url, method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (encoded) yield encoded; } }, response, () => {});
  return { status: response.statusCode, body: JSON.parse(output) };
}

describe('map + recall authorized API', () => {
  it('uses the same whiteboard and conditional-save contract in a standard course', async () => {
    const url = '/api/recall-whiteboards/standard-board/first';
    expect((await request('GET', '/api/map-recall/standard-board/first')).body.questions).toHaveLength(2);
    const snapshot = { scene: { elements: [{ id: 'standard' }], appState: {}, files: {} }, svg: '', updatedAt: Date.now() };
    expect((await request('PUT', url, snapshot)).status).toBe(428);
    expect((await request('PUT', url, snapshot, undefined, { 'if-none-match': '*' })).status).toBe(200);
    expect((await request('PUT', url, snapshot, undefined, { 'if-none-match': '*' })).status).toBe(409);
    expect((await request('GET', url)).body).toMatchObject({ snapshot, questions: [{ id: 'one', prompt: 'Why?' }, { id: 'two', prompt: 'How?' }] });
    expect((await request('PUT', '/api/progress/standard-board/first', { status: 'done' })).body).toMatchObject({ status: 'done' });
    expect((await request('GET', url)).body.snapshot).toEqual(snapshot);
  });
  it('serves first-class whiteboard milestones and preserves conditional save and completion', async () => {
    const url = '/api/recall-whiteboards/standard-board/new';
    expect((await request('GET', '/api/map-recall/standard-board/new')).body.questions).toEqual([{ id: 'one', prompt: 'Design', expectation: 'State the invariant', hint: 'Think', answer: 'Answer' }]);
    expect((await request('GET', url)).body).toMatchObject({ questions: [{ id: 'one', prompt: 'Design' }], snapshot: null });
    const snapshot = { scene: { elements: [{ id: 'shape' }], appState: {}, files: {} }, svg: '', updatedAt: Date.now() };
    expect((await request('PUT', url, snapshot)).status).toBe(428);
    expect((await request('PUT', url, snapshot, undefined, { 'if-none-match': '*' })).status).toBe(200);
    expect((await request('PUT', url, snapshot, undefined, { 'if-none-match': '*' })).status).toBe(409);
    expect((await request('PUT', '/api/progress/standard-board/new', { status: 'done' })).body).toMatchObject({ status: 'done' });
    expect((await request('GET', url)).body.snapshot).toEqual(snapshot);
  });
  it('counts first-class whiteboards as one completion in map + recall courses', async () => {
    expect((await request('GET', '/api/recall-progress/map-board')).body.new).toEqual({ checked: 0, total: 1, hasStoredChecks: false });
    expect((await request('PUT', '/api/progress/map-board/new', { status: 'done' })).status).toBe(200);
    expect((await request('GET', '/api/recall-progress/map-board')).body.new).toEqual({ checked: 1, total: 1, hasStoredChecks: false });
    expect((await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'map-board')).toMatchObject({ whiteboardLessonCount: 1, doneDrills: 1, totalDrills: 1 });
  });
  it('stores a single bounded whiteboard only for an opted-in recall drill', async () => {
    const url = '/api/recall-whiteboards/board-course/first';
    const snapshot = { scene: { elements: [{ id: 'shape' }], appState: {}, files: {} }, svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', updatedAt: Date.now() };
    expect((await request('PUT', `${url}/missing`, snapshot)).status).toBe(405);
    expect((await request('PUT', '/api/recall-whiteboards/sample/map/one', snapshot)).status).toBe(404);
    expect((await request('GET', '/api/recall-whiteboards/sample/first')).status).toBe(404);
    const { setRecallWhiteboard, getRecallWhiteboard } = await import('./db');
    setRecallWhiteboard('board-course', 'first', 'one', snapshot);
    expect((await request('GET', url)).body).toMatchObject({ snapshot: null, legacy: [{ id: 'one', snapshot }, { id: 'two', snapshot: null }] });
    for (const invalid of [{ ...snapshot, updatedAt: 0 }, { ...snapshot, svg: '<script></script>' }, { ...snapshot, scene: {} }, { ...snapshot, extra: true }]) expect((await request('PUT', url, invalid)).status).toBe(400);
    expect((await request('PUT', url, snapshot)).status).toBe(428);
    for (const headers of [{ 'if-match': '*' }, { 'if-match': '12' }, { 'if-none-match': 'bad' }, { 'if-match': '"1"', 'if-none-match': '*' }]) expect((await request('PUT', url, snapshot, undefined, headers)).status).toBe(400);
    expect((await request('PUT', url, snapshot, undefined, { 'if-match': '"1"' })).status).toBe(409);
    expect((await request('PUT', url, snapshot, undefined, { 'if-none-match': '*' })).status).toBe(200);
    expect((await request('PUT', url, { ...snapshot, updatedAt: snapshot.updatedAt + 1 }, undefined, { 'if-none-match': '*' })).status).toBe(409);
    expect((await request('PUT', url, { ...snapshot, updatedAt: snapshot.updatedAt - 1 }, undefined, { 'if-match': `"${snapshot.updatedAt}"` })).status).toBe(409);
    const next = { ...snapshot, updatedAt: snapshot.updatedAt + 1 };
    expect((await request('PUT', url, next, undefined, { 'if-match': `"${snapshot.updatedAt}"` })).status).toBe(200);
    expect((await request('PUT', url, { ...next, updatedAt: next.updatedAt + 1 }, undefined, { 'if-match': `"${snapshot.updatedAt}"` })).body).toMatchObject({ snapshot: next });
    const candidates = [{ ...next, updatedAt: next.updatedAt + 1 }, { ...next, updatedAt: next.updatedAt + 2 }];
    const raced = await Promise.all(candidates.map((candidate) => request('PUT', url, candidate, undefined, { 'if-match': `"${next.updatedAt}"` })));
    expect(raced.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = candidates[raced.findIndex((result) => result.status === 200)];
    const result = await request('GET', url);
    expect(result.body).toEqual({ questions: [{ id: 'one', prompt: 'Why?' }, { id: 'two', prompt: 'How?' }], snapshot: winner, legacy: [{ id: 'one', snapshot }, { id: 'two', snapshot: null }] });
    expect(getRecallWhiteboard('board-course', 'first', 'one')).toEqual(snapshot);
    expect(JSON.stringify(result.body)).not.toContain('Because.');
    expect((await request('GET', '/api/recall-progress/board-course')).body.first).toEqual({ checked: 0, total: 1, hasStoredChecks: false });
  });
  it('counts and reverses whiteboard completion through drill progress without changing drawings', async () => {
    const url = '/api/progress/board-course/first'; const boardUrl = '/api/recall-whiteboards/board-course/first';
    const original = (await request('GET', boardUrl)).body;
    const { setProgress } = await import('./db'); setProgress('board-course', 'first', 'not-started', 'Keep these notes');
    for (const status of ['blocked', 'in-progress', 'bogus']) expect((await request('PUT', url, { status })).status).toBe(400);
    expect((await request('PUT', '/api/progress/board-course/second', { status: 'done' })).status).toBe(409);
    expect((await request('PUT', '/api/progress/board-course/map', { status: 'done' })).status).toBe(409);
    expect((await request('PUT', url, { status: 'done' })).body).toMatchObject({ status: 'done', notes: 'Keep these notes' });
    expect((await request('GET', '/api/progress/board-course')).body.first).toMatchObject({ status: 'done', notes: 'Keep these notes' });
    expect((await request('GET', '/api/recall-progress/board-course')).body.first).toEqual({ checked: 1, total: 1, hasStoredChecks: false });
    expect((await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'board-course')).toMatchObject({ whiteboardLessonCount: 1, doneDrills: 1, totalDrills: 3 });
    await request('PUT', '/api/outline-state/board-course/second/one', { checked: true });
    await request('PUT', '/api/outline-state/board-course/second/two', { checked: true });
    expect((await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'board-course')).toMatchObject({ status: 'done', doneDrills: 3, totalDrills: 3 });
    expect((await request('PUT', url, { status: 'not-started' })).body).toMatchObject({ status: 'not-started', notes: 'Keep these notes' });
    expect((await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'board-course')).toMatchObject({ status: 'active', doneDrills: 2, totalDrills: 3 });
    expect((await request('GET', boardUrl)).body).toEqual(original);
  });
  it('validates, persists and clears personal deadline and tier overrides without editing the manifest', async () => {
    const url = '/api/library/items/course/sample/schedule';
    const original = await import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'courses/sample.json'), 'utf8'));
    for (const value of [{ deadline: '2027-02-29', tier: 1 }, { deadline: '2027-01-01T10:00', tier: 1 }, { deadline: 42, tier: 1 }, { deadline: null, tier: 4 }, { deadline: null, tier: '1' }, { deadline: null }, { deadline: null, tier: null, extra: true }, { deadline: '2027-01-01', tier: null, deadlineCleared: true }, { deadline: null, tier: 2, tierCleared: true }, { deadline: null, tier: null, tierCleared: 'true' }]) expect((await request('PUT', url, value)).status).toBe(400);
    expect((await request('PUT', '/api/library/items/course/missing/schedule', { deadline: null, tier: null })).status).toBe(404);
    const saved = await request('PUT', url, { deadline: '2028-02-29T13:45+05:30', tier: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.items.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2028-02-29T13:45+05:30', tier: 1, deadlineOverride: '2028-02-29T13:45+05:30', tierOverride: 1, manifestDeadline: '2027-01-15', manifestTier: 2 });
    expect((await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2028-02-29T13:45+05:30', tier: 1 });
    expect((await request('GET', '/api/courses')).body.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2028-02-29T13:45+05:30', tier: 1 });
    expect((await request('GET', '/api/courses/sample')).body).toMatchObject({ deadline: '2028-02-29T13:45+05:30', tier: 1 });
    expect((await request('PUT', url, { deadline: null, tier: 3 })).body.items.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2027-01-15', tier: 3 });
    expect((await request('PUT', url, { deadline: '2026-11-30', tier: null })).body.items.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2026-11-30', tier: 2 });
    const clearDeadline = (await request('PUT', url, { deadline: null, deadlineCleared: true, tier: 3 })).body.items.find((item: any) => item.id === 'sample');
    expect(clearDeadline).toMatchObject({ deadlineOverride: null, tier: 3 }); expect(clearDeadline).not.toHaveProperty('deadline');
    const clearTier = (await request('PUT', url, { deadline: '2026-11-30', tier: null, tierCleared: true })).body.items.find((item: any) => item.id === 'sample');
    expect(clearTier).toMatchObject({ deadline: '2026-11-30', tierOverride: null }); expect(clearTier).not.toHaveProperty('tier');
    const cleared = (await request('PUT', url, { deadline: null, tier: null, deadlineCleared: true, tierCleared: true })).body.items.find((item: any) => item.id === 'sample');
    expect(cleared).toMatchObject({ deadlineOverride: null, tierOverride: null }); expect(cleared).not.toHaveProperty('deadline'); expect(cleared).not.toHaveProperty('tier');
    for (const result of [(await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'sample'), (await request('GET', '/api/courses')).body.find((item: any) => item.id === 'sample'), (await request('GET', '/api/courses/sample')).body]) { expect(result).not.toHaveProperty('deadline'); expect(result).not.toHaveProperty('tier'); }
    expect((await request('PUT', url, { deadline: null, tier: null })).body.items.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2027-01-15', tier: 2 });
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'courses/sample.json'), 'utf8'))).toBe(original);
  });
  it('uses authoritative schedule values for shared courses and proxies edits to that state', async () => {
    const fetcher = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/courses') return new Response(JSON.stringify([{ id: 'sample', tags: ['Remote'] }]));
      if (path === '/api/courses/sample') return new Response(JSON.stringify({ id: 'sample', tags: ['Remote'] }));
      if (path === '/api/library/items/course/sample/schedule') return new Response(JSON.stringify({ categories: [], items: [], courseRepos: [] }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const origin = 'http://state.test';
      const list = (await request('GET', '/api/courses', undefined, origin)).body;
      const sample = list.find((item: any) => item.id === 'sample'); expect(sample).toMatchObject({ tags: ['Remote'] }); expect(sample).not.toHaveProperty('deadline'); expect(sample).not.toHaveProperty('tier');
      expect(list.find((item: any) => item.id === 'other')).toMatchObject({ tier: 1 });
      const detail = (await request('GET', '/api/courses/sample', undefined, origin)).body; expect(detail).not.toHaveProperty('deadline'); expect(detail).not.toHaveProperty('tier');
      expect((await request('PUT', '/api/library/items/course/sample/schedule', { deadline: null, tier: null, deadlineCleared: true, tierCleared: true }, origin)).status).toBe(200);
      expect(fetcher).toHaveBeenCalledWith(new URL('http://state.test/api/library/items/course/sample/schedule'), expect.objectContaining({ method: 'PUT', body: Buffer.from('{"deadline":null,"tier":null,"deadlineCleared":true,"tierCleared":true}') }));
      expect((await request('GET', '/api/library')).body.items.find((item: any) => item.id === 'sample')).toMatchObject({ deadline: '2027-01-15', tier: 2 });
    } finally { vi.unstubAllGlobals(); }
  });
  it('stores bounded map fold snapshots only for map lessons', async () => {
    const url = '/api/map-fold-state/sample/map';
    expect(await request('GET', url)).toMatchObject({ status: 200, body: { folds: null } });
    const folds = { '1234567890abcdef': true, 'abcdef1234567890': false };
    const writer = 'a'.repeat(32);
    expect(await request('PUT', url, { folds, writer, sequence: 1 })).toMatchObject({ status: 200, body: { applied: true, sequence: 1 } });
    expect((await request('GET', url)).body).toEqual({ folds });
    const secondUrl = '/api/map-fold-state/sample/map-two';
    expect((await request('GET', secondUrl)).body).toEqual({ folds: null });
    expect((await request('PUT', secondUrl, { folds: {}, writer, sequence: 1 })).status).toBe(200);
    expect((await request('GET', secondUrl)).body).toEqual({ folds: {} });
    expect((await request('GET', url)).body).toEqual({ folds });
    const otherMap = join(root, 'courses/other-map.json');
    await writeFile(otherMap, JSON.stringify({ type: 'map-recall', id: 'other-map', title: 'Other map', chapters: [{ id: 'chapter', title: 'Chapter', drills: [lesson('map', 'map'), lesson('first', 'recall')].map((drill) => ({ ...drill, sourcePath: drill.sourcePath.replace('/sample/', '/other-map/') })) }] }));
    try { expect((await request('GET', '/api/map-fold-state/other-map/map')).body).toEqual({ folds: null }); }
    finally { await rm(otherMap); }
    expect((await request('PUT', url, { folds: {}, writer, sequence: 2 })).status).toBe(200);
    expect((await request('GET', url)).body).toEqual({ folds: {} });
    const valid = { folds, writer, sequence: 3 };
    for (const invalid of [{}, { ...valid, folds: [] }, { ...valid, folds: { bad: true } }, { ...valid, folds: { '1234567890abcdef0': true } }, { ...valid, folds: { '1234567890abcdef': 1 } }, { ...valid, extra: true }, { ...valid, writer: 'bad' }, { ...valid, sequence: 0 }, { ...valid, sequence: 1.5 }, { ...valid, folds: Object.fromEntries(Array.from({ length: MAP_FOLD_MAX_NODES + 1 }, (_, i) => [i.toString(16).padStart(16, '0'), true])) }]) expect((await request('PUT', url, invalid)).status).toBe(400);
    for (const path of ['/api/map-fold-state/sample/first', '/api/map-fold-state/sample/missing', '/api/map-fold-state/missing/map', '/api/map-fold-state/other/code']) { expect((await request('GET', path)).status).toBe(404); expect((await request('PUT', path, valid)).status).toBe(404); }
    const largest = { folds: Object.fromEntries(Array.from({ length: MAP_FOLD_MAX_NODES }, (_, i) => [i.toString(16).padStart(16, '0'), false])), writer, sequence: Number.MAX_SAFE_INTEGER };
    expect(Buffer.byteLength(JSON.stringify(largest))).toBeLessThan(65536);
    expect((await request('PUT', url, largest)).status).toBe(200);
  });
  it('stores independent, bounded highlights only on map lessons', async () => {
    const url = '/api/map-highlights/sample/map-two';
    const highlight = { id: 'a'.repeat(32), nodeKey: 'b'.repeat(16), nodeText: 'A quoted note', lineage: ['Root', 'Branch'], quote: 'quoted', prefix: 'A ', suffix: ' note', offset: 2 };
    expect((await request('GET', url)).body).toEqual({ highlights: [] });
    for (const bad of [{ ...highlight, quote: 'missing' }, { ...highlight, prefix: 'wrong' }, { ...highlight, lineage: Array(33).fill('x') }, { ...highlight, offset: -1 }, { ...highlight, captureAmbiguous: 'false' }, { ...highlight, extra: true }, { ...highlight, id: 'bad' }]) expect((await request('PUT', `${url}/${highlight.id}`, bad)).status).toBe(400);
    expect((await request('PUT', `${url}/${highlight.id}`, { ...highlight, nodeText: 'x'.repeat(50000) })).status).toBe(413);
    expect((await request('PUT', `${url}/bad`, highlight)).status).toBe(400);
    expect((await request('PUT', '/api/map-highlights/sample/first/' + highlight.id, highlight)).status).toBe(404);
    expect((await request('PUT', `${url}/${highlight.id}`, highlight)).status).toBe(200);
    expect((await request('PUT', `${url}/${highlight.id}`, highlight)).status).toBe(200);
    expect((await request('PUT', `${url}/${highlight.id}`, { ...highlight, lineage: [] })).status).toBe(409);
    const ambiguous = { ...highlight, id: 'e'.repeat(32), captureAmbiguous: true };
    expect((await request('PUT', `${url}/${ambiguous.id}`, ambiguous)).status).toBe(200);
    expect((await request('GET', url)).body.highlights).toContainEqual(ambiguous);
    expect((await request('DELETE', `${url}/${ambiguous.id}`)).status).toBe(200);
    expect((await request('GET', url)).body).toEqual({ highlights: [highlight] });
    expect((await request('GET', '/api/map-highlights/sample/map')).body).toEqual({ highlights: [] });
    await writeFile(join(root, 'mindmaps/sample/map-two.md'), '# Changed source\n');
    expect((await request('GET', url)).body).toEqual({ highlights: [highlight] });
    await writeFile(join(root, 'mindmaps/sample/map-two.md'), '# Second\n');
    expect((await request('DELETE', `${url}/${highlight.id}`)).status).toBe(200);
    expect((await request('GET', url)).body).toEqual({ highlights: [] });
    expect((await request('PUT', `${url}/${highlight.id}`, highlight)).status).toBe(409);
    const delayed = { ...highlight, id: 'c'.repeat(32) };
    expect((await request('DELETE', `${url}/${delayed.id}`)).status).toBe(200);
    expect(await request('PUT', `${url}/${delayed.id}`, delayed)).toMatchObject({ status: 409, body: { removed: true } });
    expect((await request('GET', url)).body).toEqual({ highlights: [] });
  });
  it('limits active highlights without overwriting existing notes', async () => {
    const url = '/api/map-highlights/sample/map-three';
    const highlight = { id: '', nodeKey: 'b'.repeat(16), nodeText: 'Note', lineage: ['Root'], quote: 'Note', prefix: '', suffix: '', offset: 0 };
    for (let i = 0; i < MAP_HIGHLIGHT_MAX_RECORDS; i++) {
      const id = i.toString(16).padStart(32, '0');
      expect((await request('PUT', `${url}/${id}`, { ...highlight, id })).status).toBe(200);
    }
    const id = MAP_HIGHLIGHT_MAX_RECORDS.toString(16).padStart(32, '0');
    expect((await request('PUT', `${url}/${id}`, { ...highlight, id })).status).toBe(409);
    expect((await request('GET', url)).body.highlights).toHaveLength(MAP_HIGHLIGHT_MAX_RECORDS);
    await request('DELETE', `${url}/${'0'.repeat(32)}`);
    expect((await request('PUT', `${url}/${id}`, { ...highlight, id })).status).toBe(200);
  });
  it('rejects late same-writer snapshots even after a different writer, while accepting different writers in arrival order', async () => {
    const url = '/api/map-fold-state/sample/map'; const a = 'b'.repeat(32); const b = 'c'.repeat(32);
    const newer = { '1111111111111111': true }; const other = { '2222222222222222': false };
    expect((await request('PUT', url, { folds: newer, writer: a, sequence: 2 })).body).toEqual({ applied: true, sequence: 2 });
    expect((await request('PUT', url, { folds: other, writer: b, sequence: 1 })).body).toEqual({ applied: true, sequence: 1 });
    expect((await request('PUT', url, { folds: {}, writer: a, sequence: 1 })).body).toEqual({ applied: false, sequence: 2 });
    expect((await request('GET', url)).body).toEqual({ folds: other });
    expect((await request('PUT', url, { folds: null, writer: a, sequence: 3 })).body).toEqual({ applied: true, sequence: 3 });
    expect((await request('GET', url)).body).toEqual({ folds: null });
  });
  it('serves only declared content and keeps reference state inaccessible', async () => {
    expect(await request('GET', '/api/map-recall/sample/map')).toMatchObject({ status: 200, body: { source: '# Sample\n' } });
    expect(await request('GET', '/api/map-recall/sample/map-two')).toMatchObject({ status: 200, body: { source: '# Second\n' } });
    expect(await request('GET', '/api/map-recall/sample/map-three')).toMatchObject({ status: 200, body: { source: '# Third\n' } });
    expect(await request('GET', '/api/map-recall/sample/first')).toMatchObject({ status: 200, body: { questions: [{ id: 'one' }, { id: 'two' }] } });
    expect((await request('GET', '/api/map-recall/sample/unknown')).status).toBe(404);
    expect((await request('GET', '/api/outline-state/sample/map')).status).toBe(404);
    expect((await request('PUT', '/api/outline-state/sample/map/one', { checked: true })).status).toBe(404);
    expect((await request('PUT', '/api/progress/sample/map', { status: 'done' })).status).toBe(409);
    expect((await request('POST', '/api/progress/sample/reset', {})).status).toBe(409);
  });
  it('serves and saves folds for a declared map in a standard course', async () => {
    expect(await request('GET', '/api/map-recall/other/map')).toMatchObject({ status: 200, body: { source: '# Other map\n' } });
    expect((await request('GET', '/api/map-recall/other/code')).status).toBe(404);
    const folds = { '1234567890abcdef': true };
    expect((await request('PUT', '/api/map-fold-state/other/map', { folds, writer: 'd'.repeat(32), sequence: 1 })).status).toBe(200);
    expect((await request('GET', '/api/map-fold-state/other/map')).body).toEqual({ folds });
    expect((await request('PUT', '/api/progress/other/map', { status: 'done' })).status).toBe(200);
    expect((await request('GET', '/api/progress/other')).body.map.status).toBe('done');
  });
  it('persists, unchecks and resets only one lesson, excluding the map from totals', async () => {
    expect((await request('PUT', '/api/outline-state/sample/first/one', { checked: true })).status).toBe(200);
    expect((await request('GET', '/api/outline-state/sample/first')).body.one.checked).toBe(true);
    expect((await request('PUT', '/api/outline-state/sample/second/two', { checked: true })).status).toBe(200);
    expect((await request('PUT', '/api/outline-state/sample/first/unknown', { checked: true })).status).toBe(404);
    expect((await request('PUT', '/api/outline-state/sample/first/one', { checked: true, folded: false })).status).toBe(400);
    const catalog = await request('GET', '/api/library');
    expect(catalog.body.items.find((item: any) => item.id === 'sample')).toMatchObject({ type: 'map-recall', tier: 2, mapLessonCount: 3, doneDrills: 2, totalDrills: 4, recallLessonCount: 2 });
    expect(catalog.body.items.find((item: any) => item.id === 'other')).toMatchObject({ tier: 1 });
    expect((await request('GET', '/api/courses')).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'sample', tier: 2 }), expect.objectContaining({ id: 'other', tier: 1 })]));
    expect((await request('PUT', '/api/outline-state/sample/first/one', { checked: false })).body.one.checked).toBe(false);
    await request('PUT', '/api/outline-state/sample/first/one', { checked: true });
    expect((await request('PUT', '/api/outline-state/sample/first/bulk', { checked: false })).body.one.checked).toBe(false);
    expect((await request('GET', '/api/outline-state/sample/second')).body.two.checked).toBe(true);
    expect((await request('PUT', '/api/outline-state/sample/first/bulk', { checked: true })).status).toBe(400);
  });
  it('retains the tier if recall progress is unavailable', async () => {
    const file = join(root, 'recall/sample/first.json');
    try {
      await writeFile(file, '{invalid');
      const catalog = await request('GET', '/api/library');
      expect(catalog.body.items.find((item: any) => item.id === 'sample')).toMatchObject({ tier: 2, recallUnavailable: true });
    } finally { await writeFile(file, JSON.stringify(quiz('first'))); }
  });
  it('resets orphaned checks across regeneration without affecting other lessons', async () => {
    const file = join(root, 'recall/sample/first.json');
    const original = quiz('first');
    const removed = { id: 'removed', prompt: 'Removed prompt?', answer: 'Removed answer.' };
    try {
      await writeFile(file, JSON.stringify({ ...original, questions: [...original.questions, removed] }));
      expect((await request('PUT', '/api/outline-state/sample/first/removed', { checked: true })).status).toBe(200);
      await request('PUT', '/api/outline-state/sample/second/one', { checked: true });
      await writeFile(file, JSON.stringify(original));
      expect((await request('GET', '/api/outline-state/sample/first')).body).not.toHaveProperty('removed');
      expect((await request('GET', '/api/recall-progress/sample')).body.first).toMatchObject({ checked: 0, total: 2, hasStoredChecks: true });
      expect((await request('PUT', '/api/outline-state/sample/first/bulk', { checked: false })).status).toBe(200);
      expect((await request('GET', '/api/recall-progress/sample')).body.first.hasStoredChecks).toBe(false);
      await writeFile(file, JSON.stringify({ ...original, questions: [...original.questions, removed] }));
      expect((await request('GET', '/api/outline-state/sample/first')).body.removed.checked).toBe(false);
      expect((await request('GET', '/api/outline-state/sample/second')).body.one.checked).toBe(true);
    } finally { await writeFile(file, JSON.stringify(original)); }
  });
  it('returns checked/total summaries without prompts or answers', async () => {
    const result = await request('GET', '/api/recall-progress/sample');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ first: { checked: expect.any(Number), total: 2 }, second: { checked: expect.any(Number), total: 2 } });
    expect(JSON.stringify(result.body)).not.toMatch(/Because|Like this|prompt|answer/i);
    expect((await request('GET', '/api/recall-progress/missing')).status).toBe(404);
  });
  it('rejects a declared file replaced by a symlink outside the course', async () => {
    const path = join(root, 'mindmaps/sample/map.md');
    await rm(path); await symlink(join(root, 'courses/sample.json'), path);
    expect((await request('GET', '/api/map-recall/sample/map')).status).toBe(400);
    await rm(path); await writeFile(path, '# Sample\n');
  });
});
