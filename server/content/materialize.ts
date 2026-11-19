import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { packageRoot } from '../packageRoot';
import { checkBundlePath, sha256 } from './bundle';
import type { ContentDb } from './contentDb';
import { getCourseBundle } from './writer';
import { workspaceFileExcluded } from '../../sandbox/workspace-files.mjs';

const identity = /^[a-z0-9][a-z0-9-]{0,99}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const locks = new Map<string, Promise<void>>();
const verified = new WeakMap<ContentDb, Map<string, string>>();

export function managedStateRoot(): string {
  const base = process.env.XDG_STATE_HOME ?? (process.env.RUNNER_ACCESS_MODE || process.env.NODE_ENV === 'production' ? join(homedir(), '.local/state') : join(packageRoot, '.state'));
  return join(base, 'interview-runner', 'managed');
}
function validateIdentity(courseId: string, revision: number): void {
  if (!identity.test(courseId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid content identity');
}
export function currentContentRevision(db: ContentDb, courseId: string): number {
  const row = db.prepare('SELECT revision FROM course WHERE id=? AND deleted_at IS NULL').get(courseId) as { revision: number } | undefined;
  if (!row) throw new Error(`Unknown course: ${courseId}`);
  validateIdentity(courseId, row.revision); return row.revision;
}
export function materializedRoot(courseId: string, revision: number, stateRoot = managedStateRoot()): string {
  validateIdentity(courseId, revision); return join(stateRoot, 'materialized', courseId, String(revision));
}
export function codingWorkspace(courseId: string, drillId: string, stateRoot = managedStateRoot()): string {
  if (!identity.test(courseId) || !identity.test(drillId)) throw new Error('Invalid workspace identity');
  return join(stateRoot, 'workspaces', courseId, drillId);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
/**
 * A workspace that is missing or an empty directory holds no learner work, so it is restored or seeded.
 * Checking the listing rather than the path also covers a directory just removed on the host, which a
 * container's bind mount can still report as present (and empty) for about a second.
 */
async function vacant(workspace: string): Promise<boolean> {
  try { return (await readdir(workspace)).length === 0; }
  catch (error) { if (missing(error)) return true; if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}
async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void; const current = new Promise<void>((done) => { release = done; });
  locks.set(key, current); await previous;
  try { return await operation(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

type LockOwner = { pid: number; hostname: string; timestamp: number };
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function retryMissingRevision<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { if (!missing(error)) throw error; }
  await wait(25);
  return operation();
}
async function staleLock(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid lock file: ${path}`);
    if (Date.now() - info.mtimeMs <= 300_000) return false;
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const owner = raw as Partial<LockOwner>;
    if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.timestamp !== 'number' || Date.now() - owner.timestamp <= 300_000) return false;
    try { process.kill(owner.pid!, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; if ((error as NodeJS.ErrnoException).code === 'EPERM') return false; throw error; }
  } catch (error) { if (missing(error)) return false; if (error instanceof SyntaxError) return false; throw error; }
}

/** Lock a managed path across runner and host processes; never break unverified owners. */
async function managedLock<T>(root: string, key: string, operation: () => Promise<T>): Promise<T> {
  return locked(key, async () => {
    await mkdir(root, { recursive: true }); await assertNoSymlink(root, key);
    await mkdir(dirname(key), { recursive: true }); await assertNoSymlink(root, dirname(key));
    const path = `${key}.lock`; const reaper = `${path}.reap`; const deadline = Date.now() + 30_000; let delay = 25;
    for (;;) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for managed lock: ${path}`);
      await assertNoSymlink(root, path);
      let handle;
      try { handle = await open(path, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (handle) {
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), timestamp: Date.now() } satisfies LockOwner)); }
        catch (error) { await handle.close(); await unlink(path); throw error; }
        await handle.close();
        try { return await operation(); } finally { await unlink(path); }
      }
      if (await staleLock(path)) {
        await assertNoSymlink(root, reaper);
        let claim;
        try { claim = await open(reaper, 'wx', 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (claim) {
          try { if (await staleLock(path)) await unlink(path); }
          finally { await claim.close(); await unlink(reaper); }
          continue;
        }
      }
      await wait(Math.min(delay, Math.max(0, deadline - Date.now()))); delay = Math.min(delay * 2, 250);
    }
  });
}

