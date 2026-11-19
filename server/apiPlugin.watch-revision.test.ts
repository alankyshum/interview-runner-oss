// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('rebuilds deterministic watchers on publish and executes the current renamed test', async () => {
  const state = await mkdtemp(join(tmpdir(), 'watch-revision-')); const previous = { ...process.env };
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; process.env.XDG_STATE_HOME = state; process.env.VITEST = '1';
  await mkdir(join(state, 'interview-runner')); await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} })); vi.resetModules(); let plugin: any; let releaseOld = () => {};
  try {
    const [{ default: apiPlugin }, { contentDatabase }, { sha256 }, { invalidateCourseCatalog }] = await Promise.all([import('./apiPlugin'), import('./content/reader'), import('./content/bundle'), import('./courses')]);
    const db = await contentDatabase(); const prefix = 'drills/course/drill/';
    const publish = (revision: number, test: string, notify = true) => {
      const manifest = { id: 'course', title: 'Course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'drill', title: 'Drill', contentType: 'coding', kind: 'logic', estMinutes: 1, sourcePath: `${prefix}source.ts`, testPath: `${prefix}${test}`, instructions: 'Implement it.' }] }] };
      const files: Record<string, { sha256: string; size: number; mode: number }> = {};
      for (const [path, content] of Object.entries({ [`${prefix}source.ts`]: 'export const value = 1;', [`${prefix}${test}`]: `test revision ${revision}` })) { const bytes = Buffer.from(content); const hash = sha256(bytes); db.prepare('INSERT OR IGNORE INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now'); files[path] = { sha256: hash, size: bytes.length, mode: 0o644 }; }
      if (revision === 1) db.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run('course', 'ns', 'course', 'Course', 'now', 'now', revision, JSON.stringify(manifest));
      else db.prepare('UPDATE course SET revision=?,manifest_json=? WHERE id=?').run(revision, JSON.stringify(manifest), 'course');
      db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run('course', revision, JSON.stringify({ manifest, files }), 'now'); db.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); if (notify) invalidateCourseCatalog();
    };
    publish(1, 'old.test.ts');
    const watched = new Map<string, { callback: (...args: any[]) => void; close: ReturnType<typeof vi.fn> }>();
    const factory = vi.fn((path: string, _options: object, callback: (...args: any[]) => void) => { const watcher = { callback, close: vi.fn(), on: vi.fn() }; watched.set(path, watcher); return watcher as any; });
    const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
    const runner = vi.fn(async (testPath: string, output: string) => { if (testPath.endsWith('old.test.ts')) await oldPending; await writeFile(output, JSON.stringify({ testResults: [{ name: testPath, status: 'passed', assertionResults: [{ fullName: basename(testPath), status: 'passed' }] }] })); });
    const manager = { all: () => [], close: () => {} }; plugin = apiPlugin({ sandboxManager: manager as any, watcherFactory: factory as any, runner });
    plugin.configureServer({ middlewares: { use: () => {} } } as any);
    const workspace = join(state, 'interview-runner/managed/workspaces/course/drill'); await vi.waitFor(() => expect(watched.has(workspace)).toBe(true)); const oldWatcher = watched.get(workspace)!;
    oldWatcher.callback('change', 'source.ts'); await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1)); expect(runner.mock.calls[0][0]).toBe(join(workspace, 'old.test.ts'));
    publish(2, 'new.test.ts'); await vi.waitFor(() => { expect(oldWatcher.close).toHaveBeenCalled(); expect(watched.get(workspace)).not.toBe(oldWatcher); });
    watched.get(workspace)!.callback('change', 'source.ts'); await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2)); expect(runner.mock.calls[1][0]).toBe(join(workspace, 'new.test.ts')); releaseOld();
    watched.get(workspace)!.callback('change', 'old.test.ts'); await new Promise((resolve) => setTimeout(resolve, 250)); expect(runner).toHaveBeenCalledTimes(2);
    const rows = (await import('./db')).getAllTestFiles(); expect(Object.keys(rows)).toHaveLength(1); expect(Object.keys(rows)[0]).toContain('/2/drills/course/drill/new.test.ts');
    const secondWatcher = watched.get(workspace)!; publish(3, 'latest.test.ts', false); secondWatcher.callback('change', 'source.ts');
    await vi.waitFor(() => { expect(secondWatcher.close).toHaveBeenCalled(); expect(runner).toHaveBeenCalledTimes(3); }); expect(runner.mock.calls[2][0]).toBe(join(workspace, 'latest.test.ts'));
  } finally { releaseOld(); plugin?.closeBundle?.(); for (const key of ['INTERVIEW_RUNNER_CONTENT_SOURCE', 'XDG_STATE_HOME', 'VITEST']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } vi.resetModules(); await rm(state, { recursive: true, force: true }); }
});
