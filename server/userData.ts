import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { configureSqliteBusyTimeout } from './sqlite';

// The single user database (RUNNER_DB_PATH) holds the progress tables plus the file trees that used to live
// on host directories and named volumes. PRAGMA user_version is its schema version: 0 is a legacy progress.db
// (or an empty file); each entry in `migrations` moves it up by one.
export type UserDb = { exec(sql: string): void; prepare(sql: string): any; close?(): void };
export type TreeKind = 'ui-state' | 'workspace' | 'workspace-git' | 'ai-workspace';
export type TreeEntry = { path: string; type: 'file' | 'dir' | 'symlink'; mode: number; mtimeMs: number; content: Buffer };
export const treeKinds: readonly TreeKind[] = ['ui-state', 'workspace', 'workspace-git', 'ai-workspace'];

const migrations: Array<(db: UserDb) => void> = [
  // 1: file trees. kind + key name one tree: ui-state '' | workspace 'course/drill' | workspace-git 'course/drill' | ai-workspace 'course/drill/attempt'.
  (db) => db.exec(`CREATE TABLE stored_tree (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('ui-state','workspace','workspace-git','ai-workspace')), key TEXT NOT NULL, saved_at TEXT NOT NULL, signature TEXT NOT NULL, entry_count INTEGER NOT NULL, file_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, UNIQUE (kind, key));
    CREATE TABLE stored_file (tree_id INTEGER NOT NULL REFERENCES stored_tree(id) ON DELETE CASCADE, path TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('file','dir','symlink')), mode INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY (tree_id, path)) WITHOUT ROWID;`),
];
export const USER_DB_VERSION = migrations.length;

export function userDbVersion(db: UserDb): number { return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); }
function stamp(date = new Date()): string { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

/**
 * Applies pending numbered migrations. Before the first change to an existing file it writes a consistent
 * copy (`<db>.backup-v<from>-<UTC timestamp>`) next to it, or in `backupDir` when given, and it refuses a file newer than this build.
 */
export function migrateUserDb(db: UserDb, path: string, options: { backup?: boolean; backupDir?: string; now?: Date } = {}): { from: number; to: number; backup?: string } {
  const from = userDbVersion(db);
  if (from > USER_DB_VERSION) throw new Error(`User database ${path} has schema version ${from}, but this interview-runner build supports up to ${USER_DB_VERSION}. Upgrade interview-runner, or restore a backup written by the older build; refusing to start.`);
  if (from === USER_DB_VERSION) return { from, to: from };
  let backup: string | undefined;
  const populated = Number((db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count: number }).count) > 0;
  if (options.backup !== false && path !== ':memory:' && populated) {
    if (options.backupDir) mkdirSync(options.backupDir, { recursive: true });
    backup = `${options.backupDir ? join(options.backupDir, basename(path)) : path}.backup-v${from}-${stamp(options.now)}`; if (existsSync(backup)) backup = `${backup}-${process.pid}`;
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process (runner and sandboxd share the file) may have migrated while this one waited for the lock.
    for (let version = userDbVersion(db); version < USER_DB_VERSION; version++) { migrations[version]!(db); db.exec(`PRAGMA user_version = ${version + 1}`); }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { from, to: USER_DB_VERSION, ...(backup ? { backup } : {}) };
}

/** Keeps the database writable by the runner (uid of /data) when a root process such as sandboxd created or journalled it. */
export function alignDbOwnership(path: string): void {
  if (path === ':memory:' || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  try { const owner = statSync(dirname(path)); for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) { try { const info = statSync(file); if (info.uid !== owner.uid || info.gid !== owner.gid) chownSync(file, owner.uid, owner.gid); } catch { /* absent sidecar */ } } } catch { /* best effort */ }
}

export async function openUserDb(path: string, options: { backup?: boolean } = {}): Promise<UserDb> {
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path) as unknown as UserDb;
  configureSqliteBusyTimeout(db); db.exec('PRAGMA foreign_keys = ON');
  try { migrateUserDb(db, path, options); } catch (error) { db.close?.(); throw error; }
  alignDbOwnership(path); return db;
}

function safePath(path: string): boolean { return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part && part !== '.' && part !== '..'); }
function checkEntries(entries: readonly TreeEntry[]): void {
  const links = new Set(entries.filter((entry) => entry.type === 'symlink').map((entry) => entry.path));
  for (const entry of entries) {
    if (!safePath(entry.path)) throw new Error(`Unsafe stored path: ${entry.path}`);
    const parts = entry.path.split('/'); for (let index = 1; index < parts.length; index++) if (links.has(parts.slice(0, index).join('/'))) throw new Error(`Stored path is below a symbolic link: ${entry.path}`);
  }
}

