// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { watch as fsWatch } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import apiPlugin, { cleanupStaleAttemptWorkspaces, isExactWebSocketOrigin, isTrustedLocalAddress, workspaceMarkdown } from "./apiPlugin";
import { consoleFramePrefix } from "./consoleReporter";
import { SandboxManager } from "./sandboxClient";
import { courseRepos } from "./courseRepos";
import { completeDrillAttempt, db, ensureProgressSchema, ensureSubmissionSchema, getAllTestFiles, recordAttemptStage, startDrillAttempt, upsertTestFile } from "./db";
import viteConfig from "../vite.config";

vi.mock('../shared/legacyReading', async (original) => { const actual = await original<typeof import('../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'hooli-growth-loop' && drill === 'signal-hub-deep-dive' }; });

const linkedCoursesRoot = await mkdtemp(join(tmpdir(), "api-plugin-courses-"));
const commitSha = 'a'.repeat(40);
const commitOutput = `IR_RESULT ${JSON.stringify({ commitSha })}\n`;
const fixtureDrill = (course: string, id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, contentType: "coding", kind: "logic", estMinutes: 1, sourcePath: `drills/${course}/${id}/${id}.ts`, testPath: `drills/${course}/${id}/${id}.test.ts`, instructions: "Implement the fixture.", ...extra });
const manifests = [
  { id: "hooli-growth-loop", title: "Fixture", chapters: [{ id: "fixture", title: "Fixture", drills: [
    fixtureDrill("hooli-growth-loop", "signal-hub-deep-dive", { contentType: "reading", kind: "scratch", testPath: undefined, sourcePath: "reading/hooli-growth-loop/signal-hub-deep-dive.md", outlinePath: "outlines/hooli-growth-loop/signal-hub-deep-dive.json" }),
    fixtureDrill("hooli-growth-loop", "token-sse-partials"),
  ] }] },
  { id: "coding-interview-patterns", title: "Fixture", chapters: [{ id: "two-pointers", title: "Fixture", drills: [
    fixtureDrill("coding-interview-patterns", "two-sum"), fixtureDrill("coding-interview-patterns", "valid-palindrome"), fixtureDrill("coding-interview-patterns", "binary-tree-level-order"),
  ] }] },
  { id: "initech-practical-coding-no-ai", title: "Fixture", chapters: [{ id: "practical-coding", title: "Fixture", drills: [
    fixtureDrill("initech-practical-coding-no-ai", "per-item-sliding-window", { instructions: "## Milestone 1 — clarify and one item (5 + 15 minutes)\nImplement it." }),
    fixtureDrill("initech-practical-coding-no-ai", "retry-scheduler"), fixtureDrill("initech-practical-coding-no-ai", "transaction-reconciliation"),
  ] }] },
  { id: "example-course", title: "Fixture", chapters: [{ id: "fixture", title: "Fixture", drills: [fixtureDrill("example-course", "hello-logic")] }] },
  { id: "ai-course", title: "AI Fixture", chapters: [{ id: "fixture", title: "Fixture", drills: [fixtureDrill("ai-course", "pair", { contentType: "ai-coding", testPath: undefined, workspacePath: "drills/ai-course/pair/workspace", sourcePath: "drills/ai-course/pair/workspace/src/pair.ts", testRunner: "vitest", handoffPath: "drills/ai-course/pair/handoff.md", rubricPath: "drills/ai-course/pair/rubric.md", acceptancePath: "drills/ai-course/pair/acceptance", stageUnlock: { mode: "timer", minutes: [0.001] }, instructions: "## Milestone 1\nStart.\n## Milestone 2\nChange." })] }] },
];
await mkdir(join(linkedCoursesRoot, "courses"), { recursive: true });
for (const manifest of manifests) {
  await writeFile(join(linkedCoursesRoot, "courses", `${manifest.id}.json`), JSON.stringify(manifest));
  for (const drill of manifest.chapters.flatMap((chapter) => chapter.drills)) {
    await mkdir(dirname(join(linkedCoursesRoot, drill.sourcePath)), { recursive: true });
    await writeFile(join(linkedCoursesRoot, drill.sourcePath), "export const fixture = true;\n");
    if (typeof drill.testPath === "string") await writeFile(join(linkedCoursesRoot, drill.testPath), "import { describe, it } from 'vitest'; describe('fixture', () => { it('runs', () => {}); });\n");
  }
}
await mkdir(join(linkedCoursesRoot, "drills/ai-course/pair/acceptance"), { recursive: true });
await writeFile(join(linkedCoursesRoot, "drills/ai-course/pair/handoff.md"), "Pair {{drillTitle}} stage {{stage}}/{{stageCount}}\n{{fileTree}}\n{{rubric}}\n");
await writeFile(join(linkedCoursesRoot, "drills/ai-course/pair/rubric.md"), "Score correctness without revealing future requirements.");
await writeFile(join(linkedCoursesRoot, "courses/initech-practical-coding-no-ai.hints.json"), JSON.stringify({ courseId: "initech-practical-coding-no-ai", drills: { "per-item-sliding-window": [{ title: "Milestone 1 — clarify and one item (5 + 15 minutes)", approach: "fixture", solution: "fixture" }] } }));
await writeFile(join(linkedCoursesRoot, "courses/ai-course.hints.json"), JSON.stringify({ courseId: "ai-course", drills: { pair: [{ title: "Milestone 1", approach: "stage one approach", solution: "stage one solution" }, { title: "Milestone 2", approach: "LOCKED APPROACH", solution: "LOCKED SOLUTION" }] } }));
courseRepos.splice(0, courseRepos.length, { id: "fixture/courses", name: "courses", root: linkedCoursesRoot });
afterAll(async () => { await rm(linkedCoursesRoot, { recursive: true, force: true }); });

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })) };
});

type Middleware = (request: any, response: any, next: () => void) => Promise<void>;

function captureMiddleware(options: Parameters<typeof apiPlugin>[0]): Middleware {
  let middleware: Middleware | undefined;
  if (options?.sandboxManager && !('isRunning' in options.sandboxManager)) Object.assign(options.sandboxManager, { isRunning: vi.fn(async () => true) });
  // These tests exercise HTTP behavior, not the repository's live file graph.
  // Keep the default seam inert so a save made by another test cannot start a
  // nested Vitest process (or leave a real watcher behind).
  const fakeWatcher = vi.fn((_path: string, _options: object, _callback: (...args: any[]) => void) => ({ close: vi.fn(), on: vi.fn() } as any));
  const fakeRunner = vi.fn(async () => {});
  const plugin = apiPlugin({
    reportFile: join(tmpdir(), "interview-runner-test-report-does-not-exist.json"),
    watcherFactory: fakeWatcher,
    runner: fakeRunner,
    ...options,
  });
  const configure = plugin.configureServer as unknown as (server: { middlewares: { use: (handler: Middleware) => void } }) => void;
  configure({ middlewares: { use: (handler) => { middleware = handler; } } });
  if (!middleware) throw new Error("API middleware was not registered");
  cleanups.push(() => plugin.closeBundle?.());
  return middleware;
}

const cleanups: Array<() => void> = [];
beforeEach(() => { db.prepare("DELETE FROM test_results").run(); db.prepare("DELETE FROM revealed_hints").run(); db.prepare("DELETE FROM submissions").run(); db.prepare("DELETE FROM progress").run(); db.prepare("DELETE FROM attempt_stages").run(); db.prepare("DELETE FROM drill_attempts").run(); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function emit(watched: Map<string, (...args: any[]) => void>, filePath: string) {
  watched.get(dirname(filePath))?.("change", basename(filePath));
}

async function request(middleware: Middleware, url: string, remoteAddress = "127.0.0.1", method = "POST", json?: unknown, headers: Record<string, string> = {}) {
  let payload = "";
  const response = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: (value: string) => { payload = value; },
  };
  const encoded = json === undefined ? "" : JSON.stringify(json);
  const incoming = {
    url, method, socket: { remoteAddress }, headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers },
    async *[Symbol.asyncIterator]() { if (encoded) yield encoded; },
  };
  await middleware(incoming, response, vi.fn());
  return { status: response.statusCode, body: JSON.parse(payload) as Record<string, unknown> };
}

it("does not expose the removed evaluation endpoint", async () => {
  expect(await request(captureMiddleware({}), "/api/evaluations/hooli-growth-loop/signal-hub-deep-dive")).toMatchObject({ status: 404 });
});

it("continues to reject test-result streaming from untrusted addresses", async () => {
  expect(await request(captureMiddleware({}), "/api/test-results/stream", "192.0.2.5", "GET")).toMatchObject({ status: 403 });
});

