// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { exportTrees, importLegacy, legacyVolumeKey } from './importLegacy';
import { deleteTree, listTrees, loadTree, migrateUserDb, openUserDb, packTree, readTree, saveTree, unpackTree, USER_DB_VERSION, userDbVersion, workspaceExcluded, type UserDb } from './userData';

const roots: string[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'user-data-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { try { execFileSync('chmod', ['-R', 'u+rwX', root]); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); } });
function legacyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE progress (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));
    CREATE TABLE drill_attempts (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, content_revision INTEGER);
    INSERT INTO progress VALUES ('course', 'one', 'done', 'note', '2026-01-01'), ('course', 'two', 'in-progress', NULL, '2026-01-02');
    INSERT INTO drill_attempts VALUES ('course', 'one', 1, 7), ('course', 'one', 2, NULL), ('course', 'two', 1, 12);`);
  db.close();
}
function sampleTree(root: string): void {
  mkdirSync(join(root, 'src/empty'), { recursive: true }); writeFileSync(join(root, 'src/index.ts'), 'export const value = 1;\n'); writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 }); chmodSync(join(root, 'run.sh'), 0o755);
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 1, 254])); symlinkSync('/opt/ir/node_modules', join(root, 'node_modules'));
}

describe('user database migrations', () => {
  it('upgrades a legacy file in place after writing a backup, and is a no-op afterwards', () => {
    const root = temp(); const path = join(root, 'runner.sqlite'); legacyDb(path); const db = new DatabaseSync(path) as unknown as UserDb;
    expect(userDbVersion(db)).toBe(0);
    const result = migrateUserDb(db, path, { now: new Date('2026-11-18T02:03:04.567Z') });
    expect(result).toEqual({ from: 0, to: USER_DB_VERSION, backup: `${path}.backup-v0-20261118T020304Z` }); expect(userDbVersion(db)).toBe(USER_DB_VERSION);
    const backup = new DatabaseSync(result.backup!, { readOnly: true }); expect(backup.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 }); expect(backup.prepare('SELECT count(*) AS count FROM progress').get()).toMatchObject({ count: 2 }); expect(backup.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'stored_tree'").get()).toMatchObject({ count: 0 }); backup.close();
    expect(db.prepare('SELECT content_revision FROM drill_attempts ORDER BY course_id, drill_id, attempt_number').all().map((row: any) => row.content_revision)).toEqual([7, null, 12]);
    expect(migrateUserDb(db, path)).toEqual({ from: USER_DB_VERSION, to: USER_DB_VERSION }); expect(readdirSync(root).filter((name) => name.includes('backup'))).toHaveLength(1); db.close?.();
  });
  it('creates a fresh database without a backup', async () => {
    const root = temp(); const path = join(root, 'runner.sqlite'); const db = await openUserDb(path);
    expect(userDbVersion(db)).toBe(USER_DB_VERSION); expect(readdirSync(root)).toEqual(['runner.sqlite']); db.close?.();
  });
  it('refuses a database written by a newer build and leaves it untouched', async () => {
    const root = temp(); const path = join(root, 'runner.sqlite'); const db = new DatabaseSync(path); db.exec(`CREATE TABLE progress (id INTEGER); PRAGMA user_version = ${USER_DB_VERSION + 1}`); db.close(); const before = readFileSync(path);
    await expect(openUserDb(path)).rejects.toThrow(`schema version ${USER_DB_VERSION + 1}, but this interview-runner build supports up to ${USER_DB_VERSION}`);
    expect(readFileSync(path).equals(before)).toBe(true); expect(readdirSync(root)).toEqual(['runner.sqlite']);
  });
});

describe('stored file trees', () => {
  it('round-trips files, modes, empty directories and symbolic links, and skips unchanged saves', async () => {
    const root = temp(); const source = join(root, 'source'); mkdirSync(source); sampleTree(source); const db = await openUserDb(join(root, 'runner.sqlite'));
    expect(packTree(db, 'workspace', 'course/drill', source)).toBe(true); expect(packTree(db, 'workspace', 'course/drill', source)).toBe(false);
    expect(listTrees(db)).toMatchObject([{ kind: 'workspace', key: 'course/drill', entries: 6, files: 3, bytes: 38 }]);
    const restored = join(root, 'restored'); expect(unpackTree(db, 'workspace', 'course/drill', restored)).toBe(true);
    execFileSync('diff', ['-r', '--no-dereference', source, restored]); expect(readlinkSync(join(restored, 'node_modules'))).toBe('/opt/ir/node_modules'); expect(statSync(join(restored, 'run.sh')).mode & 0o777).toBe(0o755); expect(statSync(join(restored, 'src/empty')).isDirectory()).toBe(true);
    writeFileSync(join(source, 'src/index.ts'), 'export const value = 2;\n'); rmSync(join(source, 'binary.bin')); expect(packTree(db, 'workspace', 'course/drill', source)).toBe(true); expect(loadTree(db, 'workspace', 'course/drill')!.map((entry) => entry.path)).not.toContain('binary.bin');
    expect(unpackTree(db, 'workspace', 'course/other', join(root, 'none'))).toBe(false); expect(existsSync(join(root, 'none'))).toBe(false); expect(packTree(db, 'workspace', 'course/other', join(root, 'missing'))).toBe(false);
    expect(deleteTree(db, 'workspace', 'course/drill')).toBe(true); expect(listTrees(db)).toEqual([]); expect(db.prepare('SELECT count(*) AS count FROM stored_file').get()).toMatchObject({ count: 0 }); db.close?.();
  });
  it('excludes the sandbox Git pointer from coding workspaces and rejects unsafe stored paths', async () => {
    const root = temp(); const source = join(root, 'source'); mkdirSync(join(source, 'nested'), { recursive: true }); writeFileSync(join(source, '.git'), 'gitdir: /opt/ir/workspace-git\n'); writeFileSync(join(source, 'nested/.git'), 'kept');
    expect(readTree(source, workspaceExcluded).map((entry) => entry.path)).toEqual(['nested', 'nested/.git']);
    const db = await openUserDb(':memory:'); const file = { type: 'file' as const, mode: 0o644, mtimeMs: 0, content: Buffer.from('x') };
    for (const path of ['../escape', '/absolute', 'a/../b', 'a\\b', '']) expect(() => saveTree(db, 'workspace', 'k', [{ ...file, path }])).toThrow('Unsafe stored path');
    expect(() => saveTree(db, 'workspace', 'k', [{ ...file, type: 'symlink', path: 'link', content: Buffer.from('/etc') }, { ...file, path: 'link/passwd' }])).toThrow('below a symbolic link'); expect(listTrees(db)).toEqual([]); db.close?.();
  });
});

describe('legacy import', () => {
  it('parses only unambiguous legacy AI volume names', () => {
    expect(legacyVolumeKey('ir-ws-course-one--drill-one--3')).toBe('course-one/drill-one/3');
    for (const name of ['ir-ws-a--b--c--1', 'ir-ws-a--b', 'ir-x-ws-a--b--1', 'ir-ws-a--b--0', 'other']) expect(legacyVolumeKey(name)).toBeUndefined();
  });
  it('builds the single database from the old layout, keeps the inputs untouched and can be re-run', async () => {
    const root = temp(); const old = join(root, 'progress.db'); legacyDb(old); const before = readFileSync(old);
    const ui = join(root, 'ui'); mkdirSync(join(ui, 'drills/course'), { recursive: true }); writeFileSync(join(ui, 'layout.json'), '{}'); writeFileSync(join(ui, 'drills/course/one.json'), '{"editors":[]}');
    const managed = join(root, 'managed'); const workspace = join(managed, 'workspaces/course/one'); mkdirSync(workspace, { recursive: true }); sampleTree(workspace); writeFileSync(join(workspace, '.git'), 'gitdir: /opt/ir/workspace-git\n'); mkdirSync(join(managed, 'workspaces/Bad_Course/one'), { recursive: true });
    const git = join(root, 'git'); mkdirSync(join(git, 'course/one.git/refs/heads'), { recursive: true }); writeFileSync(join(git, 'course/one.git/HEAD'), 'ref: refs/heads/main\n');
    const volumes = join(root, 'volumes'); mkdirSync(join(volumes, 'ir-ws-course--two--1/.git'), { recursive: true }); writeFileSync(join(volumes, 'ir-ws-course--two--1/mywork.md'), 'work'); mkdirSync(join(volumes, 'unrelated'));
    const out = join(root, 'new/runner.sqlite'); mkdirSync(join(root, 'new'));
    const summary = await importLegacy({ progressDb: old, out, uiState: ui, managed, workspaceGit: git, aiVolumes: volumes });
    expect(summary.tables).toEqual({ progress: { old: 2, new: 2 }, drill_attempts: { old: 3, new: 3 } }); expect(summary.schemaVersion).toBe(USER_DB_VERSION);
    expect(summary.trees).toMatchObject({ 'ui-state': { trees: 1, files: 2 }, workspace: { trees: 1, files: 3 }, 'workspace-git': { trees: 1, files: 1 }, 'ai-workspace': { trees: 1, files: 1 } }); expect(summary.skipped).toEqual(['workspace Bad_Course/one', 'ai-volume unrelated']);
    expect(readFileSync(old).equals(before)).toBe(true); expect(readdirSync(join(root, 'new'))).toEqual(['runner.sqlite']);
    const db = new DatabaseSync(out, { readOnly: true }); expect(db.prepare('SELECT content_revision FROM drill_attempts ORDER BY course_id, drill_id, attempt_number').all().map((row: any) => row.content_revision)).toEqual([7, null, 12]); expect(listTrees(db as unknown as UserDb).map((tree) => `${tree.kind}:${tree.key}`)).toEqual(['ai-workspace:course/two/1', 'ui-state:', 'workspace:course/one', 'workspace-git:course/one']); db.close();
    const exported = join(root, 'exported'); expect(await exportTrees(out, exported)).toMatchObject({ trees: 4, files: 7 });
    execFileSync('diff', ['-r', '--no-dereference', ui, join(exported, 'ui-state')]); execFileSync('diff', ['-r', '--no-dereference', join(git, 'course/one.git'), join(exported, 'workspace-git/course/one')]); execFileSync('diff', ['-r', '--no-dereference', '--exclude=.git', workspace, join(exported, 'workspace/course/one')]); expect(existsSync(join(exported, 'workspace/course/one/.git'))).toBe(false); execFileSync('diff', ['-r', join(volumes, 'ir-ws-course--two--1'), join(exported, 'ai-workspace/course/two/1')]);
    await expect(importLegacy({ progressDb: old, out })).rejects.toThrow('already exists'); await expect(importLegacy({ progressDb: out, out: join(root, 'other.sqlite') })).rejects.toThrow('not a legacy progress.db');
    // Cutover: later writes to the old database are picked up by rebuilding from a fresh copy.
    const later = new DatabaseSync(old); later.exec("INSERT INTO progress VALUES ('course', 'three', 'done', NULL, '2026-01-03')"); later.close(); writeFileSync(join(workspace, 'late.txt'), 'late');
    const again = await importLegacy({ progressDb: old, out, managed, force: true }); expect(again.tables.progress).toEqual({ old: 3, new: 3 }); expect(again.trees.workspace.files).toBe(4); expect(again.trees['ui-state'].trees).toBe(0); expect(readdirSync(join(root, 'new'))).toEqual(['runner.sqlite']);
  });
  it('never replaces or deletes an input that the output aliases, and stages in a private directory', async () => {
    const root = temp(); const real = join(root, 'real'); mkdirSync(real); symlinkSync(real, join(root, 'alias')); const old = join(real, 'progress.db'); legacyDb(old); const before = readFileSync(old);
    const untouched = () => { expect(readFileSync(old).equals(before)).toBe(true); const db = new DatabaseSync(old, { readOnly: true }); expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 }); db.close(); };
    // The same file reached through a symlinked parent, a symlink to the file itself, a hard link, and a journal name.
    await expect(importLegacy({ progressDb: old, out: join(root, 'alias/progress.db'), force: true })).rejects.toThrow('must not be the old progress.db'); untouched();
    symlinkSync(old, join(root, 'link.db')); await expect(importLegacy({ progressDb: join(root, 'link.db'), out: old, force: true })).rejects.toThrow('must not be the old progress.db'); untouched();
    linkSync(old, join(root, 'hard.db')); await expect(importLegacy({ progressDb: old, out: join(root, 'hard.db'), force: true })).rejects.toThrow('must not be the old progress.db'); untouched();
    await expect(importLegacy({ progressDb: old, out: `${old}-journal`, force: true })).rejects.toThrow('must not be the old progress.db'); untouched();
    // The output may not land inside an input tree (also through an alias), where it would be imported into itself or replace input files.
    const ui = join(real, 'ui'); mkdirSync(ui); writeFileSync(join(ui, 'layout.json'), '{}');
    await expect(importLegacy({ progressDb: old, out: join(root, 'alias/ui/new.sqlite'), uiState: ui })).rejects.toThrow('must be outside --ui-state'); expect(readdirSync(ui)).toEqual(['layout.json']);
    await expect(importLegacy({ progressDb: old, out: join(root, 'missing/new.sqlite') })).rejects.toThrow('Output directory does not exist'); mkdirSync(join(root, 'dir.sqlite')); await expect(importLegacy({ progressDb: old, out: join(root, 'dir.sqlite'), force: true })).rejects.toThrow('not a regular file');
    // A source that happens to carry the old fixed staging name is read, never deleted; failed and successful runs leave no staging behind.
    const staged = join(root, 'result.sqlite.importing'); legacyDb(staged); const stagedBefore = readFileSync(staged);
    const summary = await importLegacy({ progressDb: staged, out: join(root, 'result.sqlite') }); expect(summary.tables.progress).toEqual({ old: 2, new: 2 }); expect(readFileSync(staged).equals(stagedBefore)).toBe(true);
    await expect(importLegacy({ progressDb: join(root, 'result.sqlite'), out: join(root, 'other.sqlite') })).rejects.toThrow('not a legacy progress.db');
    expect(readdirSync(root).filter((name) => name.startsWith('.import-'))).toEqual([]); expect(existsSync(join(root, 'other.sqlite'))).toBe(false); untouched();
  });
});
