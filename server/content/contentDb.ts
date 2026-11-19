import { join } from 'node:path';
import { packageRoot } from '../packageRoot';
import type { DatabaseSync } from 'node:sqlite';
import { configureSqliteBusyTimeout } from '../sqlite';

export type ContentDb = DatabaseSync | { prepare(sql: string): any; exec(sql: string): void; close(): void };

export function migrate(db: ContentDb): void {
  configureSqliteBusyTimeout(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null };
  if ((version.version ?? 0) > 1) throw new Error('Unsupported content database schema version');
  if (version.version === 1) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE course (id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('course','map-recall','cheatsheet')), title TEXT NOT NULL, company TEXT, tier INTEGER, role TEXT, interview_date TEXT, deadline TEXT, tags_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'all', revision INTEGER NOT NULL, deleted_at TEXT, manifest_json TEXT NOT NULL);
      CREATE TABLE chapter (course_id TEXT NOT NULL REFERENCES course(id) ON DELETE CASCADE, id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, PRIMARY KEY(course_id,id));
      CREATE TABLE lesson (course_id TEXT NOT NULL, id TEXT NOT NULL, chapter_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, content_type TEXT NOT NULL, kind TEXT, est_minutes INTEGER, instructions TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(course_id,id), FOREIGN KEY(course_id,chapter_id) REFERENCES chapter(course_id,id) ON DELETE CASCADE);
      CREATE TABLE blob (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL, media_type TEXT, created_at TEXT NOT NULL);
      CREATE TABLE lesson_file (course_id TEXT NOT NULL REFERENCES course(id) ON DELETE CASCADE, lesson_id TEXT, path TEXT NOT NULL, role TEXT NOT NULL, blob_sha256 TEXT NOT NULL REFERENCES blob(sha256), mode INTEGER, PRIMARY KEY(course_id,lesson_id,path), FOREIGN KEY(course_id,lesson_id) REFERENCES lesson(course_id,id) ON DELETE CASCADE);
      CREATE TABLE course_revision (course_id TEXT NOT NULL REFERENCES course(id) ON DELETE CASCADE, revision INTEGER NOT NULL, bundle_json TEXT NOT NULL, actor_user_id TEXT, actor_api_key_id TEXT, message TEXT, created_at TEXT NOT NULL, PRIMARY KEY(course_id,revision));
      CREATE TABLE content_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO content_meta VALUES ('revision','0');
      CREATE VIRTUAL TABLE lesson_fts USING fts5(course_id UNINDEXED, lesson_id UNINDEXED, title, instructions);
      CREATE TRIGGER lesson_fts_insert AFTER INSERT ON lesson BEGIN INSERT INTO lesson_fts(course_id,lesson_id,title,instructions) VALUES(new.course_id,new.id,new.title,new.instructions); END;
      CREATE TRIGGER lesson_fts_delete AFTER DELETE ON lesson BEGIN DELETE FROM lesson_fts WHERE course_id=old.course_id AND lesson_id=old.id; END;
      CREATE TRIGGER lesson_fts_update AFTER UPDATE ON lesson BEGIN DELETE FROM lesson_fts WHERE course_id=old.course_id AND lesson_id=old.id; INSERT INTO lesson_fts(course_id,lesson_id,title,instructions) VALUES(new.course_id,new.id,new.title,new.instructions); END;
      CREATE VIRTUAL TABLE asset_fts USING fts5(course_id UNINDEXED, path UNINDEXED, text);
      CREATE TRIGGER asset_fts_delete AFTER DELETE ON course BEGIN DELETE FROM asset_fts WHERE course_id=old.id; END;
      INSERT INTO schema_version VALUES (1);
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function openContentDb(path = process.env.VITEST ? ':memory:' : (process.env.CONTENT_DB_PATH ?? join(packageRoot, 'content.db'))): Promise<ContentDb> {
  let sqlite: typeof import('node:sqlite') | undefined;
  try { sqlite = await import('node:sqlite'); } catch { /* Older Node requires the fallback. */ }
  const db: ContentDb = sqlite ? new sqlite.DatabaseSync(path) : new (await import('better-sqlite3')).default(path);
  try { migrate(db); } catch (error) { db.close(); throw error; }
  return db;
}
