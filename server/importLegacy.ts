import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { listTrees, loadTree, migrateUserDb, readTree, saveTree, treeSignature, workspaceExcluded, writeTree, type TreeKind, type UserDb } from './userData';

export type LegacyImportOptions = {
  /** Old progress.db (opened read-only). */ progressDb: string;
  /** New single user database to write. */ out: string;
  /** Old SANDBOX_UI_STATE_DIR. */ uiState?: string;
  /** Old managed state directory (contains workspaces/<course>/<drill>) or that workspaces directory itself. */ managed?: string;
  /** Old SANDBOX_SETTINGS_DIR/.workspace-git (contains <course>/<drill>.git). */ workspaceGit?: string;
  /** Directory of exported AI volumes: one sub-directory per volume, named ir-ws-<course>--<drill>--<attempt>. */ aiVolumes?: string;
  /** Replace an existing output file. */ force?: boolean;
};
export type LegacyImportSummary = { out: string; schemaVersion: number; tables: Record<string, { old: number; new: number }>; trees: Record<TreeKind, { trees: number; entries: number; files: number; bytes: number }>; skipped: string[] };

const identity = /^[a-z0-9][a-z0-9-]{0,99}$/;
const directories = (path: string) => readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
function tableCounts(db: UserDb): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  return Object.fromEntries(names.map((name) => [name, Number((db.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() as { count: number }).count)]));
}
/** Resolves symbolic links in the part of a path that exists, so two spellings of one location compare equal. */
function canonical(path: string): string { const absolute = resolve(path); if (existsSync(absolute)) return realpathSync(absolute); const parent = dirname(absolute); return parent === absolute ? absolute : join(canonical(parent), basename(absolute)); }
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/')); };
const sameFile = (a: string, b: string) => { try { const first = statSync(a); const second = statSync(b); return first.dev === second.dev && first.ino === second.ino; } catch { return false; } };
const sidecars = ['', '-journal', '-wal', '-shm'];

/** Parses a legacy AI volume name. Ids may contain single hyphens, so a name with extra `--` separators is ambiguous and rejected. */
export function legacyVolumeKey(name: string): string | undefined {
  const match = /^ir-ws-(.+)--(\d+)$/.exec(name); if (!match) return undefined; const parts = match[1]!.split('--');
  return parts.length === 2 && identity.test(parts[0]!) && identity.test(parts[1]!) && Number(match[2]) >= 1 ? `${parts[0]}/${parts[1]}/${Number(match[2])}` : undefined;
}

/**
 * Builds a new user database from the old layout. It never writes to its inputs: the old database is copied
 * with VACUUM INTO, and the result replaces `out` only after every check passed. Re-running it (with `force`)
 * from a fresher copy of the old data rebuilds the file from scratch, which is how a cutover picks up later writes.
 */