describe("/api/sandboxes", () => {
  it('survives an unavailable daemon and retries initialization once for concurrent sandbox requests', async () => {
    let resolveStart!: () => void;
    const pending = new Promise<void>((resolve) => { resolveStart = resolve; });
    const start = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce(new Error('ECONNREFUSED')).mockReturnValueOnce(pending);
    const manager = { start, close: vi.fn(), all: vi.fn(() => []), get: vi.fn(), removeWorkspace: vi.fn() };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const httpServer = new EventEmitter(); const middlewares: Middleware[] = [];
    const plugin = apiPlugin({ sandboxManager: manager as any, allowCodingRequest: () => true });
    plugin.configureServer({ httpServer: httpServer as any, middlewares: { use: (handler: Middleware) => middlewares.push(handler) } as any });
    cleanups.push(() => plugin.closeBundle?.());
    try {
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Sandbox initialization failed', expect.any(Error)));
      const api = middlewares.at(-1)!;
      expect((await request(api, '/api/courses', '127.0.0.1', 'GET')).status).toBe(200);
      expect((await request(api, '/api/sandboxes/missing-id', '127.0.0.1', 'GET')).status).toBe(503);
      const calls = [request(api, '/api/sandboxes/missing-id', '127.0.0.1', 'GET'), request(api, '/api/sandboxes/missing-id', '127.0.0.1', 'GET')];
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
      resolveStart();
      expect((await Promise.all(calls)).map((item) => item.status)).toEqual([404, 404]);
      expect(start).toHaveBeenCalledTimes(3);
      expect((await request(api, '/api/sandboxes/missing-id', '127.0.0.1', 'GET')).status).toBe(404);
      expect(start).toHaveBeenCalledTimes(3);
    } finally { resolveStart(); plugin.closeBundle?.(); log.mockRestore(); }
  });

  it('keeps the manager started if the first workspace cleanup fails', async () => {
    const start = vi.fn(async () => {}); const all = vi.fn().mockImplementationOnce(() => { throw new Error('cleanup failed'); }).mockReturnValue([]);
    const manager = { start, close: vi.fn(), all, get: vi.fn(), removeWorkspace: vi.fn() };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const httpServer = new EventEmitter(); const middlewares: Middleware[] = [];
    const plugin = apiPlugin({ sandboxManager: manager as any, allowCodingRequest: () => true, workspaceCleanupIntervalMs: 20 });
    plugin.configureServer({ httpServer: httpServer as any, middlewares: { use: (handler: Middleware) => middlewares.push(handler) } as any });
    cleanups.push(() => plugin.closeBundle?.());
    try {
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Workspace cleanup failed', expect.any(Error)));
      const api = middlewares.at(-1)!;
      expect((await request(api, '/api/sandboxes/missing-id', '127.0.0.1', 'GET')).status).toBe(404);
      await vi.waitFor(() => expect(all.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(start).toHaveBeenCalledOnce();
    } finally { plugin.closeBundle?.(); log.mockRestore(); }
  });

  it('does not start an AI attempt without reconciling its existing sandbox', async () => {
    const manager = { start: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), close: vi.fn(), all: vi.fn(() => []) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const httpServer = new EventEmitter(); const middlewares: Middleware[] = [];
    const plugin = apiPlugin({ sandboxManager: manager as any, allowCodingRequest: () => false });
    plugin.configureServer({ httpServer: httpServer as any, middlewares: { use: (handler: Middleware) => middlewares.push(handler) } as any });
    try {
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Sandbox initialization failed', expect.any(Error)));
      const api = middlewares.at(-1)!;
      expect((await request(api, '/api/sandboxes/missing-id', '192.0.2.1', 'GET')).status).toBe(403);
      expect(manager.start).toHaveBeenCalledOnce();
      expect((await request(api, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' })).status).toBe(503);
      expect(db.prepare('SELECT COUNT(*) AS count FROM drill_attempts').get()).toEqual({ count: 0 });
    } finally { plugin.closeBundle?.(); log.mockRestore(); }
  });

  it('closes a manager whose initialization finishes after server shutdown', async () => {
    let resolveStart!: () => void;
    const pending = new Promise<void>((resolve) => { resolveStart = resolve; });
    const manager = { start: vi.fn(() => pending), close: vi.fn(), all: vi.fn(() => []) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const httpServer = new EventEmitter(); const plugin = apiPlugin({ sandboxManager: manager as any });
    plugin.configureServer({ httpServer: httpServer as any, middlewares: { use: () => {} } as any });
    try {
      await vi.waitFor(() => expect(manager.start).toHaveBeenCalledOnce());
      httpServer.emit('close'); resolveStart();
      await vi.waitFor(() => expect(manager.close).toHaveBeenCalledTimes(2));
      expect(manager.all).not.toHaveBeenCalled();
    } finally { resolveStart(); plugin.closeBundle?.(); log.mockRestore(); }
  });

  it.each(['coding', 'ai-coding'] as const)('reports missing Git for %s run and submit without storing a submission', async (kind) => {
    const record = kind === 'coding'
      ? { id: 'missing-git', courseId: 'example-course', drillId: 'hello-logic', kind, status: 'running', workspace: '/workspace' }
      : { id: 'missing-git', courseId: 'ai-course', drillId: 'pair', kind, status: 'running', workspace: '/workspace', acceptance: '/opt/ir/acceptance', attemptNumber: 1 };
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [record], get: () => record, exec: vi.fn(async () => ({ exitCode: 1, output: 'Error: IR_GIT_UNAVAILABLE: Git is required for workspace commits\n' })) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    if (kind === 'ai-coding') { const attempt = startDrillAttempt('ai-course', 'pair').at(-1)!; recordAttemptStage('ai-course', 'pair', attempt.attemptNumber, 2, 'manual'); }
    for (const action of ['run', 'submit']) expect(await request(middleware, `/api/sandboxes/missing-git/${action}`)).toEqual({ status: 502, body: { error: 'Git is unavailable; workspace commits are required to run tests or submit' } });
    expect(db.prepare('SELECT COUNT(*) AS count FROM submissions').get()).toEqual({ count: 0 });
  });
  it('forwards the browser time zone to the authoritative course lookup', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'ai-course', tags: [] })));
    vi.stubGlobal('fetch', fetcher);
    try {
      const middleware = captureMiddleware({ remoteStateOrigin: 'http://state.test' });
      const response = await request(middleware, '/api/courses/ai-course', '127.0.0.1', 'GET', undefined, { 'x-interview-time-zone': 'Asia/Kolkata' });
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledWith(new URL('http://state.test/api/courses/ai-course'), { headers: { 'x-interview-time-zone': 'Asia/Kolkata' } });
    } finally { vi.unstubAllGlobals(); }
  });
  it('loads a course with a due timer when its cached sandbox has stopped, without advancing or deleting the workspace', async () => {
    const record = { id: 'stale-sandbox', courseId: 'ai-course', drillId: 'pair', kind: 'ai-coding', status: 'running', target: 'http://sandbox', workspace: '/workspace', attemptNumber: 1, lastSeen: Date.now() } as const;
    let running = true; const exec = vi.fn(); const remove = vi.fn(); const removeWorkspace = vi.fn();
    const driver = { list: vi.fn(async () => [{ ...record, status: running ? 'running' : 'stopped' }]), exec, remove, removeWorkspace, create: vi.fn() };
    const manager = new SandboxManager(driver as any); await manager.start();
    const middleware = captureMiddleware({ sandboxManager: manager, allowCodingRequest: () => true });
    startDrillAttempt('ai-course', 'pair');
    db.prepare("UPDATE drill_attempts SET active_since = ? WHERE course_id='ai-course' AND drill_id='pair'").run(new Date(Date.now() - 1000).toISOString()); running = false;
    const response = await request(middleware, '/api/courses/ai-course', '127.0.0.1', 'GET');
    expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toContain('Change.'); expect(manager.get(record.id)?.status).toBe('stopped');
    expect(exec).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(removeWorkspace).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM attempt_stages WHERE course_id='ai-course' AND drill_id='pair' AND stage>1").get()).toEqual({ count: 0 });
  });
  it('creates a replacement rather than reusing a stopped cached AI sandbox', async () => {
    const record = { id: 'stale-sandbox', courseId: 'ai-course', drillId: 'pair', kind: 'ai-coding', status: 'running', target: 'http://sandbox', workspace: '/workspace', attemptNumber: 1, lastSeen: Date.now() } as const;
    let running = true; const removeWorkspace = vi.fn(); const create = vi.fn(async (spec: any) => ({ ...spec, status: 'running', target: 'http://new', workspace: '/new-workspace', lastSeen: Date.now() }));
    const manager = new SandboxManager({ list: async () => [{ ...record, status: running ? 'running' : 'stopped' }], create, remove: vi.fn(), removeWorkspace, exec: vi.fn() } as any); await manager.start();
    const middleware = captureMiddleware({ sandboxManager: manager, allowCodingRequest: () => true }); startDrillAttempt('ai-course', 'pair'); running = false;
    const response = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' });
    expect(response.status).toBe(201); expect(response.body.id).not.toBe(record.id); expect(create).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 1, kind: 'ai-coding' })); expect(removeWorkspace).not.toHaveBeenCalled();
  });
  it("reports coding test timeouts through the run alias and blocks submission", async () => {
    const record = { id: 'timeout-test', courseId: 'example-course', drillId: 'hello-logic', kind: 'coding', status: 'running', workspace: '/workspace' };
    const timeout = { status: 'error', diagnostics: [], tests: [{ name: 'Test execution error', status: 'failed', message: 'Tests stopped after 15s. Your code may have an infinite loop.' }] };
    const captured = `IR_RESULT ${JSON.stringify({ commitSha, workspaceFiles: { files: [], totalBytes: 0 }, results: [timeout] })}\n`;
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [record], get: () => record, exec: vi.fn(async () => ({ exitCode: 0, output: captured })) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    expect(await request(middleware, '/api/drills/example-course/hello-logic/run')).toMatchObject({ status: 200, body: timeout });
    expect(await request(middleware, '/api/sandboxes/timeout-test/submit')).toMatchObject({ status: 409, body: timeout });
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE course_id='example-course'").get()).toEqual({ count: 0 });
  });
  it.each(['workspace', 'acceptance'])('blocks AI submit on a %s timeout without exposing acceptance details', async (target) => {
    const records = new Map<string, any>(); const workspaceFiles = { files: [{ path: 'src/pair.ts', size: 1, mode: 420, content: 'x' }], totalBytes: 1 };
    const timeout = { status: 'error', diagnostics: [], tests: [{ name: 'Test execution error', status: 'failed', message: 'Tests stopped after 15s. Your code may have an infinite loop.' }] };
    const passed = { status: 'passed', diagnostics: [], tests: [{ name: 'private acceptance name', status: 'passed' }] };
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), removeWorkspace: vi.fn(), remove: vi.fn(), create: vi.fn(async (spec: any) => { const record = { ...spec, status: 'running', workspace: '/workspace', acceptance: '/opt/ir/acceptance' }; records.set(spec.id, record); return record; }), exec: vi.fn(async (_id: string, input: any) => input.action === 'workspace-files' ? { exitCode: 0, output: `IR_RESULT ${JSON.stringify(workspaceFiles)}\n` } : input.action === 'stage-commit' ? { exitCode: 0, output: commitOutput } : { exitCode: 0, output: `IR_RESULT ${JSON.stringify({ commitSha, workspaceFiles, results: target === 'workspace' ? [timeout, passed] : [passed, timeout] })}\n` }) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' });
    const created = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' });
    await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'advance', reason: 'manual' });
    const response = await request(middleware, `/api/sandboxes/${created.body.id}/submit`);
    expect(response).toMatchObject({ status: 409, body: { status: 'error', tests: expect.arrayContaining(timeout.tests) } });
    if (target === 'workspace') expect(JSON.stringify(response.body)).not.toContain('private acceptance name');
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE course_id='ai-course'").get()).toEqual({ count: 0 });
  });
  it("creates ai-coding sandboxes from the declared template and acceptance paths", async () => {
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [], get: vi.fn(), touch: vi.fn(), reap: vi.fn(), remove: vi.fn(), exec: vi.fn(), create: vi.fn(async (spec: any) => ({ ...spec, status: 'running', workspace: '/workspace/pair-1' })) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    expect((await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' })).status).toBe(200);
    const created = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' });
    expect(created).toMatchObject({ status: 201, body: { attemptNumber: 1, stage: 1 } });
    expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ai-coding', workspacePath: 'drills/ai-course/pair/workspace', sourcePath: 'drills/ai-course/pair/workspace/src/pair.ts', acceptancePath: 'drills/ai-course/pair/acceptance', attemptNumber: 1 }), true);
  });
  it("reveals AI requirements only after a stage commit, then gates and stores submit", async () => {
    const records = new Map<string, any>();
    const workspaceFiles = 'IR_RESULT {"files":[{"path":"src/pair.ts","size":1,"mode":420,"content":"x"},{"path":"package-lock.json","size":2,"mode":420,"content":"{}"}],"totalBytes":3}\n';
    const lockedAcceptanceName = 'stage-2.test.ts › transactional rollback milestone';
    const captured = `IR_RESULT {"commitSha":"${commitSha}","workspaceFiles":{"files":[{"path":"src/pair.ts","size":1,"mode":420,"content":"x"},{"path":"package-lock.json","size":2,"mode":420,"content":"{}"}],"totalBytes":3},"results":[{"status":"passed","diagnostics":[],"tests":[{"name":"workspace test","status":"passed"}],"output":{"entries":[{"stream":"stdout","text":"visible log","testName":"workspace test"}]}},{"status":"passed","diagnostics":[],"tests":[{"name":"${lockedAcceptanceName}","status":"passed"}],"output":{"entries":[{"stream":"stdout","text":"secret log","testName":"${lockedAcceptanceName}"}]}}]}\n`;
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), touch: vi.fn(), reap: vi.fn(), removeWorkspace: vi.fn(), remove: vi.fn(async (id: string) => { records.delete(id); }), create: vi.fn(async (spec: any) => { const record = { ...spec, status: 'running', workspace: '/workspace/pair-1', acceptance: '/opt/ir/acceptance' }; records.set(spec.id, record); return record; }), exec: vi.fn(async (_id: string, input: any) => input.action === 'workspace-files' ? { exitCode: 0, output: workspaceFiles } : input.action === 'commit-files' ? { exitCode: 0, output: `IR_RESULT ${JSON.stringify({ commitSha, ...JSON.parse(workspaceFiles.slice('IR_RESULT '.length)) })}\n` } : input.action === 'stage-commit' ? { exitCode: 0, output: commitOutput } : { exitCode: 0, output: captured }) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' });
    const created = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' }); const id = created.body.id as string;
    const locked = await request(middleware, '/api/courses/ai-course', '127.0.0.1', 'GET'); expect(JSON.stringify(locked.body)).not.toContain('Change.');
    const lockedHints = await request(middleware, '/api/course-hints/ai-course', '127.0.0.1', 'GET'); expect(JSON.stringify(lockedHints.body)).not.toContain('LOCKED');
    expect((await request(middleware, '/api/progress/ai-course/pair/hints', '127.0.0.1', 'PUT', { hint: 'Milestone 2' })).status).toBe(404);
    const advanced = await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'advance', reason: 'manual', timeZone: 'Asia/Kolkata' }); expect(advanced).toMatchObject({ status: 200, body: { stage: 2, stageCount: 2 } }); expect(manager.exec).toHaveBeenCalledWith(id, { action: 'stage-commit', stage: 1, timeZone: 'Asia/Kolkata' });
    const handoff = await request(middleware, '/api/drills/ai-course/pair/handoff', '127.0.0.1', 'GET'); expect(handoff.body.prompt).toContain('Score correctness'); expect(handoff.body.prompt).not.toContain('Change.'); expect(handoff.body.commitSha).toBe(commitSha); expect(handoff.body.files).toContainEqual(expect.objectContaining({ path: 'src/pair.ts', content: 'x' })); expect(manager.exec).toHaveBeenCalledWith(id, expect.objectContaining({ action: 'commit-files' }));
    let streamBody = ''; const streamResponse = { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { streamBody += value; return true; }, end: vi.fn(), on: vi.fn() }; await middleware({ url: '/api/test-results/stream', method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, streamResponse, vi.fn());
    const submitted = await request(middleware, `/api/sandboxes/${id}/submit`, '127.0.0.1', 'POST', { timeZone: 'America/Los_Angeles' }); expect(submitted.status).toBe(200); expect(submitted.body.tests).toEqual([{ name: 'workspace test', status: 'passed' }, { name: 'Acceptance: 1/1 passed', status: 'passed' }]); expect(manager.exec).toHaveBeenCalledWith(id, expect.objectContaining({ action: 'capture-run', timeZone: 'America/Los_Angeles', runs: [expect.arrayContaining(['--mode', 'workspace']), expect.arrayContaining(['--mode', 'acceptance', '--acceptance', '/opt/ir/acceptance', '--max-stage', '2'])] })); expect(manager.remove).toHaveBeenCalledWith(id, false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE course_id='ai-course' AND drill_id='pair'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT commit_sha FROM attempt_stages WHERE course_id='ai-course' AND stage=2").get()).toEqual({ commit_sha: commitSha });
    expect(db.prepare("SELECT commit_sha FROM submissions WHERE course_id='ai-course'").get()).toEqual({ commit_sha: commitSha });
    expect(db.prepare("SELECT COUNT(*) AS count FROM draft_timelines WHERE course_id='ai-course'").get()).toEqual({ count: 0 });
    expect(streamBody).toContain('event: test-result'); expect(streamBody).toContain('visible log'); expect(streamBody).toContain('workspace test'); expect(streamBody).not.toContain(lockedAcceptanceName); expect(streamBody).not.toContain('secret log');
    const manifest = JSON.stringify((await request(middleware, '/api/test-results', '127.0.0.1', 'GET')).body); expect(manifest).toContain('workspace test'); expect(manifest).toContain('Acceptance: 1/1 passed'); expect(manifest).not.toContain(lockedAcceptanceName);
    expect(JSON.stringify((await request(middleware, '/api/progress/ai-course/pair/submissions', '127.0.0.1', 'GET')).body)).not.toContain(lockedAcceptanceName);
    await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' });
    const fresh = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' });
    expect(manager.removeWorkspace).not.toHaveBeenCalled(); expect(manager.create).toHaveBeenLastCalledWith(expect.objectContaining({ attemptNumber: 2 }), true);
    let freshStream = ''; await middleware({ url: '/api/test-results/stream', method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { freshStream += value; return true; }, end: vi.fn(), on: vi.fn() }, vi.fn()); expect(freshStream).toContain('event: snapshot'); expect(freshStream).not.toContain(lockedAcceptanceName);
    const freshHandoff = await request(middleware, '/api/drills/ai-course/pair/handoff', '127.0.0.1', 'GET'); expect(JSON.stringify(freshHandoff.body)).not.toContain(lockedAcceptanceName); expect(JSON.stringify(freshHandoff.body)).not.toContain('Change.');
    let exported = ''; await middleware({ url: `/api/sandboxes/${fresh.body.id}/export.md`, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, { statusCode: 0, setHeader: vi.fn(), end: (value: string) => { exported = value; } }, vi.fn()); expect(exported).toContain('## src/pair.ts'); expect(exported).not.toContain(lockedAcceptanceName); expect(manager.exec).toHaveBeenCalledWith(fresh.body.id, { action: 'workspace-files' });
    expect(JSON.stringify((await request(middleware, '/api/progress/ai-course/pair/submissions', '127.0.0.1', 'GET')).body)).not.toContain(lockedAcceptanceName);
  });
  it("rejects AI submit when the captured workspace has no tests even if acceptance passes", async () => {
    const records = new Map<string, any>();
    const workspaceFiles = 'IR_RESULT {"files":[{"path":"src/pair.ts","size":1,"mode":420,"content":"x"}],"totalBytes":1}\n';
    const captured = `IR_RESULT {"commitSha":"${commitSha}","workspaceFiles":{"files":[{"path":"src/pair.ts","size":1,"mode":420,"content":"x"}],"totalBytes":1},"results":[{"status":"incomplete","diagnostics":[],"tests":[]},{"status":"passed","diagnostics":[],"tests":[{"name":"secret acceptance","status":"passed"}]}]}\n`;
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), touch: vi.fn(), reap: vi.fn(), removeWorkspace: vi.fn(), remove: vi.fn(), create: vi.fn(async (value: any) => { const item = { ...value, status: 'running', workspace: '/workspace/pair-1', acceptance: '/opt/ir/acceptance' }; records.set(value.id, item); return item; }), exec: vi.fn(async (_id: string, input: any) => ({ exitCode: 0, output: input.action === 'workspace-files' ? workspaceFiles : input.action === 'stage-commit' ? commitOutput : captured })) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' }); const created = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' }); await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'advance', reason: 'manual' });
    const submitted = await request(middleware, `/api/sandboxes/${created.body.id}/submit`); expect(submitted).toMatchObject({ status: 409, body: { error: 'Workspace and acceptance tests must all pass before submitting' } }); expect(manager.remove).not.toHaveBeenCalled(); expect(JSON.stringify(submitted.body)).not.toContain('secret acceptance');
  });
  it("sanitizes pre-fix raw AI results at read time without rewriting stored rows", async () => {
    const locked = '/captured/workspace/.ir-acceptance/stage-2.test.ts › later rollback requirement';
    const raw = { status: 'passed', diagnostics: [], tests: [{ name: 'workspace test', status: 'passed' }, { name: locked, status: 'passed', message: 'later-stage detail' }], output: { entries: [{ stream: 'stdout', text: locked }] } };
    const now = new Date().toISOString(); const timeline = [{ id: 'raw-timeline', ranAt: now, content: 'raw', result: raw }];
    db.prepare('INSERT INTO submissions (course_id, drill_id, submitted_at, content, result_json, timeline_json) VALUES (?, ?, ?, ?, ?, ?)').run('ai-course', 'pair', now, 'raw', JSON.stringify(raw), JSON.stringify(timeline));
    db.prepare('INSERT INTO draft_timelines (course_id, drill_id, timeline_json, updated_at) VALUES (?, ?, ?, ?)').run('ai-course', 'pair', JSON.stringify(timeline), now);
    const workspacePath = join(linkedCoursesRoot, 'drills/ai-course/pair/workspace'); db.prepare('INSERT INTO test_results (file_path, status, tests_json, updated_at) VALUES (?, ?, ?, ?)').run(workspacePath, 'passed', JSON.stringify(raw.tests), now);
    const middleware = captureMiddleware({ allowCodingRequest: () => true, allowStreamRequest: () => true });
    const manifest = await request(middleware, '/api/test-results', '127.0.0.1', 'GET'); const history = await request(middleware, '/api/progress/ai-course/pair/submissions', '127.0.0.1', 'GET');
    let streamBody = ''; await middleware({ url: '/api/test-results/stream', method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { streamBody += value; return true; }, end: vi.fn(), on: vi.fn() }, vi.fn());
    for (const surface of [JSON.stringify(manifest.body), JSON.stringify(history.body), streamBody]) { expect(surface).toContain('workspace test'); expect(surface).toContain('Acceptance: 1/1 passed'); expect(surface).not.toContain('later rollback requirement'); expect(surface).not.toContain('later-stage detail'); }
    expect((db.prepare('SELECT result_json FROM submissions WHERE course_id=? AND drill_id=?').get('ai-course', 'pair') as { result_json: string }).result_json).toContain('later rollback requirement');
    expect((db.prepare('SELECT tests_json FROM test_results WHERE file_path=?').get(workspacePath) as { tests_json: string }).tests_json).toContain('later rollback requirement');
  });
  it("applies only timer requirements whose active-time threshold is due", async () => {
    const records = new Map<string, any>(); const workspaceFiles = 'IR_RESULT {"files":[{"path":"src/pair.ts","size":1,"mode":420,"content":"x"}],"totalBytes":1}\n';
    const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), touch: vi.fn(), reap: vi.fn(), remove: vi.fn(), create: vi.fn(async (spec: any) => { const record = { ...spec, status: 'running', workspace: '/workspace/pair-1' }; records.set(spec.id, record); return record; }), exec: vi.fn(async (_id: string, input: any) => ({ exitCode: 0, output: input.action === 'workspace-files' ? workspaceFiles : commitOutput })) };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true }); await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'start' }); await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' });
    const early = await request(middleware, '/api/attempts/ai-course', '127.0.0.1', 'GET'); expect((early.body.attempts as any).pair.at(-1).stage).toBe(1); expect(manager.exec).not.toHaveBeenCalled();
    db.prepare("UPDATE drill_attempts SET active_since = ? WHERE course_id='ai-course' AND drill_id='pair'").run(new Date(Date.now() - 1000).toISOString());
    const due = await request(middleware, '/api/attempts/ai-course', '127.0.0.1', 'GET', undefined, { 'x-interview-time-zone': 'Asia/Kolkata' }); expect((due.body.attempts as any).pair.at(-1).stage).toBe(2); expect((due.body.attempts as any).pair.at(-1).lastStageReason).toBe('timer'); expect(manager.exec).toHaveBeenCalledWith(expect.any(String), { action: 'stage-commit', stage: 1, timeZone: 'Asia/Kolkata' });
  });
  it("opens only completed AI attempts for review without changing their state or permitting execution", async () => {
    startDrillAttempt('ai-course', 'pair'); recordAttemptStage('ai-course', 'pair', 1, 1, 'start'); completeDrillAttempt('ai-course', 'pair');
    const before = db.prepare('SELECT * FROM drill_attempts WHERE course_id=? AND drill_id=?').all('ai-course', 'pair'); const stages = db.prepare('SELECT * FROM attempt_stages WHERE course_id=? AND drill_id=?').all('ai-course', 'pair');
    const records = new Map<string, any>(); const manager = { start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), touch: vi.fn(), reap: vi.fn(), remove: vi.fn(async (id: string) => { records.delete(id); }), create: vi.fn(async (spec: any) => { const record = { ...spec, status: 'running', workspace: '/workspace/review' }; records.set(spec.id, record); return record; }), exec: vi.fn() };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    expect((await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair' })).status).toBe(409);
    for (const value of [{ review: true, attemptNumber: 2 }, { review: false, attemptNumber: 1 }, { review: true, attemptNumber: 0 }]) expect((await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair', ...value })).status).toBeGreaterThanOrEqual(400);
    const opened = await request(middleware, '/api/sandboxes', '127.0.0.1', 'POST', { courseId: 'ai-course', drillId: 'pair', review: true, attemptNumber: 1 }); expect(opened.status).toBe(201); const id = String(opened.body.id); expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ review: true, attemptNumber: 1 }), true);
    for (const action of ['run', 'submit']) expect((await request(middleware, `/api/sandboxes/${id}/${action}`)).status).toBe(409);
    expect((await request(middleware, '/api/attempts/ai-course/pair', '127.0.0.1', 'POST', { action: 'advance', reason: 'manual' })).status).toBe(409); expect(manager.exec).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM drill_attempts WHERE course_id=? AND drill_id=?').all('ai-course', 'pair')).toEqual(before); expect(db.prepare('SELECT * FROM attempt_stages WHERE course_id=? AND drill_id=?').all('ai-course', 'pair')).toEqual(stages);
    expect((await request(middleware, `/api/sandboxes/${id}`, '127.0.0.1', 'DELETE')).status).toBe(200); expect(manager.remove).toHaveBeenCalledWith(id, false);
  });
  it("creates, runs, submits, updates settings, and deletes a coding sandbox", async () => {
    const records = new Map<string, any>();
    let captures = 0; const submittedSha = 'b'.repeat(40);
    const manager = {
      start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), touch: vi.fn(), reap: vi.fn(),
      create: vi.fn(async (spec: any) => { const record = { ...spec, status: "running", target: "http://127.0.0.1:1", workspace: join(linkedCoursesRoot, spec.workspacePath), lastSeen: Date.now() }; records.set(spec.id, record); return record; }),
      remove: vi.fn(async (id: string) => { records.delete(id); }),
      exec: vi.fn(async (_id: string, input: any) => input.action === "settings" ? { exitCode: 0, output: 'IR_RESULT {"saved":true}\n' } : input.action === "workspace-files" ? { exitCode: 0, output: 'IR_RESULT {"files":[{"path":"hello-logic.ts","size":25,"mode":420,"content":"export const answer = 42;"}],"totalBytes":25}\n' } : { exitCode: 0, output: `IR_RESULT {"commitSha":"${++captures === 1 ? commitSha : submittedSha}","workspaceFiles":{"files":[{"path":"hello-logic.ts","size":25,"mode":420,"content":"export const answer = 42;"}],"totalBytes":25},"results":[{"status":"passed","diagnostics":[],"tests":[{"name":"fixture","status":"passed"}]}]}\n` }),
    };
    const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true });
    const created = await request(middleware, "/api/sandboxes", "127.0.0.1", "POST", { courseId: "example-course", drillId: "hello-logic" });
    expect(created.status).toBe(201); const id = created.body.id as string; expect(id).toBeTruthy();
    const runResponse = await request(middleware, "/api/drills/example-course/hello-logic/run", '127.0.0.1', 'POST', { timeZone: 'Asia/Kolkata' }); expect(runResponse, JSON.stringify(runResponse.body)).toMatchObject({ status: 200 }); expect(manager.exec).toHaveBeenCalledWith(id, expect.objectContaining({ action: 'capture-run', timeZone: 'Asia/Kolkata' }));
    expect((await request(middleware, `/api/sandboxes/${id}/settings`, "127.0.0.1", "PUT", { enabled: true })).status).toBe(200);
    expect((await request(middleware, `/api/sandboxes/${id}/submit`)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE course_id = ? AND drill_id = ?").get("example-course", "hello-logic")).toMatchObject({ count: 1 });
    const history = await request(middleware, "/api/progress/example-course/hello-logic/submissions", "127.0.0.1", "GET");
    expect(captures).toBe(2); expect((history.body.submissions as any[])[0]).toMatchObject({ commitSha: submittedSha }); expect((history.body.submissions as any[])[0]).not.toHaveProperty('files');
    expect((await request(middleware, `/api/sandboxes/${id}`, "127.0.0.1", "DELETE")).status).toBe(200);
    expect(manager.remove).toHaveBeenCalledWith(id, true);
  });

  it("forwards the captured commit to the development state origin on submit only", async () => {
    const records = new Map<string, any>();
    const manager = {
      start: vi.fn(async () => {}), close: vi.fn(), all: () => [...records.values()], get: (id: string) => records.get(id), touch: vi.fn(), reap: vi.fn(), remove: vi.fn(),
      create: vi.fn(async (spec: any) => { const record = { ...spec, status: "running", target: "http://127.0.0.1:1", workspace: join(linkedCoursesRoot, spec.workspacePath), lastSeen: Date.now() }; records.set(spec.id, record); return record; }),
      exec: vi.fn(async (_id: string, input: any) => input.action === "workspace-files" ? { exitCode: 0, output: 'IR_RESULT {"files":[{"path":"hello-logic.ts","size":1,"mode":420,"content":"x"}],"totalBytes":1}\n' } : { exitCode: 0, output: `IR_RESULT {"commitSha":"${commitSha}","workspaceFiles":{"files":[{"path":"hello-logic.ts","size":1,"mode":420,"content":"x"}],"totalBytes":1},"results":[{"status":"passed","diagnostics":[],"tests":[{"name":"fixture","status":"passed"}]}]}\n` }),
    };
    const forwarded: Array<{ url: string; body: any }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => { forwarded.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
    try {
      const middleware = captureMiddleware({ sandboxManager: manager as any, allowCodingRequest: () => true, remoteStateOrigin: 'http://state.test' });
      const created = await request(middleware, "/api/sandboxes", "127.0.0.1", "POST", { courseId: "example-course", drillId: "hello-logic" });
      expect((await request(middleware, `/api/sandboxes/${created.body.id}/run`)).status).toBe(200);
      expect(forwarded).toHaveLength(0);
      expect((await request(middleware, `/api/sandboxes/${created.body.id}/submit`)).status).toBe(200);
      expect(forwarded[0].url).toContain('/submissions');
      expect(forwarded[0].body).toMatchObject({ content: 'x', commitSha });
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("workspace markdown export", () => {
  it("skips lockfiles and binaries and never exceeds 256 KiB", () => {
    const content = "x".repeat(100_000); const markdown = workspaceMarkdown({ files: [
      { path: "src/a.ts", size: content.length, mode: 0o644, content }, { path: "src/b.ts", size: content.length, mode: 0o644, content }, { path: "src/c.ts", size: content.length, mode: 0o644, content },
      { path: "package-lock.json", size: 2, mode: 0o644, content: "{}" }, { path: "asset.png", size: 4, mode: 0o644, binary: true, sha256: "a".repeat(64) },
    ], totalBytes: content.length * 3 + 6 });
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(256 * 1024); expect(markdown).toContain("src/a.ts"); expect(markdown).not.toContain("src/c.ts"); expect(markdown).not.toContain("package-lock"); expect(markdown).not.toContain("asset.png");
  });
});

describe("attempt workspace cleanup", () => {
  it("cleans attempts that age after startup while preserving an active sandbox", async () => {
    const now = Date.now(); const started = new Date(now - 60_000).toISOString();
    db.prepare("INSERT INTO drill_attempts (course_id, drill_id, attempt_number, started_at, accumulated_active_ms) VALUES ('course','idle',1,?,0), ('course','active',1,?,0), ('course','completed',1,?,0)").run(started, started, started);
    db.prepare("UPDATE drill_attempts SET completed_at = ? WHERE course_id='course' AND drill_id='completed'").run(started);
    const removeWorkspace = vi.fn(async () => {}); const manager = { all: () => [{ id: 'active', courseId: 'course', drillId: 'active', attemptNumber: 1, kind: 'ai-coding', status: 'running' }], removeWorkspace } as any;
    await cleanupStaleAttemptWorkspaces(manager, now); expect(removeWorkspace).not.toHaveBeenCalled();
    await cleanupStaleAttemptWorkspaces(manager, now + 15 * 24 * 60 * 60_000); expect(removeWorkspace).toHaveBeenCalledTimes(1); expect(removeWorkspace).toHaveBeenCalledWith('course', 'idle', 1);
  });
});

describe("isTrustedLocalAddress", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.127.255.254", "::ffff:100.64.0.3", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:3456:7890:1234:5678"])("trusts %s", (address) => {
    expect(isTrustedLocalAddress(address)).toBe(true);
  });

  // 100.63.x and 100.128.x bracket the CGNAT range, so they prove the bounds are real.
  it.each([undefined, "", "192.0.2.5", "100.63.255.255", "100.128.0.1", "10.0.0.4", "2001:db8::1", "100.64.0", "100.64.0.1.5", "1100.64.0.1"])("rejects %s", (address) => {
    expect(isTrustedLocalAddress(address)).toBe(false);
  });
});
describe("isExactWebSocketOrigin", () => {
  it("requires an exact HTTP(S) origin matching the dev-server host", () => {
    expect(isExactWebSocketOrigin({ headers: { host: "127.0.0.1:5174", origin: "http://127.0.0.1:5174" } } as never)).toBe(true);
    for (const headers of [{ host: "127.0.0.1:5174" }, { host: "127.0.0.1:5174", origin: "https://evil.example" }, { host: "127.0.0.1:5174", origin: "http://127.0.0.1:5174/path" }]) expect(isExactWebSocketOrigin({ headers } as never)).toBe(false);
  });
});

describe("drill attempts API", () => {
  const courseId = "coding-interview-patterns";
  const drillId = "two-sum";
  const url = `/api/attempts/${courseId}/${drillId}`;

  it("starts, pauses, completes and lists durable attempts", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, `/api/attempts/${courseId}`, "127.0.0.1", "GET")).toEqual({ status: 200, body: { courseId, attempts: {} } });
    const started = await request(middleware, url, "127.0.0.1", "POST", { action: "start" });
    expect(started.status).toBe(200); expect(started.body.attempts).toHaveLength(1); expect(started.body.attempts[0]).toMatchObject({ attemptNumber: 1, accumulatedActiveMs: 0 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { action: "pause" })).toMatchObject({ status: 200 });
    const completed = await request(middleware, url, "127.0.0.1", "POST", { action: "complete" });
    expect(completed.body.attempts[0]).toMatchObject({ attemptNumber: 1 }); expect(completed.body.attempts[0].completedAt).toMatch(/^\d{4}-/);
    const listed = await request(middleware, `/api/attempts/${courseId}`, "127.0.0.1", "GET");
    expect((listed.body.attempts as Record<string, unknown[]>)[drillId]).toHaveLength(1);
    const redo = await request(middleware, url, "127.0.0.1", "POST", { action: "start" });
    expect(redo.body.attempts).toHaveLength(2); expect(redo.body.attempts[1]).toMatchObject({ attemptNumber: 2 });
  });

  it("completes an attempt when progress is marked done", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, `/api/progress/${courseId}/${drillId}`, "127.0.0.1", "PUT", { status: "done" })).toMatchObject({ status: 200 });
    const listed = await request(middleware, `/api/attempts/${courseId}`, "127.0.0.1", "GET");
    expect((listed.body.attempts as Record<string, Array<Record<string, unknown>>>)[drillId][0]).toMatchObject({ attemptNumber: 1, elapsedMs: 0 });
  });
});

