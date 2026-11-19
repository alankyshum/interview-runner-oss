// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('keeps an open AI attempt on its original milestones, hints, timer and handoff after republish', async () => {
  const state = await mkdtemp(join(tmpdir(), 'attempt-revision-')); const previous = { ...process.env };
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; process.env.XDG_STATE_HOME = state; process.env.VITEST = '1';
  await mkdir(join(state, 'interview-runner')); await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} })); vi.resetModules();
  let plugin: any;
  try {
    const [{ default: apiPlugin }, { contentDatabase }, { sha256 }, { invalidateCourseCatalog }] = await Promise.all([import('./apiPlugin'), import('./content/reader'), import('./content/bundle'), import('./courses')]);
    const db = await contentDatabase(); const courseId = 'course'; const workspacePath = 'drills/course/ai/workspace';
    const manifest = (count: number) => ({ id: courseId, title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'ai', title: 'Exercise', contentType: 'ai-coding', kind: 'logic', estMinutes: 10, sourcePath: `${workspacePath}/index.ts`, workspacePath, acceptancePath: 'drills/course/ai/acceptance', testRunner: 'vitest', handoffPath: 'guides/course/handoff.md', rubricPath: 'guides/course/rubric.md', stageUnlock: count === 3 ? { mode: 'timer', minutes: [5, 8] } : { mode: 'timer', minutes: [0.001] }, instructions: Array.from({ length: count }, (_, i) => `## Milestone ${i + 1}\nRequirement ${i + 1}`).join('\n') }] }] });
    const publish = (revision: number, count: number, removeDrill = false) => {
      const current = manifest(count); if (removeDrill) current.chapters[0].drills = [{ id: 'other', title: 'Other', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: 'drills/course/other/source.ts', testPath: 'drills/course/other/source.test.ts', instructions: 'Implement it.' } as any]; const files: Record<string, { sha256: string; size: number; mode: number }> = {};
      const values = { [`${workspacePath}/index.ts`]: 'export const value = 1;', 'drills/course/ai/acceptance/stage-1.test.ts': 'acceptance', 'guides/course/handoff.md': `handoff ${revision}: {{rubric}}`, 'guides/course/rubric.md': `rubric ${revision}` };
      for (const [path, content] of Object.entries(values)) { const bytes = Buffer.from(content); const hash = sha256(bytes); db.prepare('INSERT OR IGNORE INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now'); files[path] = { sha256: hash, size: bytes.length, mode: 0o644 }; }
      const hints = removeDrill ? undefined : { courseId, drills: { ai: Array.from({ length: count }, (_, i) => ({ title: `Milestone ${i + 1}`, approach: `approach ${revision}-${i + 1}`, solution: `solution ${revision}-${i + 1}` })) } };
      if (revision === 1) db.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run(courseId, 'ns', 'course', 'Course', 'now', 'now', revision, JSON.stringify(current));
      else db.prepare('UPDATE course SET revision=?,manifest_json=? WHERE id=?').run(revision, JSON.stringify(current), courseId);
      db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run(courseId, revision, JSON.stringify({ manifest: current, files, hints }), 'now'); db.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); invalidateCourseCatalog();
    };
    publish(1, 3); const records = new Map<string, any>(); const commitSha = 'a'.repeat(40);
    const files = { files: [], totalBytes: 0 }; const passed = { status: 'passed', diagnostics: [], tests: [{ name: 'works', status: 'passed' }] };
    const manager = { start: async () => {}, close: () => {}, all: () => [...records.values()], get: (id: string) => records.get(id), isRunning: async () => true, create: async (spec: any) => { const record = { ...spec, workspace: '/workspace', acceptance: '/opt/ir/acceptance', target: 'http://localhost', status: 'running' }; records.set(spec.id, record); return record; }, remove: async (id: string) => { records.delete(id); }, removeWorkspace: async () => {}, exec: async (_id: string, input: any) => ({ exitCode: 0, output: `IR_RESULT ${JSON.stringify(input.action === 'stage-commit' ? { commitSha } : input.action === 'commit-files' ? { commitSha, ...files } : { commitSha, workspaceFiles: files, results: [passed, passed] })}\n` }) };
    let middleware: any; plugin = apiPlugin({ sandboxManager: manager as any, allowCodingRequest: () => true }); plugin.configureServer({ middlewares: { use: (fn: any) => { middleware = fn; } } } as any);
    const request = async (url: string, method = 'GET', body?: unknown) => { let payload = ''; const response = { statusCode: 0, setHeader: () => {}, end: (value: string) => { payload = value; } }; const encoded = body === undefined ? '' : JSON.stringify(body); await middleware({ url, method, socket: { remoteAddress: '127.0.0.1' }, headers: body === undefined ? {} : { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (encoded) yield encoded; } }, response, () => {}); return { status: response.statusCode, payload, json: () => JSON.parse(payload) }; };
    expect((await request('/api/attempts/course/ai', 'POST', { action: 'start' })).json().attempts[0]).toMatchObject({ contentRevision: 1, stageCount: 3 });
    const sandbox = await request('/api/sandboxes', 'POST', { courseId, drillId: 'ai' }); expect(sandbox.status, sandbox.payload).toBe(201); const id = sandbox.json().id;
    publish(2, 2); await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await request('/api/attempts/course')).json().attempts.ai[0]).toMatchObject({ stage: 1, stageCount: 3 });
    expect((await request('/api/attempts/course/ai', 'POST', { action: 'advance', reason: 'timer' })).status).toBe(409);
    const course = (await request('/api/courses/course')).json(); expect(course.chapters[0].drills[0].instructions).toContain('Requirement 1'); expect(course.chapters[0].drills[0].instructions).not.toContain('Requirement 2');
    expect((await request('/api/course-hints/course')).json().drills.ai[0].approach).toBe('approach 1-1');
    expect((await request('/api/progress/course/ai/hints', 'PUT', { hint: 'Milestone 2' })).status).toBe(404);
    const handoff = await request('/api/drills/course/ai/handoff'); expect(handoff.json().prompt).toBe('handoff 1: rubric 1');
    expect((await request('/api/attempts/course/ai', 'POST', { action: 'advance', reason: 'manual' })).json()).toMatchObject({ stage: 2, stageCount: 3 });
    expect((await request('/api/progress/course/ai/hints', 'PUT', { hint: 'Milestone 2' })).json().revealed).toContain('Milestone 2');
    expect((await request('/api/attempts/course/ai', 'POST', { action: 'advance', reason: 'manual' })).json()).toMatchObject({ stage: 3, stageCount: 3 });
    expect((await request('/api/courses/course')).json().chapters[0].drills[0].instructions).toContain('Requirement 3');
    expect((await request('/api/course-hints/course')).json().drills.ai[2].approach).toBe('approach 1-3');
    const submitted = await request(`/api/sandboxes/${id}/submit`, 'POST', {}); expect(submitted.status, submitted.payload).toBe(200);
    const next = await request('/api/attempts/course/ai', 'POST', { action: 'start' }); expect(next.json().attempts.at(-1)).toMatchObject({ contentRevision: 2, stageCount: 2 }); expect(next.json().attempts[0]).toMatchObject({ contentRevision: 1, stageCount: 3 });
    publish(3, 0, true); const retained = (await request('/api/courses/course')).json().chapters.flatMap((chapter: any) => chapter.drills).find((drill: any) => drill.id === 'ai'); expect(retained.instructions).toContain('Requirement 1');
    expect((await request('/api/attempts/course')).json().attempts.ai.at(-1)).toMatchObject({ contentRevision: 2, stageCount: 2 });
    expect((await request('/api/course-hints/course')).json().drills.ai[0].approach).toBe('approach 2-1');
    expect((await request('/api/drills/course/ai/handoff')).json().prompt).toBe('handoff 2: rubric 2');
    expect((await request('/api/progress/course/ai', 'PUT', { status: 'done' })).status).toBe(200);
    expect((await request('/api/attempts/course')).json().attempts.ai.at(-1)).toMatchObject({ contentRevision: 2, completedAt: expect.any(String) });
    expect((await request('/api/progress/course/ai', 'PUT', { status: 'in-progress' })).status).toBe(404);
  } finally { plugin?.closeBundle?.(); for (const key of ['INTERVIEW_RUNNER_CONTENT_SOURCE', 'XDG_STATE_HOME', 'VITEST']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } vi.resetModules(); await rm(state, { recursive: true, force: true }); }
});