/** Reads a directory without following symbolic links. `exclude` receives the tree-relative path. */
export function readTree(root: string, exclude: (path: string) => boolean = () => false): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${item.name}`; if (exclude(path)) continue; const absolute = join(directory, item.name); const info = lstatSync(absolute); const base = { path, mode: info.mode & 0o7777, mtimeMs: Math.round(info.mtimeMs) };
      if (info.isSymbolicLink()) entries.push({ ...base, type: 'symlink', content: Buffer.from(readlinkSync(absolute)) });
      else if (info.isDirectory()) { entries.push({ ...base, type: 'dir', content: Buffer.alloc(0) }); walk(absolute, `${path}/`); }
      else if (info.isFile()) entries.push({ ...base, type: 'file', content: readFileSync(absolute) });
    }
  };
  walk(root, ''); return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Writes entries below `root`, creating it. Existing files at the same paths are replaced; nothing else is removed. */
export function writeTree(root: string, entries: readonly TreeEntry[], owner?: { uid: number; gid: number }): void {
  checkEntries(entries); mkdirSync(root, { recursive: true }); if (owner) chownSync(root, owner.uid, owner.gid);
  const directories: TreeEntry[] = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const target = join(root, entry.path);
    if (entry.type === 'dir') { mkdirSync(target, { recursive: true }); directories.push(entry); }
    else { mkdirSync(dirname(target), { recursive: true }); rmSync(target, { force: true, recursive: true }); if (entry.type === 'symlink') symlinkSync(entry.content.toString(), target); else { writeFileSync(target, entry.content, { mode: entry.mode }); chmodSync(target, entry.mode); utimesSync(target, entry.mtimeMs / 1000, entry.mtimeMs / 1000); } }
    if (owner) { try { (entry.type === 'symlink' ? lchownSync : chownSync)(target, owner.uid, owner.gid); } catch { /* best effort */ } }
  }
  // Directory modes last, so a read-only directory does not block writing its children.
  for (const entry of directories.reverse()) chmodSync(join(root, entry.path), entry.mode);
}

export function treeSignature(entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256'); for (const entry of entries) hash.update(`${entry.path}\0${entry.type}\0${entry.mode}\0${entry.content.length}\0`).update(entry.content).update('\0'); return hash.digest('hex');
}

export type TreeSummary = { kind: TreeKind; key: string; savedAt: string; signature: string; entries: number; files: number; bytes: number };
/** Replaces one stored tree atomically. Returns false when the stored copy already has the same content. */
export function saveTree(db: UserDb, kind: TreeKind, key: string, entries: readonly TreeEntry[], now = new Date()): boolean {
  checkEntries(entries); const signature = treeSignature(entries);
  const existing = db.prepare('SELECT id, signature FROM stored_tree WHERE kind = ? AND key = ?').get(kind, key) as { id: number; signature: string } | undefined;
  if (existing?.signature === signature) return false;
  const files = entries.filter((entry) => entry.type === 'file'); const bytes = files.reduce((total, entry) => total + entry.content.length, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (existing) { db.prepare('DELETE FROM stored_file WHERE tree_id = ?').run(existing.id); db.prepare('DELETE FROM stored_tree WHERE id = ?').run(existing.id); }
    const id = Number((db.prepare('INSERT INTO stored_tree (kind, key, saved_at, signature, entry_count, file_count, total_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(kind, key, now.toISOString(), signature, entries.length, files.length, bytes) as { lastInsertRowid: number | bigint }).lastInsertRowid);
    const insert = db.prepare('INSERT INTO stored_file (tree_id, path, type, mode, mtime_ms, content) VALUES (?, ?, ?, ?, ?, ?)');
    for (const entry of entries) insert.run(id, entry.path, entry.type, entry.mode, entry.mtimeMs, entry.content);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
export function loadTree(db: UserDb, kind: TreeKind, key: string): TreeEntry[] | undefined {
  const tree = db.prepare('SELECT id FROM stored_tree WHERE kind = ? AND key = ?').get(kind, key) as { id: number } | undefined; if (!tree) return undefined;
  return (db.prepare('SELECT path, type, mode, mtime_ms, content FROM stored_file WHERE tree_id = ? ORDER BY path').all(tree.id) as Array<{ path: string; type: TreeEntry['type']; mode: number; mtime_ms: number; content: Uint8Array }>).map((row) => ({ path: row.path, type: row.type, mode: Number(row.mode), mtimeMs: Number(row.mtime_ms), content: Buffer.from(row.content) }));
}
export function deleteTree(db: UserDb, kind: TreeKind, key: string): boolean {
  const tree = db.prepare('SELECT id FROM stored_tree WHERE kind = ? AND key = ?').get(kind, key) as { id: number } | undefined; if (!tree) return false;
  db.exec('BEGIN IMMEDIATE'); try { db.prepare('DELETE FROM stored_file WHERE tree_id = ?').run(tree.id); db.prepare('DELETE FROM stored_tree WHERE id = ?').run(tree.id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
export function listTrees(db: UserDb, kind?: TreeKind): TreeSummary[] {
  const rows = (kind ? db.prepare('SELECT * FROM stored_tree WHERE kind = ? ORDER BY kind, key').all(kind) : db.prepare('SELECT * FROM stored_tree ORDER BY kind, key').all()) as Array<{ kind: TreeKind; key: string; saved_at: string; signature: string; entry_count: number; file_count: number; total_bytes: number }>;
  return rows.map((row) => ({ kind: row.kind, key: row.key, savedAt: row.saved_at, signature: row.signature, entries: Number(row.entry_count), files: Number(row.file_count), bytes: Number(row.total_bytes) }));
}
/** Stores a directory; a missing directory is not stored. */
export function packTree(db: UserDb, kind: TreeKind, key: string, directory: string, exclude?: (path: string) => boolean): boolean {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return false; return saveTree(db, kind, key, readTree(directory, exclude));
}
/** Restores a stored tree into `directory`. Returns false when nothing is stored for it. */
export function unpackTree(db: UserDb, kind: TreeKind, key: string, directory: string, owner?: { uid: number; gid: number }): boolean {
  const entries = loadTree(db, kind, key); if (!entries) return false; writeTree(directory, entries, owner); return true;
}
/** A coding workspace's `.git` is a per-sandbox pointer that sandboxd recreates; its history is the separate workspace-git tree. */
export const workspaceExcluded = (path: string): boolean => path === '.git';