export function withWorkspaceLock<T>(courseId: string, drillId: string, stateRoot: string, operation: () => Promise<T>): Promise<T> {
  return managedLock(stateRoot, codingWorkspace(courseId, drillId, stateRoot), operation);
}

/** Hold the revision lock through any immediate consumer of its files. */
async function withMaterializedCourse<T>(db: ContentDb, courseId: string, revision: number, stateRoot: string, use: (path: string, digest: string) => Promise<T>, requiredPath?: string, requiredPrefix?: string): Promise<T> {
  const destination = materializedRoot(courseId, revision, stateRoot);
  const bundle = getCourseBundle(db, courseId, revision);
  if (!bundle) throw new Error(`Unknown content revision: ${courseId}/${revision}`);
  const digest = sha256(Buffer.from(JSON.stringify(Object.entries(bundle.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, entry]) => [path, entry.sha256, entry.mode ?? 0o644]))));
  const stamp = '.bundle-sha256';
  return managedLock(stateRoot, destination, async () => {
    await mkdir(stateRoot, { recursive: true }); await assertNoSymlink(stateRoot, destination);
    if (await exists(destination)) {
      if (!(await lstat(destination)).isDirectory() || (await lstat(destination)).isSymbolicLink()) throw new Error('Invalid materialized revision');
      const stampPath = join(destination, stamp); await assertNoSymlink(destination, stampPath);
      let existing: string | undefined;
      try { existing = await readFile(stampPath, 'utf8'); } catch (error) { if (!missing(error)) throw error; }
      if (existing === digest) {
        const required = [...(requiredPath ? [requiredPath] : []), ...(requiredPrefix ? Object.keys(bundle.files).filter((path) => path.startsWith(requiredPrefix)) : [])];
        let complete = true;
        for (const path of required) { checkBundlePath(path); const target = join(destination, path); await assertNoSymlink(destination, target); if (!(await exists(target))) { complete = false; break; } }
        if (complete) { const now = new Date(); await utimes(destination, now, now); return await use(destination, digest); }
      }
    }
    const parent = dirname(destination); await mkdir(parent, { recursive: true }); await assertNoSymlink(stateRoot, parent);
    const temp = await mkdtemp(`${destination}.tmp-`);
    try {
      for (const [path, entry] of Object.entries(bundle.files)) {
        if (!path.startsWith(`drills/${courseId}/`) && !path.startsWith(`guides/${courseId}/`)) continue;
        checkBundlePath(path);
        const row = db.prepare('SELECT bytes FROM blob WHERE sha256=?').get(entry.sha256) as { bytes: Uint8Array } | undefined;
        if (!row || row.bytes.length !== entry.size || sha256(row.bytes) !== entry.sha256) throw new Error(`Missing or invalid content blob: ${path}`);
        const target = join(temp, path); await mkdir(dirname(target), { recursive: true });
        await writeFile(target, row.bytes, { flag: 'wx' }); await chmod(target, (entry.mode ?? 0o644) & ~0o222);
      }
      await writeFile(join(temp, stamp), digest, { flag: 'wx', mode: 0o444 });
      if (await exists(destination)) {
        const displaced = await mkdtemp(`${destination}.old-`); await rm(displaced, { recursive: true });
        await rename(destination, displaced);
        try { await rename(temp, destination); } catch (error) {
          try { await rename(displaced, destination); } catch { throw new Error(`Materialization failed; previous revision retained at ${displaced}`, { cause: error }); }
          throw error;
        }
        await rm(displaced, { recursive: true, force: true });
      } else {
        try { await rename(temp, destination); } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') || !(await exists(destination))) throw error;
          await assertNoSymlink(destination, join(destination, stamp));
          if (await readFile(join(destination, stamp), 'utf8') !== digest) throw new Error('Concurrent materialization has a different bundle');
        }
      }
      return await use(destination, digest);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}

/** Publish a complete immutable revision. Historical revisions use their recorded bundle, not current lesson_file rows. */
export async function materializeCourse(db: ContentDb, courseId: string, revision: number, stateRoot = managedStateRoot(), requiredPath?: string): Promise<string> {
  if (requiredPath) checkBundlePath(requiredPath);
  const destination = materializedRoot(courseId, revision, stateRoot);
  let entries = verified.get(db); if (!entries) { entries = new Map(); verified.set(db, entries); }
  const expected = entries.get(destination);
  if (expected) {
    try {
      await assertNoSymlink(stateRoot, destination);
      const stamp = join(destination, '.bundle-sha256'); await assertNoSymlink(destination, stamp);
      if (await readFile(stamp, 'utf8') === expected) {
        if (requiredPath) { const file = join(destination, requiredPath); await assertNoSymlink(destination, file); if (!(await exists(file))) throw Object.assign(new Error('Missing materialized file'), { code: 'ENOENT' }); }
        const now = new Date(); await utimes(destination, now, now);
        return destination;
      }
    } catch (error) { if (!missing(error)) throw error; }
    entries.delete(destination);
  }
  return withMaterializedCourse(db, courseId, revision, stateRoot, async (path, digest) => {
    entries.set(destination, digest); if (entries.size > 256) entries.delete(entries.keys().next().value!);
    return path;
  }, requiredPath);
}

export async function assertNoSymlink(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== resolve(path)) throw new Error('Workspace path escapes drill');
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Workspace path contains a symbolic link');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Workspace path contains a symbolic link'); }
    catch (error) { if (!missing(error)) throw error; }
  }
}