describe("drill hint progress API", () => {
  const courseId = "initech-practical-coding-no-ai";
  const drillId = "per-item-sliding-window";
  const hint = "Milestone 1 — clarify and one item (5 + 15 minutes)";
  const url = `/api/progress/${courseId}/${drillId}/hints`;

  it("persists individual hints per drill and reset progress clears them", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, url, "127.0.0.1", "GET")).toEqual({ status: 200, body: { revealed: [] } });
    expect(await request(middleware, url, "127.0.0.1", "PUT", { hint })).toEqual({ status: 200, body: { revealed: [hint] } });
    expect(await request(middleware, url, "127.0.0.1", "GET")).toEqual({ status: 200, body: { revealed: [hint] } });
    expect(await request(middleware, `/api/progress/${courseId}/retry-scheduler/hints`, "127.0.0.1", "GET")).toEqual({ status: 200, body: { revealed: [] } });
    expect(await request(middleware, url, "127.0.0.1", "PUT", { hint: "not authored" })).toMatchObject({ status: 404 });
    expect(await request(middleware, `/api/progress/${courseId}/reset`, "127.0.0.1", "POST", { chapterId: "practical-coding" })).toMatchObject({ status: 200 });
    expect(await request(middleware, url, "127.0.0.1", "GET")).toEqual({ status: 200, body: { revealed: [] } });
  });
});

