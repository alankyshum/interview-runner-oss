// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('serves managed source, tests, sandbox runs and pinned AI revisions without a linked course', async () => {
  const state = await mkdtemp(join(tmpdir(), 'api-db-workspaces-')); const previous = { ...process.env };
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; process.env.XDG_STATE_HOME = state; process.env.VITEST = '1';
  await mkdir(join(state, 'interview-runner')); await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
  vi.resetModules();
  let plugin: any;
  try {
    const [{ default: apiPlugin }, { contentDatabase }, { sha256 }] = await Promise.all([import('./apiPlugin'), import('./content/reader'), import('./content/bundle')]);
    const database = await contentDatabase(); const base = 'drills/course/ui/';
    const manifest = { id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [
      { id: 'ui', title: 'Code', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: `${base}source.ts`, testPath: `${base}source.test.ts`, instructions: 'Build.' },
      { id: 'ai', title: 'AI', contentType: 'ai-coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/course/ai/workspace/index.ts', workspacePath: 'drills/course/ai/workspace', acceptancePath: 'drills/course/ai/acceptance', testRunner: 'vitest', handoffPath: 'guides/course/handoff.md', rubricPath: 'guides/course/rubric.md', stageUnlock: { mode: 'manual' }, instructions: '## Milestone 1\nDo it.\n## Milestone 2\nFinish.' },
    ] }] };
    database.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run('course', 'ns', 'course', 'Course', 'now', 'now', 1, JSON.stringify(manifest));
    const publish = (revision: number, test: string) => {
      const contents: Record<string, string> = { [`${base}source.ts`]: 'export const value = "initial";', [`${base}source.test.ts`]: test, [`${base}source.seed.ts`]: 'seed', 'drills/course/ai/workspace/index.ts': `export const version = ${revision}`, 'drills/course/ai/acceptance/accept.test.ts': `acceptance ${revision}`, 'guides/course/handoff.md': 'handoff', 'guides/course/rubric.md': 'rubric' };
      const files: Record<string, { sha256: string; size: number; mode: number }> = {};
      for (const [path, content] of Object.entries(contents)) { const bytes = Buffer.from(content); const hash = sha256(bytes); database.prepare('INSERT OR IGNORE INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now'); files[path] = { sha256: hash, size: bytes.length, mode: 0o644 }; }
      const old = { id: 'old-reading', title: 'Old reading', contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: 'reading/course/old.md', instructions: '## Milestone 1\nReflect.' };
      const historical = revision === 1 ? { ...manifest, chapters: [{ ...manifest.chapters[0], drills: [old, ...manifest.chapters[0].drills] }] } : manifest;
      const hints = { courseId: 'course', drills: { ai: [{ title: 'Milestone 1', approach: 'Start', solution: 'One' }, { title: 'Milestone 2', approach: 'Finish', solution: 'Two' }], ...(revision === 1 ? { 'old-reading': [{ title: 'Milestone 1', approach: 'Reflect', solution: 'Answer' }] } : {}) } };
      database.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run('course', revision, JSON.stringify({ manifest: historical, files, hints }), 'now');
      database.prepare('UPDATE course SET revision=? WHERE id=?').run(revision, 'course'); database.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    };
    publish(1, 'test one'); const records = new Map<string, any>(); const create = vi.fn(async (spec: any) => { const record = { ...spec, workspace: '/workspace', status: 'running', target: 'http://localhost', acceptance: '/opt/ir/acceptance' }; records.set(spec.id, record); return record; });
    const captured = `IR_RESULT ${JSON.stringify({ commitSha: 'a'.repeat(40), workspaceFiles: { files: [{ path: 'source.ts', content: 'edited', size: 6, mode: 0o644 }], totalBytes: 6 }, results: [{ status: 'passed', diagnostics: [], tests: [{ name: 'works', status: 'passed' }] }] })}\n`;
    const manager = { start: async () => {}, close: () => {}, all: () => [...records.values()], get: (id: string) => records.get(id), create, isRunning: async () => true, remove: async (id: string) => { records.delete(id); }, removeWorkspace: async () => {}, exec: vi.fn(async () => ({ exitCode: 0, output: captured })) };
    let missingTest = true; const sourceReader = vi.fn(async (path: string) => { if (missingTest && path.includes('/materialized/') && path.endsWith('source.test.ts')) { missingTest = false; throw Object.assign(new Error('revision temporarily unavailable'), { code: 'ENOENT' }); } return readFile(path, 'utf8'); });
    let middleware: any; plugin = apiPlugin({ sandboxManager: manager as any, allowCodingRequest: () => true, allowStreamRequest: () => true, sourceReader });
    plugin.configureServer({ middlewares: { use: (fn: any) => { middleware = fn; } } } as any);
    const request = async (url: string, method = 'GET', body?: unknown) => { let payload = ''; const response = { statusCode: 0, setHeader: () => {}, end: (value: string) => { payload = value; } }; const encoded = body === undefined ? '' : JSON.stringify(body); await middleware({ url, method, socket: { remoteAddress: '127.0.0.1' }, headers: body === undefined ? {} : { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (encoded) yield encoded; } }, response, () => {}); return { status: response.statusCode, payload, json: () => JSON.parse(payload) }; };
    const source = await request('/api/drills/course/ui/source'); expect(source.status, source.payload).toBe(200); expect(source.json().content).toContain('initial');
    expect((await request('/api/drills/course/ui/tests')).json().files[0].content).toBe('test one');
    expect(sourceReader.mock.calls.filter(([path]) => path.endsWith('source.test.ts'))).toHaveLength(2);
    await rm(join(state, 'interview-runner/managed/materialized/course/1', base, 'source.test.ts'));
    expect((await request('/api/drills/course/ui/tests')).json().files[0].content).toBe('test one');
    const coding = await request('/api/sandboxes', 'POST', { courseId: 'course', drillId: 'ui' }); expect(coding.status).toBe(201); const id = coding.json().id;
    const workspace = join(state, 'interview-runner/managed/workspaces/course/ui'); await writeFile(join(workspace, 'source.ts'), 'learner changes'); await rm(join(workspace, 'source.test.ts')); await writeFile(join(workspace, 'source.test.ts'), 'tampered');
    expect((await request(`/api/sandboxes/${id}/run`, 'POST', {})).status).toBe(200); expect(await readFile(join(workspace, 'source.test.ts'), 'utf8')).toBe('test one'); expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('learner changes');
    const resultPath = join(state, 'interview-runner/managed/materialized/course/1', base, 'source.test.ts');
    const { upsertTestFile } = await import('./db'); const recorded = new Date(Date.now() + 60_000); const changed = new Date(recorded.getTime() + 60_000);
    upsertTestFile(resultPath, 'passed', [{ name: 'first', status: 'passed' }], recorded.toISOString());
    expect((await request('/api/test-results')).json().files[`${base}source.test.ts`]).toMatchObject({ status: 'passed' });
    expect((await request('/api/test-results')).json().files[`${base}source.test.ts`]).toMatchObject({ status: 'passed' });
    upsertTestFile(resultPath, 'failed', [{ name: 'second', status: 'failed' }], new Date(recorded.getTime() + 1000).toISOString());
    expect((await request('/api/test-results')).json().files[`${base}source.test.ts`]).toMatchObject({ status: 'failed' });
    await utimes(join(workspace, 'source.ts'), changed, changed);
    expect((await request('/api/test-results')).json().files[`${base}source.test.ts`]).toMatchObject({ stale: true, staleReason: 'drill-changed' });
    await utimes(join(workspace, 'source.ts'), new Date(), new Date());
    expect((await request('/api/attempts/course/ai', 'POST', { action: 'start' })).json().attempts[0].contentRevision).toBe(1);
    publish(2, 'test two'); expect((await request('/api/test-results')).json().files[`${base}source.test.ts`]).toMatchObject({ stale: true, staleReason: 'drill-changed' }); expect((await request(`/api/sandboxes/${id}/run`, 'POST', {})).status).toBe(200); expect(create.mock.calls.at(-1)?.[0].contentRevision).toBe(2); expect(await readFile(join(workspace, 'source.test.ts'), 'utf8')).toBe('test two');
    const course = await request('/api/courses/course'); expect(course.status, course.payload).toBe(200); expect(course.json().chapters[0].drills.map((drill: any) => drill.id)).toEqual(['ui', 'ai']);
    const hints = await request('/api/course-hints/course'); expect(hints.status, hints.payload).toBe(200); expect(hints.json().drills.ai[0].approach).toBe('Start'); expect(hints.json().drills['old-reading']).toBeUndefined();
    expect((await request(`/api/sandboxes/${id}/submit`, 'POST', {})).status).toBe(200);
    const ai = await request('/api/sandboxes', 'POST', { courseId: 'course', drillId: 'ai' }); expect(ai.status).toBe(201); expect(create.mock.calls.at(-1)?.[0].contentRevision).toBe(1);
    expect(await readFile(join(state, 'interview-runner/managed/materialized/course/1/drills/course/ai/acceptance/accept.test.ts'), 'utf8')).toBe('acceptance 1');
  } finally { plugin?.closeBundle?.(); for (const key of ['INTERVIEW_RUNNER_CONTENT_SOURCE', 'XDG_STATE_HOME', 'VITEST']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } vi.resetModules(); await rm(state, { recursive: true, force: true }); }
});