async function seedWorkspace(source: string, workspace: string): Promise<'seeded' | 'skipped-existing' | 'skipped-raced'> {
  if (!(await vacant(workspace))) return 'skipped-existing';
  const temp = await mkdtemp(join(dirname(workspace), '.workspace-'));
  try {
    await cp(source, temp, { recursive: true, filter: async (path) => {
      if (path !== source && workspaceFileExcluded.has(basename(path))) return false;
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Workspace template contains a symbolic link');
      return true;
    } });
    const makeWritable = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await makeWritable(path);
        else if (entry.isFile()) await chmod(path, (await lstat(path)).mode | 0o200);
      }
    };
    await makeWritable(temp);
    try { await rename(temp, workspace); return 'seeded'; } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') || !(await exists(workspace))) throw error;
      return 'skipped-raced';
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Preserve linked edits before a DB-mode container stops mounting repositories. */
export async function seedLinkedCodingWorkspace(courseId: string, drillId: string, source: string, stateRoot = managedStateRoot()): Promise<'seeded' | 'skipped-existing' | 'skipped-raced' | 'no-source'> {
  const workspace = codingWorkspace(courseId, drillId, stateRoot);
  return withWorkspaceLock(courseId, drillId, stateRoot, async () => {
    if (!(await exists(source))) return 'no-source';
    await mkdir(stateRoot, { recursive: true }); await assertNoSymlink(stateRoot, workspace);
    await mkdir(dirname(workspace), { recursive: true }); await assertNoSymlink(stateRoot, dirname(workspace));
    return seedWorkspace(source, workspace);
  });
}