describe("drill submission history API", () => {
  const courseId = "initech-practical-coding-no-ai";
  const drillId = "per-item-sliding-window";
  const url = `/api/progress/${courseId}/${drillId}/submissions`;
  const commitSha = 'a'.repeat(40);
  const result = { status: "tests-failed", diagnostics: [{ file: "solution.ts", line: 2, col: 3, message: "Type mismatch" }], tests: [{ name: "handles one item", status: "failed", message: "expected true" }], output: { entries: [{ stream: "stdout" as const, text: "debug value\n", testName: "group > handles one item" }] } };

  it("persists repeat submissions and chapter reset clears them", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, url, "127.0.0.1", "GET")).toEqual({ status: 200, body: { submissions: [] } });
    const first = await request(middleware, url, "127.0.0.1", "POST", { content: "export const value = 1;", result, commitSha });
    expect(first.status).toBe(201); expect(first.body.submissions).toHaveLength(1); expect(first.body.submissions[0]).toMatchObject({ result, commitSha }); expect(first.body.submissions[0]).not.toHaveProperty('content'); expect(first.body.submissions[0].submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const second = await request(middleware, url, "127.0.0.1", "POST", { content: "export const value = 2;", commitSha, result: { status: "passed", diagnostics: [], tests: [{ name: "handles one item", status: "passed" }] } });
    expect(second.status).toBe(201); expect(second.body.submissions).toHaveLength(2); expect(second.body.submissions.map((item: { result: { status: string } }) => item.result.status)).toEqual(["tests-failed", "passed"]);
    expect((await request(middleware, url, "127.0.0.1", "GET")).body.submissions).toHaveLength(2);
    expect(await request(middleware, `/api/progress/${courseId}/reset`, "127.0.0.1", "POST", { chapterId: "practical-coding" })).toMatchObject({ status: 200 });
    expect(await request(middleware, url, "127.0.0.1", "GET")).toEqual({ status: 200, body: { submissions: [] } });
  });

  it("rejects legacy snapshot payloads and the removed draft timeline route", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, `${url}/timeline`, "127.0.0.1", "POST", { content: "x", result })).toMatchObject({ status: 404 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { content: "x", result })).toMatchObject({ status: 400 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { content: "x", result, commitSha: 'bad' })).toMatchObject({ status: 400 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { content: "x", result, attemptNumber: 1, stage: 1, files: [], totalBytes: 0 })).toMatchObject({ status: 400 });
  });

  it("validates submission payloads and rejects untrusted callers", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, url, "192.0.2.5", "GET")).toMatchObject({ status: 403 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { content: "x", commitSha, result: { ...result, status: "runner-error" } })).toMatchObject({ status: 400 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { content: "x", commitSha, result: { ...result, tests: [{ name: "bad", status: "unknown" }] } })).toMatchObject({ status: 400 });
    expect(await request(middleware, url, "127.0.0.1", "POST", { content: "x", result, commitSha, extra: true })).toMatchObject({ status: 400 });
  });

  it("renames, clears, and deletes a stable submission id", async () => {
    const middleware = captureMiddleware({});
    const created = await request(middleware, url, "127.0.0.1", "POST", { content: "export const value = 1;", result, commitSha }); const id = created.body.submissions[0].id;
    expect(await request(middleware, `${url}/${id}`, "192.0.2.5", "PATCH", { name: "blocked" })).toMatchObject({ status: 403 });
    const renamed = await request(middleware, `${url}/${id}`, "127.0.0.1", "PATCH", { name: "  First clean pass  " });
    expect(renamed).toMatchObject({ status: 200, body: { submissions: [{ id, name: "First clean pass" }] } });
    expect((await request(middleware, url, "127.0.0.1", "GET")).body.submissions[0].name).toBe("First clean pass");
    const cleared = await request(middleware, `${url}/${id}`, "127.0.0.1", "PATCH", { name: "   " });
    expect(cleared.status).toBe(200); expect(cleared.body.submissions[0]).not.toHaveProperty("name");
    for (const name of ["x".repeat(61), "bad\u0007name", 42]) expect(await request(middleware, `${url}/${id}`, "127.0.0.1", "PATCH", { name })).toMatchObject({ status: 400 });
    expect(await request(middleware, `${url}/${id}`, "127.0.0.1", "PATCH", { name: "ok", extra: true })).toMatchObject({ status: 400 });
    expect(await request(middleware, `${url}/999999`, "127.0.0.1", "PATCH", { name: "missing" })).toMatchObject({ status: 404 });
    expect(await request(middleware, `${url}/999999`, "127.0.0.1", "DELETE")).toMatchObject({ status: 404 });
    expect(await request(middleware, `${url}/current`, "127.0.0.1", "DELETE")).toMatchObject({ status: 404 });
    expect(await request(middleware, `/api/progress/${courseId}/return-rate-limiter/submissions/${id}`, "127.0.0.1", "DELETE")).toMatchObject({ status: 404 });
    expect(await request(middleware, `${url}/${id}`, "127.0.0.1", "DELETE")).toEqual({ status: 200, body: { submissions: [] } });
  });

  it("migrates legacy submission rows without changing ids or content", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec("CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT NOT NULL, drill_id TEXT NOT NULL, submitted_at TEXT NOT NULL, content TEXT NOT NULL, result_json TEXT NOT NULL)");
      legacy.prepare("INSERT INTO submissions (course_id, drill_id, submitted_at, content, result_json) VALUES (?, ?, ?, ?, ?)").run("course", "drill", "2026-10-20T00:00:00.000Z", "preserved source", JSON.stringify({ status: "passed", diagnostics: [], tests: [] }));
      ensureSubmissionSchema(legacy);
      const row = legacy.prepare("SELECT id, content, custom_name, timeline_json FROM submissions").get() as { id: number; content: string; custom_name: string | null; timeline_json: string | null };
      expect(row).toEqual({ id: 1, content: "preserved source", custom_name: null, timeline_json: null });
    } finally { legacy.close(); }
  });
});

