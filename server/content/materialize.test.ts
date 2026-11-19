// @vitest-environment node
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openContentDb, type ContentDb } from './contentDb';
import { sha256 } from './bundle';
import { codingWorkspace, gcMaterialized, managedStateRoot, materializeCourse, prepareCodingWorkspace, setCodingWorkspaceRestorer } from './materialize';

const roots: string[] = []; const databases: ContentDb[] = [];
afterEach(async () => { databases.splice(0).forEach((db) => db.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'materialize-test-')); roots.push(root);
  const db = await openContentDb(':memory:'); databases.push(db);
  db.prepare("INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES('course','ns','course','Course','now','now',1,'{}')").run();
  const publish = (revision: number, files: Record<string, { bytes: string; mode: number }>) => {
    const entries: Record<string, { sha256: string; size: number; mode: number }> = {};
    for (const [path, file] of Object.entries(files)) {
      const bytes = Buffer.from(file.bytes); const hash = sha256(bytes);
      db.prepare('INSERT OR IGNORE INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now');
      entries[path] = { sha256: hash, size: bytes.length, mode: file.mode };
    }
    db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run('course', revision, JSON.stringify({ manifest: {}, files: entries }), 'now');
    db.prepare('UPDATE course SET revision=? WHERE id=?').run(revision, 'course');
  };
  return { root, db, publish };
}
const path = 'drills/course/drill/';
const files = { [`${path}source.ts`]: { bytes: 'source', mode: 0o755 }, [`${path}source.test.ts`]: { bytes: 'test v1', mode: 0o644 }, [`${path}.seed.ts`]: { bytes: 'seed v1', mode: 0o644 }, 'guides/course/rubric.md': { bytes: 'guide', mode: 0o600 }, 'images/unused.png': { bytes: 'image', mode: 0o644 } };

