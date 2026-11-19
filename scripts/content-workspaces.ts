import { openContentDb } from '../server/content/contentDb';
import { statePath } from '../server/statePath';
import { packageRoot } from '../server/packageRoot';
import { defaultWorkspace } from '../server/owner';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2); return value;
}
try {
  const dbPath = option('--db') ?? process.env.CONTENT_DB_PATH ?? join(packageRoot, 'content.db'); const state = option('--state-db') ?? statePath();
  const base = option('--url') ?? process.env.INTERVIEW_RUNNER_URL;
  const forceIndex = args.indexOf('--force'); const force = forceIndex >= 0;
  if (force) args.splice(forceIndex, 1);
  const [command, namespace, ...extra] = args;
  if (extra.length || !['list', 'ensure', 'delete'].includes(command ?? '') || (command === 'list' ? namespace !== undefined || force : !namespace || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(namespace)) || (force && command !== 'delete')) throw new Error('Usage: content-workspaces [--db path] [--state-db path] list | ensure <namespace> | delete <namespace> [--force]');
  if (!statSync(dbPath).isFile()) throw new Error('Content database must exist');
  if (command === 'delete' && !statSync(state).isFile()) throw new Error('State database must exist');
  let origin: URL | undefined;
  if (base) { origin = new URL(base); if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Invalid runner URL'); }
  if (command === 'list' && !origin) throw new Error('Specify --url or INTERVIEW_RUNNER_URL');
  const db = await openContentDb(dbPath);
  try {
    if (command === 'ensure') {
      db.prepare('INSERT OR IGNORE INTO content_meta(key,value) VALUES (?,?)').run(`workspace:${namespace}`, namespace);
      console.log(JSON.stringify({ workspace: namespace }));
    } else if (command === 'list') {
      const rows = db.prepare("SELECT namespace_id,COUNT(*) AS count FROM course WHERE deleted_at IS NULL AND type <> 'cheatsheet' GROUP BY namespace_id").all() as Array<{ namespace_id: string; count: number }>;
      const registered = db.prepare("SELECT value FROM content_meta WHERE key LIKE 'workspace:%'").all() as Array<{ value: string }>;
      const owners = db.prepare('SELECT DISTINCT namespace_id FROM course WHERE deleted_at IS NULL').all() as Array<{ namespace_id: string }>;
      const names = [...new Set([defaultWorkspace, ...registered.map((row) => row.value), ...owners.map((row) => row.namespace_id)])].sort();
      console.log(JSON.stringify(names.map((name) => { const url = new URL(origin!); url.searchParams.set('workspace', name); return { workspace: name, courses: rows.find((row) => row.namespace_id === name)?.count ?? 0, url: url.href }; })));
    } else {
      if (namespace === defaultWorkspace) throw new Error('The default workspace cannot be deleted');
      db.prepare('ATTACH DATABASE ? AS state').run(state);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of ['library_categories', 'library_items']) {
          const columns = db.prepare(`PRAGMA state.table_info(${table})`).all() as Array<{ name: string }>;
          if (!columns.some((column) => column.name === 'workspace_id')) throw new Error('Library workspace migration is required before deletion');
        }
        const courses = db.prepare('SELECT id FROM course WHERE namespace_id=? AND deleted_at IS NULL').all(namespace) as Array<{ id: string }>;
        const keys = db.prepare('SELECT id,namespaces_json FROM state.api_key WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').all(new Date().toISOString()) as Array<{ id: string; namespaces_json: string }>;
        const affected = keys.filter((key) => (JSON.parse(key.namespaces_json) as string[]).includes(namespace!));
        const categories = Number((db.prepare('SELECT COUNT(*) AS count FROM state.library_categories WHERE workspace_id=?').get(namespace) as { count: number }).count);
        const items = Number((db.prepare('SELECT COUNT(*) AS count FROM state.library_items WHERE workspace_id=?').get(namespace) as { count: number }).count);
        if (!force && (courses.length || affected.length || categories || items)) throw new Error(`Workspace has ${courses.length} courses, ${affected.length} active keys, ${categories} categories and ${items} library items; use --force to remove workspace data`);
        const now = new Date().toISOString();
        for (const key of affected) {
          const remaining = (JSON.parse(key.namespaces_json) as string[]).filter((value) => value !== namespace);
          if (remaining.length) db.prepare('UPDATE state.api_key SET namespaces_json=? WHERE id=?').run(JSON.stringify(remaining), key.id);
          else db.prepare('UPDATE state.api_key SET revoked_at=? WHERE id=?').run(now, key.id);
        }
        if (courses.length) { db.prepare('UPDATE course SET deleted_at=? WHERE namespace_id=? AND deleted_at IS NULL').run(now, namespace); db.prepare("UPDATE content_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); }
        db.prepare('DELETE FROM state.library_items WHERE workspace_id=?').run(namespace);
        db.prepare('DELETE FROM state.library_categories WHERE workspace_id=?').run(namespace);
        db.prepare('DELETE FROM content_meta WHERE key=?').run(`workspace:${namespace}`);
        db.exec('COMMIT'); console.log(JSON.stringify({ workspace: namespace, courses: courses.length, keys: affected.length }));
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  } finally { db.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