describe("drill progress status API", () => {
  const url = "/api/progress/initech-practical-coding-no-ai/per-item-sliding-window";

  it("accepts blocked and advertises it in validation errors", async () => {
    const middleware = captureMiddleware({});
    expect(await request(middleware, url, "127.0.0.1", "PUT", { status: "blocked" })).toMatchObject({ status: 200, body: { status: "blocked" } });
    const library = await request(middleware, "/api/library", "127.0.0.1", "GET"); expect(library.status).toBe(200); expect(library.body.items.find((item: { id: string }) => item.id === "initech-practical-coding-no-ai")).toMatchObject({ blockedDrills: 1 });
    expect(await request(middleware, url, "127.0.0.1", "PUT", { status: "paused" })).toEqual({ status: 400, body: { error: "status must be not-started, in-progress, blocked, or done" } });
  });

  it("transactionally migrates old progress rows and is idempotent", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec("CREATE TABLE progress (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('not-started','in-progress','done')), notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id))");
      legacy.prepare("INSERT INTO progress (course_id, drill_id, status, notes, updated_at) VALUES (?, ?, ?, ?, ?)").run("course", "done-drill", "done", "preserve me", "2026-10-21T00:00:00.000Z");
      ensureProgressSchema(legacy); ensureProgressSchema(legacy);
      expect(legacy.prepare("SELECT course_id, drill_id, status, notes, updated_at FROM progress").all()).toEqual([{ course_id: "course", drill_id: "done-drill", status: "done", notes: "preserve me", updated_at: "2026-10-21T00:00:00.000Z" }]);
      expect(() => legacy.prepare("INSERT INTO progress (course_id, drill_id, status, notes, updated_at) VALUES (?, ?, ?, ?, ?)").run("course", "blocked-drill", "blocked", null, "2026-10-21T00:00:01.000Z")).not.toThrow();
      expect(legacy.prepare("SELECT COUNT(*) count FROM progress").get()).toEqual({ count: 2 });
    } finally { legacy.close(); }
  });
});