describe('content revision materialization', () => {
  it('publishes atomically, is idempotent and removes write bits while retaining execute bits', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const [a, b] = await Promise.all([materializeCourse(db, 'course', 1, root), materializeCourse(db, 'course', 1, root)]);
    expect(a).toBe(b); expect(await readFile(join(a, `${path}source.ts`), 'utf8')).toBe('source');
    expect((await stat(join(a, `${path}source.ts`))).mode & 0o777).toBe(0o555);
    expect((await stat(join(a, 'guides/course/rubric.md'))).mode & 0o777).toBe(0o400);
    expect(await readdir(join(root, 'materialized/course'))).toEqual(['1']);
    await expect(materializeCourse(db, 'course', 99, root)).rejects.toThrow('Unknown content revision');
  });
  it('does not publish a partial revision when a blob is missing', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    db.prepare('DELETE FROM blob WHERE sha256=?').run(sha256(Buffer.from('test v1')));
    await expect(materializeCourse(db, 'course', 1, root)).rejects.toThrow('Missing or invalid content blob');
    expect(await readdir(join(root, 'materialized/course'))).toEqual([]);
  });
  it('replaces foreign or unstamped revisions with the current database bundle', async () => {
    const first = await fixture(); const second = await fixture(); first.publish(1, files);
    second.publish(1, { ...files, [`${path}source.ts`]: { bytes: 'other database', mode: 0o644 } });
    const directory = await materializeCourse(first.db, 'course', 1, first.root);
    await materializeCourse(second.db, 'course', 1, first.root);
    expect(await readFile(join(directory, `${path}source.ts`), 'utf8')).toBe('other database');
    await rm(join(directory, '.bundle-sha256'));
    await materializeCourse(first.db, 'course', 1, first.root);
    expect(await readFile(join(directory, `${path}source.ts`), 'utf8')).toBe('source');
  });
  it('evicts cached revisions and repairs missing required files', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const required = `${path}source.test.ts`; const directory = await materializeCourse(db, 'course', 1, root, required);
    await materializeCourse(db, 'course', 1, root, required);
    await rm(join(directory, required));
    expect(await materializeCourse(db, 'course', 1, root, required)).toBe(directory);
    expect(await readFile(join(directory, required), 'utf8')).toBe('test v1');
    await rm(join(directory, required));
    const workspace = await prepareCodingWorkspace({ db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [required] });
    expect(await readFile(join(workspace, 'source.test.ts'), 'utf8')).toBe('test v1');
  });
  it('does not follow a symlink introduced after a revision was cached', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const required = `${path}source.test.ts`; const directory = await materializeCourse(db, 'course', 1, root, required);
    const outside = join(root, 'outside'); await writeFile(outside, 'untouched');
    await rm(join(directory, required)); await symlink(outside, join(directory, required));
    await expect(materializeCourse(db, 'course', 1, root, required)).rejects.toThrow('symbolic link');
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });
  it('retains the old tree if a mismatching bundle cannot be materialized', async () => {
    const first = await fixture(); const second = await fixture(); first.publish(1, files);
    second.publish(1, { ...files, [`${path}source.ts`]: { bytes: 'other database', mode: 0o644 } });
    const directory = await materializeCourse(first.db, 'course', 1, first.root);
    second.db.prepare('DELETE FROM blob WHERE sha256=?').run(sha256(Buffer.from('other database')));
    await expect(materializeCourse(second.db, 'course', 1, first.root)).rejects.toThrow('Missing or invalid content blob');
    expect(await readFile(join(directory, `${path}source.ts`), 'utf8')).toBe('source');
  });
  it('isolates default development managed state and honors explicit XDG state', () => {
    const old = { ...process.env };
    try {
      delete process.env.XDG_STATE_HOME; delete process.env.RUNNER_ACCESS_MODE; delete process.env.NODE_ENV;
      expect(managedStateRoot()).toBe(join(process.cwd(), '.state/interview-runner/managed'));
      process.env.RUNNER_ACCESS_MODE = 'tailnet'; expect(managedStateRoot()).toBe(join(homedir(), '.local/state/interview-runner/managed'));
      process.env.XDG_STATE_HOME = '/test-state'; expect(managedStateRoot()).toBe('/test-state/interview-runner/managed');
    } finally { process.env = old; }
  });
  it('seeds once and refreshes only tests and seed files on concurrent opens and republish', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const options = { db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [`${path}source.test.ts`] };
    const [workspace, second] = await Promise.all([prepareCodingWorkspace(options), prepareCodingWorkspace(options)]);
    expect(workspace).toBe(second); expect(workspace).toBe(codingWorkspace('course', 'drill', root));
    await writeFile(join(workspace, 'source.ts'), 'learner');
    await rm(join(workspace, 'source.test.ts')); await writeFile(join(workspace, 'source.test.ts'), 'edited test');
    publish(2, { ...files, [`${path}source.test.ts`]: { bytes: 'test v2', mode: 0o644 }, [`${path}.seed.ts`]: { bytes: 'seed v2', mode: 0o644 } });
    await prepareCodingWorkspace({ ...options, revision: 2 });
    expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('learner');
    expect(await readFile(join(workspace, 'source.test.ts'), 'utf8')).toBe('test v2');
    expect(await readFile(join(workspace, '.seed.ts'), 'utf8')).toBe('seed v2');
  });
  it('restores a missing workspace from the stored copy instead of re-seeding, and never over an existing one', async () => {
    const { db, root, publish } = await fixture(); publish(1, files); const calls: string[] = [];
    setCodingWorkspaceRestorer((courseId, drillId, directory) => { calls.push(`${courseId}/${drillId}`); if (drillId !== 'drill') return false; writeFileSync(join(directory, 'source.ts'), 'stored work'); return true; });
    try {
      const options = { db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [`${path}source.test.ts`] };
      const workspace = await prepareCodingWorkspace(options); expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('stored work'); expect(await readFile(join(workspace, 'source.test.ts'), 'utf8')).toBe('test v1');
      await writeFile(join(workspace, 'source.ts'), 'newer work'); await prepareCodingWorkspace(options); expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('newer work'); expect(calls).toEqual(['course/drill']);
      expect((await readdir(join(root, 'workspaces/course'))).filter((name) => name.startsWith('.workspace-'))).toEqual([]);
    } finally { setCodingWorkspaceRestorer(undefined); }
  });
  it('restores or seeds an empty workspace directory instead of leaving it with only protected files', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const options = { db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [`${path}source.test.ts`] };
    const workspace = codingWorkspace('course', 'drill', root); await mkdir(workspace, { recursive: true });
    await prepareCodingWorkspace(options); expect(await readdir(workspace)).toEqual(expect.arrayContaining(['source.test.ts', 'source.ts'])); expect(await readFile(join(workspace, 'source.ts'), 'utf8')).not.toBe('stored work');
    await rm(workspace, { recursive: true }); await mkdir(workspace);
    setCodingWorkspaceRestorer((_course, _drill, directory) => { writeFileSync(join(directory, 'source.ts'), 'stored work'); return true; });
    try { await prepareCodingWorkspace(options); expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('stored work'); expect(await readFile(join(workspace, 'source.test.ts'), 'utf8')).toBe('test v1'); }
    finally { setCodingWorkspaceRestorer(undefined); }
  });
  it('seeds existing learner edits from a linked drill only once', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const linked = join(root, 'linked'); await mkdir(linked); await writeFile(join(linked, 'source.ts'), 'in progress');
    const options = { db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [`${path}source.test.ts`], linkedDrillPath: linked };
    const workspace = await prepareCodingWorkspace(options); expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('in progress');
    await writeFile(join(linked, 'source.ts'), 'later'); await prepareCodingWorkspace(options);
    expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('in progress');
  });
  it('refuses symlinked workspace paths rather than overwriting outside files', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const options = { db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [`${path}source.test.ts`] };
    const workspace = await prepareCodingWorkspace(options); const outside = join(root, 'outside'); await writeFile(outside, 'untouched');
    await rm(join(workspace, 'source.test.ts')); await symlink(outside, join(workspace, 'source.test.ts'));
    await expect(prepareCodingWorkspace(options)).rejects.toThrow('symbolic link');
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });
  it('breaks hard links before restoring protected file permissions', async () => {
    const { db, root, publish } = await fixture(); publish(1, files);
    const options = { db, stateRoot: root, courseId: 'course', drillId: 'drill', revision: 1, testPaths: [`${path}source.test.ts`] };
    const workspace = await prepareCodingWorkspace(options); const outside = join(root, 'outside'); await writeFile(outside, 'test v1'); await chmod(outside, 0o600);
    await rm(join(workspace, 'source.test.ts')); await link(outside, join(workspace, 'source.test.ts'));
    await prepareCodingWorkspace(options);
    expect((await stat(outside)).mode & 0o777).toBe(0o600); expect((await stat(join(workspace, 'source.test.ts'))).mode & 0o777).toBe(0o444);
  });
  it('collects only old, noncurrent, unreferenced revisions', async () => {
    const { db, root, publish } = await fixture();
    for (let revision = 1; revision <= 4; revision++) { publish(revision, files); await materializeCourse(db, 'course', revision, root); }
    const old = new Date(Date.now() - 31 * 86400_000);
    for (const revision of [1, 2, 4]) await utimes(join(root, 'materialized/course', String(revision)), old, old);
    await gcMaterialized(db, 'course', [2], Date.now(), root);
    expect((await readdir(join(root, 'materialized/course'))).sort()).toEqual(['2', '3', '4']);
  });
});
