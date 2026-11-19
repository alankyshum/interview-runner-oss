// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, waitForRemoteSandboxTarget, waitForSandboxTarget } from './sandboxClient';
import { courseRepos } from './courseRepos';
import type { SandboxCreateSpec, SandboxRecord } from './sandboxTypes';

const spec = (id: string): SandboxCreateSpec => ({ id, repoId: 'repo', courseId: 'course', drillId: id, kind: 'coding', workspacePath: `drills/course/${id}`, sourcePath: `drills/course/${id}/index.ts` });
const record = (value: SandboxCreateSpec, lastSeen = Date.now()): SandboxRecord => ({ ...value, status: 'running', target: 'http://127.0.0.1', workspace: value.workspacePath, lastSeen });

describe('local sandbox startup', () => {
  it('fails closed rather than opening a writable local review workspace', async () => {
    const previous = process.env.RUNNER_SANDBOX_DRIVER; process.env.RUNNER_SANDBOX_DRIVER = 'local'; const manager = SandboxManager.fromEnvironment();
    try { await expect(manager.create({ ...spec('review-test'), kind: 'ai-coding', attemptNumber: 1, review: true })).rejects.toThrow('Read-only review is unavailable'); }
    finally { manager.close(); if (previous === undefined) delete process.env.RUNNER_SANDBOX_DRIVER; else process.env.RUNNER_SANDBOX_DRIVER = previous; }
  });
  it('retains a committed AI attempt across removal and manager restart, with a fresh next attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-ai-attempt-test-')); const template = join(root, 'drills/course/pair/workspace'); await mkdir(template, { recursive: true }); await writeFile(join(template, 'index.ts'), 'export const value = 1;\n'); await mkdir(join(root, 'courses')); await writeFile(join(root, 'courses/course.json'), '{"id":"course"}');
    const fake = join(root, 'code-server'); await writeFile(fake, `#!${process.execPath}\nconst net = require('node:net'); const port = Number(process.argv[process.argv.indexOf('--bind-addr') + 1].split(':').pop()); net.createServer(s => s.end()).listen(port, '127.0.0.1');\n`); await chmod(fake, 0o755);
    const old = { ...process.env }; process.env.XDG_STATE_HOME = join(root, 'state'); process.env.SANDBOX_UI_STATE_DIR = join(root, 'ui'); process.env.RUNNER_SANDBOX_DRIVER = 'local'; process.env.CODE_SERVER_BIN = fake; const repo = { id: 'test/ai', name: 'ai', root }; courseRepos.push(repo);
    const base: SandboxCreateSpec = { id: 'attempt-one', repoId: repo.id, courseId: 'course', drillId: 'pair', kind: 'ai-coding', workspacePath: 'drills/course/pair/workspace', sourcePath: 'drills/course/pair/workspace/index.ts', attemptNumber: 1 };
    let manager = SandboxManager.fromEnvironment();
    try {
      await manager.start(); const first = await manager.create(base); await writeFile(join(first.workspace, 'index.ts'), 'export const value = 2;\n'); const files = await manager.exec(first.id, { action: 'workspace-files' }); expect(files.exitCode).toBe(0); expect(JSON.parse(files.output.trim().slice('IR_RESULT '.length)).files).toContainEqual(expect.objectContaining({ path: 'index.ts', content: 'export const value = 2;\n' })); const commit = await manager.exec(first.id, { action: 'stage-commit', stage: 1 }); expect(commit.exitCode).toBe(0); const sha = JSON.parse(commit.output.trim().slice('IR_RESULT '.length)).commitSha;
      await manager.remove(first.id, false); manager.close(); manager = SandboxManager.fromEnvironment(); await manager.start(); const resumed = await manager.create({ ...base, id: 'attempt-resumed' }); expect(await readFile(join(resumed.workspace, 'index.ts'), 'utf8')).toContain('value = 2'); const again = await manager.exec(resumed.id, { action: 'stage-commit', stage: 1 }); expect(JSON.parse(again.output.trim().slice('IR_RESULT '.length)).commitSha).toBe(sha);
      const next = await manager.create({ ...base, id: 'attempt-two', attemptNumber: 2 }); expect(await readFile(join(next.workspace, 'index.ts'), 'utf8')).toContain('value = 1'); expect(next.workspace).not.toBe(resumed.workspace); await manager.remove(next.id, false); await manager.remove(resumed.id, false);
    } finally { manager.close(); courseRepos.splice(courseRepos.indexOf(repo), 1); for (const key of ['XDG_STATE_HOME', 'SANDBOX_UI_STATE_DIR', 'RUNNER_SANDBOX_DRIVER', 'CODE_SERVER_BIN']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } await rm(root, { recursive: true, force: true }); }
  });
  it('does not expose the proxy target until its listener is reachable', async () => {
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('test listener did not bind'); const port = address.port; await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']); const ready = waitForSandboxTarget(port, child, () => '', 2_000);
    const backend = createServer((socket) => socket.end()); setTimeout(() => backend.listen(port, '127.0.0.1'), 75); await ready;
    const closed = Promise.all([once(child, 'close'), once(backend, 'close')]); child.kill('SIGTERM'); backend.close(); await closed;
  });

  it('waits for a remote code-server health response', async () => {
    const reservation = createHttpServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('test listener did not bind'); const port = address.port; await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const ready = waitForRemoteSandboxTarget(`http://127.0.0.1:${port}`, 2_000); const backend = createHttpServer((_request, response) => response.writeHead(200).end()); setTimeout(() => backend.listen(port, '127.0.0.1'), 75); await ready;
    const closed = once(backend, 'close'); backend.close(); await closed;
  });
});