export async function importLegacy(options: LegacyImportOptions): Promise<LegacyImportSummary> {
  const skipped: string[] = [];
  if (!existsSync(options.progressDb)) throw new Error(`Old progress.db not found: ${resolve(options.progressDb)}`);
  const trees = Object.entries({ 'ui-state': options.uiState, managed: options.managed, 'workspace-git': options.workspaceGit, 'ai-volumes': options.aiVolumes }).filter((entry): entry is [string, string] => Boolean(entry[1]));
  for (const [name, path] of trees) if (!(existsSync(path) && statSync(path).isDirectory())) throw new Error(`--${name} is not a directory: ${path}`);
  // Compare real locations, not spellings: a symlinked parent or a hard link must not let the output replace an input.
  const source = canonical(options.progressDb); const out = canonical(options.out);
  if (!existsSync(dirname(out)) || !statSync(dirname(out)).isDirectory()) throw new Error(`Output directory does not exist: ${dirname(out)}`);
  for (const suffix of sidecars) for (const other of sidecars) if (`${out}${suffix}` === `${source}${other}` || sameFile(`${out}${suffix}`, `${source}${other}`)) throw new Error('The output must not be the old progress.db or one of its journal files');
  for (const [name, path] of trees) { const root = canonical(path); if (within(root, out) || within(root, source)) throw new Error(`The output and the old progress.db must be outside --${name} (${root})`); }
  if (existsSync(out) && !options.force) throw new Error(`${out} already exists; pass --force to rebuild it from the old data`);
  if (existsSync(out) && !lstatSync(out).isFile()) throw new Error(`${out} is not a regular file`);
  const { DatabaseSync } = await import('node:sqlite');
  // Stage in a fresh, exclusively created directory next to the output: nothing that already exists is opened, replaced or deleted before the result verified.
  const staging = mkdtempSync(join(dirname(out), '.import-')); const temporary = join(staging, 'user.sqlite');
  const old = new DatabaseSync(source, { readOnly: true }); let oldCounts: Record<string, number>;
  try { const version = Number((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); if (version !== 0) throw new Error(`${source} is not a legacy progress.db (schema version ${version})`); oldCounts = tableCounts(old as unknown as UserDb); old.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`); } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; } finally { old.close(); }
  const db = new DatabaseSync(temporary) as unknown as UserDb & { close(): void };
  try {
    db.exec('PRAGMA foreign_keys = ON'); const { to } = migrateUserDb(db, temporary, { backup: false });
    const expected = new Map<string, string>();
    const store = (kind: TreeKind, key: string, directory: string, exclude?: (path: string) => boolean) => { const entries = readTree(directory, exclude); saveTree(db, kind, key, entries); expected.set(`${kind}\0${key}`, treeSignature(entries)); };
    if (options.uiState) store('ui-state', '', options.uiState);
    if (options.managed) {
      const root = existsSync(join(options.managed, 'workspaces')) ? join(options.managed, 'workspaces') : options.managed;
      for (const course of directories(root)) for (const drill of directories(join(root, course))) { if (!identity.test(course) || !identity.test(drill)) { skipped.push(`workspace ${course}/${drill}`); continue; } store('workspace', `${course}/${drill}`, join(root, course, drill), workspaceExcluded); }
    }
    if (options.workspaceGit) for (const course of directories(options.workspaceGit)) for (const name of directories(join(options.workspaceGit, course))) { const drill = name.replace(/\.git$/, ''); if (!name.endsWith('.git') || !identity.test(course) || !identity.test(drill)) { skipped.push(`workspace-git ${course}/${name}`); continue; } store('workspace-git', `${course}/${drill}`, join(options.workspaceGit, course, name)); }
    if (options.aiVolumes) for (const name of directories(options.aiVolumes)) { const key = legacyVolumeKey(name); if (!key) { skipped.push(`ai-volume ${name}`); continue; } store('ai-workspace', key, join(options.aiVolumes, name)); }
    // Verify before publishing: every old table kept its row count, and every stored tree reads back byte-identical.
    const newCounts = tableCounts(db); const tables: LegacyImportSummary['tables'] = {};
    for (const [name, count] of Object.entries(oldCounts)) { tables[name] = { old: count, new: newCounts[name] ?? -1 }; if (newCounts[name] !== count) throw new Error(`Row count mismatch in ${name}: old ${count}, new ${newCounts[name]}`); }
    const totals = Object.fromEntries((['ui-state', 'workspace', 'workspace-git', 'ai-workspace'] as const).map((kind) => [kind, { trees: 0, entries: 0, files: 0, bytes: 0 }])) as LegacyImportSummary['trees'];
    const stored = listTrees(db); if (stored.length !== expected.size) throw new Error(`Stored ${stored.length} trees, expected ${expected.size}`);
    for (const tree of stored) { if (treeSignature(loadTree(db, tree.kind, tree.key)!) !== expected.get(`${tree.kind}\0${tree.key}`)) throw new Error(`Stored tree ${tree.kind} ${tree.key} does not match its source`); const total = totals[tree.kind]; total.trees++; total.entries += tree.entries; total.files += tree.files; total.bytes += tree.bytes; }
    if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') throw new Error('Integrity check failed for the new database');
    db.close(); for (const suffix of ['-journal', '-wal', '-shm']) rmSync(`${out}${suffix}`, { force: true }); renameSync(temporary, out);
    return { out, schemaVersion: to, tables, trees: totals, skipped };
  } catch (error) { try { db.close(); } catch { /* already closed */ } throw error; } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Writes every stored tree to `<directory>/<kind>/<key>`, for inspection, rollback or a round-trip check. */
export async function exportTrees(dbPath: string, directory: string): Promise<{ trees: number; files: number; bytes: number }> {
  if (existsSync(directory) && readdirSync(directory).length) throw new Error(`${directory} is not empty`);
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(dbPath, { readOnly: true }) as unknown as UserDb & { close(): void };
  try { const trees = listTrees(db); for (const tree of trees) writeTree(join(directory, tree.kind, ...(tree.key ? tree.key.split('/') : [])), loadTree(db, tree.kind, tree.key)!); return { trees: trees.length, files: trees.reduce((total, tree) => total + tree.files, 0), bytes: trees.reduce((total, tree) => total + tree.bytes, 0) }; } finally { db.close(); }
}