// With a single user database, a coding workspace directory is scratch: when it is missing, the stored copy wins over a fresh seed.
let restoreStoredWorkspace: ((courseId: string, drillId: string, directory: string) => boolean) | undefined;
export function setCodingWorkspaceRestorer(restore: typeof restoreStoredWorkspace): void { restoreStoredWorkspace = restore; }
async function restoreWorkspace(courseId: string, drillId: string, workspace: string): Promise<void> {
  if (!restoreStoredWorkspace || !(await vacant(workspace))) return;
  const temp = await mkdtemp(join(dirname(workspace), '.workspace-'));
  try { if (restoreStoredWorkspace(courseId, drillId, temp)) await rename(temp, workspace); } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Seed once, then replace only protected tests and seeds, serialized per drill. */
export async function prepareCodingWorkspace(options: { db: ContentDb; courseId: string; drillId: string; revision: number; testPaths: string[]; linkedDrillPath?: string; stateRoot?: string }): Promise<string> {
  const { db, courseId, drillId, revision, testPaths } = options;
  const stateRoot = options.stateRoot ?? managedStateRoot(); const workspace = codingWorkspace(courseId, drillId, stateRoot);
  return withMaterializedCourse(db, courseId, revision, stateRoot, async (materialized) => {
    const prefix = `drills/${courseId}/${drillId}/`; const template = join(materialized, prefix);
    return withWorkspaceLock(courseId, drillId, stateRoot, async () => {
      await assertNoSymlink(stateRoot, workspace); await mkdir(dirname(workspace), { recursive: true }); await assertNoSymlink(stateRoot, dirname(workspace));
      await restoreWorkspace(courseId, drillId, workspace);
      if (await vacant(workspace)) {
        const source = options.linkedDrillPath && await exists(options.linkedDrillPath) ? options.linkedDrillPath : template;
        if (source === template) await retryMissingRevision(() => seedWorkspace(source, workspace));
        else await seedWorkspace(source, workspace);
      }
      if ((await lstat(workspace)).isSymbolicLink() || !(await lstat(workspace)).isDirectory()) throw new Error('Invalid workspace');
      const bundle = getCourseBundle(db, courseId, revision)!;
      const protectedPaths = new Set([...testPaths, ...Object.keys(bundle.files).filter((path) => path.startsWith(prefix) && basename(path).includes('.seed.'))]);
      for (const path of protectedPaths) {
        checkBundlePath(path); if (!path.startsWith(prefix) || !bundle.files[path]) throw new Error('Protected file is outside the drill');
        const target = join(workspace, path.slice(prefix.length)); await assertNoSymlink(workspace, target); await mkdir(dirname(target), { recursive: true });
        try {
          const info = await lstat(target); if (!info.isFile()) throw new Error('Protected workspace path is not a file');
          if (info.nlink === 1 && sha256(await readFile(target)) === bundle.files[path]!.sha256) {
            const mode = (bundle.files[path]!.mode ?? 0o644) & ~0o222; if ((info.mode & 0o777) !== mode) await chmod(target, mode);
            continue;
          }
        } catch (error) { if (!missing(error)) throw error; }
        // Remove first: protected copies may have been chmod'ed read-only on a prior sync.
        await rm(target, { force: true }); await retryMissingRevision(() => copyFile(join(materialized, path), target)); await chmod(target, (bundle.files[path]!.mode ?? 0o644) & ~0o222);
      }
      return workspace;
    });
  }, undefined, `drills/${courseId}/${drillId}/`);
}

/** Remove old inactive revisions, never following symlinks or touching current/open revisions. */
export async function gcMaterialized(db: ContentDb, courseId: string, openRevisions: readonly number[], now = Date.now(), stateRoot = managedStateRoot()): Promise<void> {
  const current = currentContentRevision(db, courseId); const directory = dirname(materializedRoot(courseId, current, stateRoot));
  try { await assertNoSymlink(stateRoot, directory); } catch (error) { if (missing(error)) return; throw error; }
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const revision = Number(entry.name); if (!Number.isSafeInteger(revision) || revision === current || openRevisions.includes(revision)) continue;
    const path = join(directory, entry.name);
    await managedLock(stateRoot, path, async () => {
      let info; try { info = await lstat(path); } catch (error) { if (missing(error)) return; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs > now - 30 * 24 * 60 * 60 * 1000) return;
      await rm(path, { recursive: true, force: true });
    });
  }
}