describe('SandboxManager lifecycle serialization', () => {
  it('supplies the runner timestamp to captured runs and stage commits', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T02:34:56Z'));
    const exec = vi.fn(async (_id: string, _input: unknown) => ({ output: '', exitCode: 0 }));
    const manager = new SandboxManager({ exec } as any);
    try {
      await manager.exec('id', { action: 'capture-run', runs: [[]], commitTimestamp: 'untrusted' });
      await manager.exec('id', { action: 'stage-commit', stage: 1 });
      await manager.exec('id', { action: 'capture-run', runs: [[]], timeZone: 'Asia/Kolkata' });
      await manager.exec('id', { action: 'stage-commit', stage: 1, timeZone: 'America/Los_Angeles' });
      const { localCommitTimestamp } = await import('./sandboxGit');
      const expected = localCommitTimestamp();
      expect(exec.mock.calls[0][1]).toMatchObject({ commitTimestamp: expected });
      expect(exec.mock.calls[1][1]).toMatchObject({ commitTimestamp: expected });
      expect(exec.mock.calls[2][1]).toMatchObject({ commitTimestamp: '2026-10-28T08:04:56+05:30' });
      expect(exec.mock.calls[3][1]).toMatchObject({ commitTimestamp: '2026-10-27T19:34:56-07:00' });
    } finally { manager.close(); vi.useRealTimers(); }
  });
  it('removes a previous coding sandbox for the same drill before creating its replacement', async () => {
    const previous = record({ ...spec('old-id'), drillId: 'same' }); const other = record(spec('other-id')); const order: string[] = [];
    const driver = { list: vi.fn(async () => [previous, other]), create: vi.fn(async (value: SandboxCreateSpec) => { order.push(`create:${value.id}`); return record(value); }), remove: vi.fn(async (id: string) => { order.push(`remove:${id}`); }), removeWorkspace: vi.fn(), exec: vi.fn() };
    const manager = new SandboxManager(driver as any); await manager.start();
    try { await manager.create({ ...spec('new-id'), drillId: 'same' }); expect(order).toEqual(['remove:old-id', 'create:new-id']); expect(manager.get('old-id')).toBeUndefined(); expect(manager.get('other-id')).toBeDefined(); } finally { manager.close(); }
  });

  it('keeps at most two running sandboxes across concurrent creates', async () => {
    const running = new Set<string>(); let peak = 0;
    const driver = { list: vi.fn(async () => []), create: vi.fn(async (value: SandboxCreateSpec) => { await new Promise((resolve) => setTimeout(resolve, 5)); running.add(value.id); peak = Math.max(peak, running.size); return record(value); }), remove: vi.fn(async (id: string) => { running.delete(id); }), removeWorkspace: vi.fn(), exec: vi.fn() };
    const manager = new SandboxManager(driver as any); await manager.start();
    try { await Promise.all([manager.create(spec('first-id')), manager.create(spec('second-id')), manager.create(spec('third-id')), manager.create(spec('fourth-id'))]); expect(peak).toBeLessThanOrEqual(2); expect(manager.all().filter((item) => item.status === 'running')).toHaveLength(2); } finally { manager.close(); }
  });

  it('reuses one AI sandbox for concurrent opens of the same attempt', async () => {
    const records: SandboxRecord[] = []; const create = vi.fn(async (value: SandboxCreateSpec) => { await new Promise((resolve) => setTimeout(resolve, 5)); const next = record(value); records.push(next); return next; });
    const manager = new SandboxManager({ list: async () => records, create, remove: vi.fn(), removeWorkspace: vi.fn(), exec: vi.fn() } as any); await manager.start();
    try { const base = { ...spec('one'), kind: 'ai-coding' as const, drillId: 'same', attemptNumber: 1 }; const [first, second] = await Promise.all([manager.create(base, true), manager.create({ ...base, id: 'two' }, true)]); expect(first.id).toBe(second.id); expect(create).toHaveBeenCalledTimes(1); } finally { manager.close(); }
  });

  it('logs a counter increase with socket count even after an unknown sample', async () => {
    const item = record(spec('health-id')); let value = { oomKills: 0 as number | null, extHostCrashes: 0 as number | null }; const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new SandboxManager({ list: async () => [item], health: async () => ({ ...value }), create: vi.fn(), remove: vi.fn(), removeWorkspace: vi.fn(), exec: vi.fn() } as any);
    await manager.start(); try { await vi.waitFor(() => expect(manager.health(item.id)?.oomKills).toBe(0)); const release = manager.trackSocket(item.id); value = { oomKills: null, extHostCrashes: null }; await manager.pollHealth(); value = { oomKills: 1, extHostCrashes: 0 }; await manager.pollHealth(); expect(warning).toHaveBeenCalledOnce(); expect(JSON.parse(String(warning.mock.calls[0][0]))).toMatchObject({ event: 'sandbox-health-increase', sandboxId: item.id, sockets: 1, health: { oomKills: 1 } }); release(); } finally { manager.close(); warning.mockRestore(); }
  });

  it('refreshes reconciled running lastSeen instead of immediately reaping it', async () => {
    const stale = record(spec('stale-id'), 1); const remove = vi.fn(); const manager = new SandboxManager({ list: vi.fn(async () => [stale]), create: vi.fn(), remove, removeWorkspace: vi.fn(), exec: vi.fn() } as any);
    const before = Date.now(); await manager.start(); try { expect(manager.get(stale.id)!.lastSeen).toBeGreaterThanOrEqual(before); await manager.reap(before + 1000); expect(remove).not.toHaveBeenCalled(); } finally { manager.close(); }
  });

  it('does not let a socket from a removed sandbox affect a replacement with the same id', async () => {
    const original = record(spec('same-id')); const remove = vi.fn(async () => {}); const manager = new SandboxManager({ list: async () => [original], create: async (value: SandboxCreateSpec) => record(value), remove, removeWorkspace: vi.fn(), exec: vi.fn() } as any);
    await manager.start(); try {
      const releaseOld = manager.trackSocket(original.id); await manager.remove(original.id); await manager.create(spec(original.id)); const releaseNew = manager.trackSocket(original.id);
      releaseOld(); releaseOld(); await manager.reap(Date.now() + 16 * 60_000); expect(manager.get(original.id)).toBeDefined(); expect(remove).toHaveBeenCalledTimes(1);
      releaseNew(); releaseNew(); await manager.reap(Date.now() + 16 * 60_000); expect(manager.get(original.id)).toBeUndefined(); expect(remove).toHaveBeenCalledTimes(2);
    } finally { manager.close(); }
  });

  it('does not expose a sandbox for upgrade while idle removal is in progress', async () => {
    const stale = record(spec('stale-id')); let finish!: () => void; let started!: () => void;
    const removing = new Promise<void>((resolve) => { finish = resolve; }); const began = new Promise<void>((resolve) => { started = resolve; });
    const manager = new SandboxManager({ list: async () => [stale], create: vi.fn(), remove: async () => { started(); await removing; }, removeWorkspace: vi.fn(), exec: vi.fn() } as any);
    await manager.start(); try { const reap = manager.reap(Date.now() + 16 * 60_000); await began; expect(manager.get(stale.id)).toBeUndefined(); finish(); await reap; } finally { finish(); manager.close(); }
  });

  it('removes a stopped record before deleting its attempt workspace', async () => {
    const stopped = { ...record({ ...spec('stopped-id'), kind: 'ai-coding', attemptNumber: 3 }), status: 'stopped' as const };
    const order: string[] = []; const driver = { list: vi.fn(async () => [stopped]), create: vi.fn(), remove: vi.fn(async () => { order.push('record'); }), removeWorkspace: vi.fn(async () => { order.push('workspace'); }), exec: vi.fn() };
    const manager = new SandboxManager(driver as any); await manager.start(); try { await manager.removeWorkspace('course', 'stopped-id', 3); expect(order).toEqual(['record', 'workspace']); expect(manager.get(stopped.id)).toBeUndefined(); } finally { manager.close(); }
  });

  it('serializes workspace cleanup with create so no returned record references a deleted workspace', async () => {
    const stopped = { ...record({ ...spec('same'), kind: 'ai-coding', attemptNumber: 1 }), status: 'stopped' as const };
    let workspaceDeleted = false; const driver = { list: vi.fn(async () => [stopped]), remove: vi.fn(), removeWorkspace: vi.fn(async () => { workspaceDeleted = true; }), create: vi.fn(async (value: SandboxCreateSpec) => { expect(workspaceDeleted).toBe(true); return record(value); }), exec: vi.fn() };
    const manager = new SandboxManager(driver as any); await manager.start(); try { const cleanup = manager.removeWorkspace('course', 'same', 1); const created = manager.create({ ...spec('new-id'), kind: 'ai-coding', courseId: 'course', drillId: 'same', attemptNumber: 2 }); await cleanup; expect((await created).status).toBe('running'); } finally { manager.close(); }
  });
});