describe("GET /api/test-results/stream", () => {
  it("keeps the loaded Vite config inert in middleware mode", async () => {
    vi.mocked(fsWatch).mockClear();
    const configuredPlugin = (viteConfig as any).plugins.find((plugin: any) => plugin?.name === "practice-api");
    expect(configuredPlugin).toBeDefined();
    configuredPlugin.configureServer({ httpServer: { once: vi.fn() }, middlewares: { use: vi.fn() } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fsWatch).not.toHaveBeenCalled();
  });

  it("does not watch in the Vite config combination used by Vitest middleware, but an explicit seam enables watchers", async () => {
    const defaultPlugin = apiPlugin({ enableDeterministicWatchers: true });
    (defaultPlugin.configureServer as any)({ middlewares: { use: vi.fn() } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fsWatch).not.toHaveBeenCalled();
    defaultPlugin.closeBundle?.();

    const explicitWatcher = vi.fn(() => ({ close: vi.fn(), on: vi.fn() }) as any);
    const explicitPlugin = apiPlugin({ watcherFactory: explicitWatcher });
    (explicitPlugin.configureServer as any)({ middlewares: { use: vi.fn() } });
    await vi.waitFor(() => expect(explicitWatcher).toHaveBeenCalled());
    explicitPlugin.closeBundle?.();
  });

  it("installs deterministic watchers and registers HTTP-server shutdown in dev mode", async () => {
    let stop: (() => void) | undefined;
    const close = vi.fn();
    const watcherFactory = vi.fn(() => ({ close, on: vi.fn() }) as any);
    const plugin = apiPlugin({ enableDeterministicWatchers: true, watcherFactory });
    (plugin.configureServer as any)({
      httpServer: { once: vi.fn((_event: string, listener: () => void) => { stop = listener; }) },
      middlewares: { use: vi.fn() },
    });

    await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalled());
    expect(stop).toBeDefined();
    stop!();
    expect(close).toHaveBeenCalled();
    plugin.closeBundle?.();
  });

  it("runs the focused test when its source changes without an SSE subscriber", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const runner = vi.fn(async (_testPath: string, outputPath: string) => {
      await writeFile(outputPath, JSON.stringify({
        startTime: Date.now(),
        testResults: [{ name: _testPath, status: "passed", assertionResults: [{ fullName: "focused", status: "passed" }] }],
      }));
    });
    const plugin = apiPlugin({
      runner,
      watcherFactory: vi.fn((path: string, _options: object, callback: () => void) => {
        watched.set(path, callback);
        return { close: vi.fn(), on: vi.fn() } as any;
      }),
    });
    const configure = plugin.configureServer as any;
    configure({ middlewares: { use: vi.fn() } });
    // Manifest loading is intentionally asynchronous at startup.
    for (let attempt = 0; attempt < 20 && watched.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const sourcePath = resolve(linkedCoursesRoot, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.ts");
    const testPath = resolve(linkedCoursesRoot, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts");
    expect(watched.has(dirname(sourcePath))).toBe(true);
    expect(watched.has(dirname(testPath))).toBe(true);
    try {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      emit(watched, sourcePath);
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0][0]).toBe(testPath);
      for (let attempt = 0; attempt < 30 && !getAllTestFiles()[testPath]; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getAllTestFiles()[testPath]).toMatchObject({ status: "passed" });
      // Directory watchers survive an atomic replacement (rename) and remain
      // usable for the next save too.
      watched.get(dirname(sourcePath))!("rename", basename(sourcePath));
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      plugin.closeBundle?.();
    }
  });

  it("runs on test-file saves and preserves a failed Vitest outcome", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const runner = vi.fn(async (testPath: string, outputPath: string) => {
      await writeFile(outputPath, JSON.stringify({ startTime: Date.now(), testResults: [{ name: testPath, status: "failed", assertionResults: [{ fullName: "broken assertion", status: "failed", failureMessages: ["Assertion failed"] }] }] }));
    });
    const plugin = apiPlugin({ runner, watcherFactory: vi.fn((path: string, _options: object, callback: () => void) => { watched.set(path, callback); return { close: vi.fn(), on: vi.fn() } as any; }) });
    (plugin.configureServer as any)({ middlewares: { use: vi.fn() } });
    for (let attempt = 0; attempt < 20 && watched.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const root = linkedCoursesRoot;
    const sourcePath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.ts");
    const testPath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts");
    try {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      emit(watched, testPath);
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0][0]).toBe(testPath);
      for (let attempt = 0; attempt < 30 && !getAllTestFiles()[testPath]; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getAllTestFiles()[testPath]).toMatchObject({ status: "failed", tests: [{ status: "failed", message: "Assertion failed" }] });
      expect(watched.has(dirname(sourcePath))).toBe(true);
    } finally {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      plugin.closeBundle?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("coalesces saves during a run and does not strand a later generation", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const gates: Array<() => Promise<void>> = [];
    const runner = vi.fn((testPath: string, outputPath: string) => new Promise<void>((resolve, reject) => {
      gates.push(async () => {
        try {
          await writeFile(outputPath, JSON.stringify({ startTime: Date.now(), testResults: [{ name: testPath, status: "passed", assertionResults: [{ fullName: `run-${gates.length}`, status: "passed" }] }] }));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    }));
    const plugin = apiPlugin({ runner, watcherFactory: vi.fn((path: string, _options: object, callback: () => void) => { watched.set(path, callback); return { close: vi.fn(), on: vi.fn() } as any; }) });
    (plugin.configureServer as any)({ middlewares: { use: vi.fn() } });
    for (let attempt = 0; attempt < 20 && watched.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const root = linkedCoursesRoot;
    const sourcePath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.ts");
    const testPath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts");
    try {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      emit(watched, sourcePath);
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledOnce();
      emit(watched, sourcePath);
      emit(watched, testPath);
      await gates[0]();
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledTimes(2);
      // Let the debounce from the saves during run 1 complete while run 2 is
      // active. A later save must still be represented by a third run, rather
      // than a stranded queued flag.
      await new Promise((resolve) => setTimeout(resolve, 130));
      emit(watched, sourcePath);
      await gates[1]();
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledTimes(3);
      await gates[2]();
      for (let attempt = 0; attempt < 30 && !getAllTestFiles()[testPath]; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getAllTestFiles()[testPath].tests[0].name).toBe("run-3");
    } finally {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      plugin.closeBundle?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("reports runner crashes without replacing the previous result", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const runner = vi.fn(async () => { throw new Error("simulated crash"); });
    const root = linkedCoursesRoot;
    const testPath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts");
    upsertTestFile(testPath, "passed", [{ name: "previous", status: "passed" }], new Date(Date.now() - 60_000).toISOString());
    const plugin = apiPlugin({ runner, watcherFactory: vi.fn((path: string, _options: object, callback: () => void) => { watched.set(path, callback); return { close: vi.fn(), on: vi.fn() } as any; }) });
    (plugin.configureServer as any)({ middlewares: { use: vi.fn() } });
    for (let attempt = 0; attempt < 20 && watched.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      emit(watched, testPath);
      for (let attempt = 0; attempt < 30 && runner.mock.calls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner).toHaveBeenCalledOnce();
      expect(getAllTestFiles()[testPath]).toMatchObject({ status: "passed", tests: [{ name: "previous" }] });
    } finally {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      plugin.closeBundle?.();
    }
  });

  it("runs the local Vitest seam without a shell, accepts exit 0/1, and cleans unique temp reports", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; pid?: number }> = [];
    const spawnFactory = vi.fn((_command: string, args: string[], options: object) => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(), pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
      children.push(child);
      expect(_command).toBe(process.execPath);
      expect(args).toContain("--reporter=json");
      expect(options).not.toHaveProperty("shell");
      const outputPath = args.find((arg) => arg.startsWith("--outputFile.json="))!.slice("--outputFile.json=".length);
      void writeFile(outputPath, JSON.stringify({ testResults: [{ name: args[2], status: "passed", assertionResults: [{ title: "local", status: "passed" }] }] }));
      setTimeout(() => { child.stdout.emit('data', Buffer.from(`raw output\n${consoleFramePrefix}${JSON.stringify({ stream: 'stdout', text: 'inside test', testName: 'group > local' })}\n`)); child.emit("close", children.length === 1 ? 0 : 1, null); }, 0);
      return child as any;
    });
    const plugin = apiPlugin({ spawnFactory, watcherFactory: vi.fn((path: string, _options: object, callback: (...args: any[]) => void) => { watched.set(path, callback); return { close: vi.fn(), on: vi.fn() } as any; }) });
    let middleware: any; (plugin.configureServer as any)({ middlewares: { use: (handler: any) => { middleware = handler; } } });
    for (let attempt = 0; attempt < 20 && watched.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const sourcePath = resolve(linkedCoursesRoot, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.ts");
    const testPath = resolve(linkedCoursesRoot, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts");
    try {
      let streamBody = ''; await middleware({ url: '/api/test-results/stream', method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { streamBody += value; return true; }, end: vi.fn(), on: vi.fn() }, vi.fn());
      emit(watched, sourcePath);
      for (let attempt = 0; attempt < 30 && children.length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      for (let attempt = 0; attempt < 30 && children.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnFactory).toHaveBeenCalledTimes(1);
      emit(watched, testPath);
      for (let attempt = 0; attempt < 30 && children.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnFactory).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(streamBody).toContain('inside test')); expect(streamBody).toContain('group > local'); expect(streamBody).toContain('raw output');
      expect((spawnFactory.mock.calls[0][1] as string[]).find((arg) => arg.startsWith("--outputFile.json="))).not.toBe((spawnFactory.mock.calls[1][1] as string[]).find((arg) => arg.startsWith("--outputFile.json=")));
    } finally { plugin.closeBundle?.(); await new Promise((resolve) => setTimeout(resolve, 20)); }
  });

  it("kills a stuck local runner and clears the timeout", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 12345 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const plugin = apiPlugin({
      runnerTimeoutMs: 10,
      spawnFactory: vi.fn(() => child as any),
      watcherFactory: vi.fn((path: string, _options: object, callback: (...args: any[]) => void) => { watched.set(path, callback); return { close: vi.fn(), on: vi.fn() } as any; }),
    });
    (plugin.configureServer as any)({ middlewares: { use: vi.fn() } });
    await vi.waitFor(() => expect(watched.size).toBeGreaterThan(0));
    try {
      const sourcePath = resolve(linkedCoursesRoot, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.ts");
      emit(watched, sourcePath);
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL"), { timeout: 1000 });
    } finally { plugin.closeBundle?.(); kill.mockRestore(); }
  });

  it("persists and emits a scoped SSE update from a file event", async () => {
    const watched = new Map<string, (...args: any[]) => void>();
    const runner = vi.fn(async (testPath: string, outputPath: string) => {
      await writeFile(outputPath, JSON.stringify({ startTime: Date.now(), testResults: [{ name: testPath, status: "passed", assertionResults: [{ fullName: "scoped", status: "passed" }] }] }));
    });
    const plugin = apiPlugin({ runner, watcherFactory: vi.fn((path: string, _options: object, callback: () => void) => { watched.set(path, callback); return { close: vi.fn(), on: vi.fn() } as any; }) });
    let middleware: Middleware | undefined;
    let body = "";
    (plugin.configureServer as any)({ middlewares: { use: (handler: Middleware) => { middleware = handler; } } });
    for (let attempt = 0; attempt < 20 && watched.size === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!middleware) throw new Error("API middleware was not registered");
    const response = { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { body += value; return true; }, end: vi.fn(), on: vi.fn() };
    const stream = middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn());
    await stream;
    const root = linkedCoursesRoot;
    const sourcePath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.ts");
    const testPath = resolve(root, "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts");
    try {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      emit(watched, sourcePath);
      for (let attempt = 0; attempt < 30 && !body.includes('event: test-result'); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(body).toContain('event: test-result');
      const update = JSON.parse(body.match(/event: test-result\ndata: (.+)\n\n/)![1]) as Record<string, unknown>;
      expect(update).toMatchObject({ courseId: "coding-interview-patterns", chapterId: "two-pointers", drillId: "valid-palindrome", testPath: "drills/coding-interview-patterns/valid-palindrome/valid-palindrome.test.ts" });
      expect((update.result as Record<string, unknown>).status).toBe("passed");
      expect(getAllTestFiles()[testPath]).toMatchObject({ status: "passed" });
    } finally {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(testPath);
      plugin.closeBundle?.();
    }
  });

  it("opens an SSE stream and sends the deterministic snapshot", async () => {
    upsertTestFile("/stale/host/path.test.ts", "passed", [], "2026-08-12T12:00:00.000Z");
    const middleware = captureMiddleware({ reportFile: join(tmpdir(), "interview-runner-snapshot-report-does-not-exist.json") });
    let body = "";
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      write: (value: string) => { body += value; return true; },
      end: vi.fn(),
      on: vi.fn(),
    };
    await middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn());
    expect(response.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(body).toContain(": connected\n\n");
    expect(body).toContain("event: snapshot\n");
    const snapshot = JSON.parse(body.match(/event: snapshot\ndata: (.+)\n\n/)![1]) as { available: boolean; reason?: string; files?: Record<string, unknown> };
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("no-runs-recorded");
    expect(snapshot.files).toBeUndefined();
    expect(body).not.toContain("/stale/host/path.test.ts");
  });

  it("maps an absolute report entry to the manifest-relative snapshot key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interview-runner-sse-"));
    const report = join(directory, "report.json");
        const testPath = join(linkedCoursesRoot, "drills/example-course/hello-logic/hello-logic.test.ts");
    await writeFile(report, JSON.stringify({ startTime: Date.now(), testResults: [{ name: testPath, status: "passed", assertionResults: [{ fullName: "hello", status: "passed" }] }] }));
    try {
      const middleware = captureMiddleware({ reportFile: report });
      let body = "";
      const response = { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { body += value; return true; }, end: vi.fn(), on: vi.fn() };
      await middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn());
      const snapshot = JSON.parse(body.match(/event: snapshot\ndata: (.+)\n\n/)![1]) as { available: boolean; files?: Record<string, unknown> };
      expect(snapshot.available).toBe(true);
      expect(Object.keys(snapshot.files as object)).toEqual(["drills/example-course/hello-logic/hello-logic.test.ts"]);
      expect(JSON.stringify(snapshot)).not.toContain(testPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks an old manifest result stale without exposing absolute paths or writing on GET", async () => {
        const testPath = "drills/coding-interview-patterns/binary-tree-level-order/binary-tree-level-order.test.ts";
    const filePath = join(linkedCoursesRoot, testPath);
    const old = "2000-01-01T00:00:00.000Z";
    expect(upsertTestFile(filePath, "skipped", [], old)).toBe(true);
    try {
      const before = getAllTestFiles();
      const middleware = captureMiddleware({ reportFile: join(tmpdir(), "interview-runner-read-only-report-does-not-exist.json") });
      let body = "";
      const response = { statusCode: 0, setHeader: vi.fn(), write: (value: string) => { body += value; return true; }, end: vi.fn(), on: vi.fn() };
      await middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn());
      const snapshot = JSON.parse(body.match(/event: snapshot\ndata: (.+)\n\n/)![1]) as { available: boolean; files: Record<string, { stale?: boolean; staleReason?: string }> };
      expect(snapshot.files[testPath]).toMatchObject({ stale: true, staleReason: "drill-changed" });
      expect(JSON.stringify(snapshot)).not.toContain(filePath);
      expect(getAllTestFiles()).toEqual(before);
    } finally {
      db.prepare("DELETE FROM test_results WHERE file_path = ?").run(filePath);
    }
  });

  it("uses per-file timestamps and accepts todo as pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interview-runner-report-"));
    const report = join(directory, "report.json");
        const filePath = join(linkedCoursesRoot, "drills/example-course/hello-logic/hello-logic.test.ts");
    await writeFile(report, JSON.stringify({ startTime: Date.parse("2020-01-01T00:00:00.000Z"), testResults: [{ name: filePath, endTime: Date.parse("2099-01-01T00:00:00.000Z"), status: "passed", assertionResults: [{ title: "todo assertion", status: "todo" }] }] }));
    try {
      const middleware = captureMiddleware({ reportFile: report });
      const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn(), on: vi.fn() };
      await middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn());
      const stored = getAllTestFiles()[filePath];
      expect(stored.updatedAt).toBe("2099-01-01T00:00:00.000Z");
      expect(stored.tests[0].status).toBe("pending");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not replace a newer database result with an older report", () => {
    const filePath = "/monotonic/result.test.ts";
    expect(upsertTestFile(filePath, "passed", [], "2025-01-01T00:00:00.000Z")).toBe(true);
    expect(upsertTestFile(filePath, "failed", [{ name: "old", status: "failed" }], "2024-01-01T00:00:00.000Z")).toBe(false);
    expect(getAllTestFiles()[filePath]).toMatchObject({ status: "passed", updatedAt: "2025-01-01T00:00:00.000Z" });
  });

  it.each([
    ["2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", true],
    ["2025-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z", false],
    ["+010000-01-01T00:00:00.000Z", "9999-01-01T00:00:00.000Z", false],
  ])("compares timestamps by instant (%s vs %s)", (existing, incoming, accepted) => {
    const filePath = `/numeric/${existing}-${incoming}.test.ts`;
    upsertTestFile(filePath, "passed", [], existing);
    expect(upsertTestFile(filePath, "failed", [], incoming)).toBe(accepted);
  });

  it("handles corrupt existing timestamps safely and rejects corrupt incoming timestamps", () => {
    const corruptExisting = "/numeric/corrupt-existing.test.ts";
    db.prepare("INSERT INTO test_results (file_path, status, tests_json, updated_at) VALUES (?, ?, ?, ?)").run(corruptExisting, "passed", "[]", "corrupt-existing");
    expect(upsertTestFile(corruptExisting, "failed", [], "2025-01-01T00:00:00.000Z")).toBe(true);
    expect(getAllTestFiles()[corruptExisting]).toMatchObject({ status: "failed", updatedAt: "2025-01-01T00:00:00.000Z" });

    const validExisting = "/numeric/corrupt-incoming.test.ts";
    expect(upsertTestFile(validExisting, "passed", [], "2025-01-01T00:00:00.000Z")).toBe(true);
    expect(upsertTestFile(validExisting, "failed", [], "corrupt-incoming")).toBe(false);
    expect(getAllTestFiles()[validExisting]).toMatchObject({ status: "passed", updatedAt: "2025-01-01T00:00:00.000Z" });
  });

  it("rejects malformed and huge report timestamps without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interview-runner-bad-time-"));
    const report = join(directory, "report.json");
        await writeFile(report, JSON.stringify({ startTime: 1e300, testResults: [{ name: join(linkedCoursesRoot, "drills/example-course/hello-logic/hello-logic.test.ts"), endTime: 1e300, status: "passed", assertionResults: [{ title: "huge", status: "passed" }] }] }));
    try {
      const middleware = captureMiddleware({ reportFile: report });
      const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn(), on: vi.fn() };
      await expect(middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn())).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("ends the subscriber and clears its heartbeat on plugin shutdown", async () => {
    vi.useFakeTimers();
    try {
      let middleware: Middleware | undefined;
      let stop: (() => void) | undefined;
      const watcher = { close: vi.fn(), on: vi.fn() };
      const watcherFactory = vi.fn(() => watcher as any);
      const plugin = apiPlugin({
        reportFile: join(tmpdir(), "interview-runner-shutdown-report-does-not-exist.json"),
        watcherFactory,
      });
      (plugin.configureServer as any)({
        httpServer: { once: (_event: string, listener: () => void) => { stop = listener; } },
        middlewares: { use: (handler: Middleware) => { middleware = handler; } },
      });
      if (!middleware || !stop) throw new Error("API plugin was not configured");
      const response = {
        statusCode: 0,
        setHeader: vi.fn(),
        write: vi.fn(() => true),
        end: vi.fn(),
        on: vi.fn(),
      };
      await middleware({ url: "/api/test-results/stream", method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, vi.fn());
      await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalled());
      stop();
      expect(watcher.close).toHaveBeenCalledOnce();
      expect(response.end).toHaveBeenCalledOnce();
      const writesAtStop = response.write.mock.calls.length;
      vi.advanceTimersByTime(20_000);
      expect(response.write).toHaveBeenCalledTimes(writesAtStop);
      expect(response.end).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