describe('sandboxd transport cap', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.RUNNER_SANDBOX_DRIVER; delete process.env.SANDBOXD_URL; delete process.env.SANDBOXD_TOKEN; });
  it('preserves the AI volume when a newly created remote sandbox never becomes ready', async () => {
    vi.useFakeTimers(); process.env.RUNNER_SANDBOX_DRIVER = 'podman'; process.env.SANDBOXD_URL = 'http://sandboxd.test'; process.env.SANDBOXD_TOKEN = 'a'.repeat(64); const requests: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); requests.push({ url, method: init?.method }); if (url === 'http://sandboxd.test/sandboxes' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'ai-test-1234', target: 'http://editor.test' }), { status: 201 }); if (url === 'http://sandboxd.test/sandboxes/ai-test-1234' && init?.method === 'DELETE') return new Response('{}'); return new Response('', { status: 503 }); }));
    const manager = SandboxManager.fromEnvironment(); const pending = manager.create({ ...spec('ai-test-1234'), kind: 'ai-coding', attemptNumber: 1 }); const result = pending.catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(10_100); expect(await result).toMatchObject({ status: 503 }); expect(requests).toContainEqual({ url: 'http://sandboxd.test/sandboxes/ai-test-1234', method: 'DELETE' }); expect(requests.some((request) => request.method === 'DELETE' && request.url.includes('volume=1'))).toBe(false); manager.close();
  });
  it('aborts an oversized sandboxd exec response while streaming', async () => {
    process.env.RUNNER_SANDBOX_DRIVER = 'podman'; process.env.SANDBOXD_URL = 'http://sandboxd.test'; process.env.SANDBOXD_TOKEN = 'a'.repeat(64);
    const chunk = new Uint8Array(1024 * 1024); vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { for (let index = 0; index < 6; index++) controller.enqueue(chunk); controller.close(); } }), { status: 200 })));
    const manager = SandboxManager.fromEnvironment(); await expect(manager.exec('sandbox', { action: 'run', args: [] })).rejects.toThrow('byte limit');
  });
});
