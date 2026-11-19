import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { courseTestTimeoutMessage } from '../sandbox/test-timeout.mjs';
import { loadCourse, chapterDrillIds } from './courses';
import type { DatabaseSync } from 'node:sqlite';
import { ensureApiKeySchema } from './content/apiKeys';
import { statePath } from './statePath';
import { configureSqliteBusyTimeout } from './sqlite';
import { migrateUserDb } from './userData';
import { contentDatabase, contentSource } from './content/reader';
import { defaultWorkspace } from './owner';
import { MAP_HIGHLIGHT_MAX_RECORDS, type MapHighlight } from '../shared/mapHighlights';

// Vitest evaluates the Vite config and test files in separate workers. Pointing all
// of those processes at the user's database made module initialization and writes
// contend for the same SQLite file, and also let test rows persist between runs.
// An in-memory database is private to each isolated test worker/module context.
const dbPath = statePath();
type DatabaseLike = DatabaseSync | { prepare(sql: string): any; exec(sql: string): void };
let db: DatabaseLike;
try {
  const sqlite = await import('node:sqlite');
  db = new sqlite.DatabaseSync(dbPath);
} catch {
  const BetterSqlite = (await import('better-sqlite3')).default;
  db = new BetterSqlite(dbPath);
}
configureSqliteBusyTimeout(db);
// Numbered migrations (with an automatic backup) run before the idempotent legacy table setup below; a newer file aborts startup here.
// The legacy progress.db lives in the checkout; its pre-migration copy goes to the ignored .state directory, never next to tracked files.
migrateUserDb(db, dbPath, process.env.RUNNER_DB_PATH ? {} : { backupDir: join(dirname(dbPath), '.state', 'backups') });
export function stateDb(): DatabaseLike { return db; }
ensureApiKeySchema(db);
export function ensureProgressSchema(database: DatabaseLike): void {
  const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'progress'").get() as { sql?: string } | undefined;
  if (!schema) { database.exec(`CREATE TABLE progress (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('not-started','in-progress','blocked','done')), notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));`); return; }
  if (schema.sql?.includes("'blocked'")) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DROP TABLE IF EXISTS progress_migrated');
    database.exec(`CREATE TABLE progress_migrated (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('not-started','in-progress','blocked','done')), notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));`);
    database.exec('INSERT INTO progress_migrated (course_id, drill_id, status, notes, updated_at) SELECT course_id, drill_id, status, notes, updated_at FROM progress');
    database.exec('DROP TABLE progress'); database.exec('ALTER TABLE progress_migrated RENAME TO progress'); database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
ensureProgressSchema(db);
db.exec(`CREATE TABLE IF NOT EXISTS test_results (file_path TEXT PRIMARY KEY, status TEXT NOT NULL, tests_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS outline_nodes (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, node_id TEXT NOT NULL, folded INTEGER, checked INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id, node_id));`);
db.exec(`CREATE TABLE IF NOT EXISTS map_fold_state (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, folds_json TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));`);
db.exec(`CREATE TABLE IF NOT EXISTS map_fold_writers (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, writer_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (course_id, drill_id, writer_id));`);
db.exec(`CREATE TABLE IF NOT EXISTS map_highlights (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, highlight_id TEXT NOT NULL, record_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (course_id, drill_id, highlight_id));`);
db.exec(`CREATE TABLE IF NOT EXISTS recall_whiteboards (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, question_id TEXT NOT NULL, scene_json TEXT NOT NULL, svg TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (course_id, drill_id, question_id));`);
db.exec(`CREATE TABLE IF NOT EXISTS recall_drill_whiteboards (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, scene_json TEXT NOT NULL, svg TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (course_id, drill_id));`);
export type WhiteboardSnapshot = { scene: { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> }; svg: string; updatedAt: number };
export function getRecallWhiteboard(courseId: string, drillId: string, questionId: string): WhiteboardSnapshot | null {
  const row = db.prepare('SELECT scene_json, svg, updated_at FROM recall_whiteboards WHERE course_id = ? AND drill_id = ? AND question_id = ?').get(courseId, drillId, questionId) as { scene_json: string; svg: string; updated_at: number } | undefined;
  return row ? { scene: JSON.parse(row.scene_json) as WhiteboardSnapshot['scene'], svg: row.svg, updatedAt: row.updated_at } : null;
}
export function setRecallWhiteboard(courseId: string, drillId: string, questionId: string, snapshot: WhiteboardSnapshot): boolean {
  const result = db.prepare('INSERT INTO recall_whiteboards (course_id, drill_id, question_id, scene_json, svg, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(course_id, drill_id, question_id) DO UPDATE SET scene_json = excluded.scene_json, svg = excluded.svg, updated_at = excluded.updated_at WHERE excluded.updated_at > recall_whiteboards.updated_at').run(courseId, drillId, questionId, JSON.stringify(snapshot.scene), snapshot.svg, snapshot.updatedAt) as { changes: number | bigint };
  return Number(result.changes) > 0;
}
export function getDrillWhiteboard(courseId: string, drillId: string): WhiteboardSnapshot | null {
  const row = db.prepare('SELECT scene_json, svg, updated_at FROM recall_drill_whiteboards WHERE course_id = ? AND drill_id = ?').get(courseId, drillId) as { scene_json: string; svg: string; updated_at: number } | undefined;
  return row ? { scene: JSON.parse(row.scene_json) as WhiteboardSnapshot['scene'], svg: row.svg, updatedAt: row.updated_at } : null;
}
export function setDrillWhiteboard(courseId: string, drillId: string, snapshot: WhiteboardSnapshot, baseUpdatedAt: number | null): boolean {
  const result = baseUpdatedAt === null
    ? db.prepare('INSERT INTO recall_drill_whiteboards (course_id, drill_id, scene_json, svg, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(course_id, drill_id) DO NOTHING').run(courseId, drillId, JSON.stringify(snapshot.scene), snapshot.svg, snapshot.updatedAt)
    : db.prepare('UPDATE recall_drill_whiteboards SET scene_json = ?, svg = ?, updated_at = ? WHERE course_id = ? AND drill_id = ? AND updated_at = ? AND ? > updated_at').run(JSON.stringify(snapshot.scene), snapshot.svg, snapshot.updatedAt, courseId, drillId, baseUpdatedAt, snapshot.updatedAt);
  return Number(result.changes) > 0;
}
export function getMapFoldState(courseId: string, drillId: string): Record<string, boolean> | null {
  const row = db.prepare('SELECT folds_json FROM map_fold_state WHERE course_id = ? AND drill_id = ?').get(courseId, drillId) as { folds_json: string } | undefined;
  return row ? JSON.parse(row.folds_json) as Record<string, boolean> : null;
}
export function getMapHighlights(courseId: string, drillId: string): MapHighlight[] {
  const rows = db.prepare('SELECT record_json FROM map_highlights WHERE course_id = ? AND drill_id = ? AND deleted = 0 ORDER BY rowid').all(courseId, drillId) as { record_json: string }[];
  return rows.map((row) => JSON.parse(row.record_json) as MapHighlight);
}
export function addMapHighlight(courseId: string, drillId: string, highlight: MapHighlight): 'added' | 'conflict' | 'full' | 'removed' {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT record_json, deleted FROM map_highlights WHERE course_id = ? AND drill_id = ? AND highlight_id = ?').get(courseId, drillId, highlight.id) as { record_json: string; deleted: number } | undefined;
    const json = JSON.stringify(highlight);
    if (existing) { db.exec('COMMIT'); return existing.deleted ? 'removed' : existing.record_json === json ? 'added' : 'conflict'; }
    const row = db.prepare('SELECT COUNT(*) AS count FROM map_highlights WHERE course_id = ? AND drill_id = ? AND deleted = 0').get(courseId, drillId) as { count: number };
    if (Number(row.count) >= MAP_HIGHLIGHT_MAX_RECORDS) { db.exec('COMMIT'); return 'full'; }
    db.prepare('INSERT INTO map_highlights (course_id, drill_id, highlight_id, record_json) VALUES (?, ?, ?, ?)').run(courseId, drillId, highlight.id, json);
    db.exec('COMMIT'); return 'added';
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function removeMapHighlight(courseId: string, drillId: string, id: string): void {
  // A delayed create from another tab must not resurrect an explicitly removed note.
  db.prepare("INSERT INTO map_highlights (course_id, drill_id, highlight_id, record_json, deleted) VALUES (?, ?, ?, '', 1) ON CONFLICT(course_id, drill_id, highlight_id) DO UPDATE SET deleted = 1, record_json = ''").run(courseId, drillId, id);
}
export function setMapFoldState(courseId: string, drillId: string, writer: string, sequence: number, folds: Record<string, boolean> | null): { applied: boolean; sequence: number } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare('INSERT INTO map_fold_writers (course_id, drill_id, writer_id, sequence) VALUES (?, ?, ?, ?) ON CONFLICT(course_id, drill_id, writer_id) DO UPDATE SET sequence = excluded.sequence WHERE excluded.sequence > map_fold_writers.sequence').run(courseId, drillId, writer, sequence) as { changes: number | bigint };
    if (!Number(result.changes)) {
      const row = db.prepare('SELECT sequence FROM map_fold_writers WHERE course_id = ? AND drill_id = ? AND writer_id = ?').get(courseId, drillId, writer) as { sequence: number };
      db.exec('COMMIT'); return { applied: false, sequence: row.sequence };
    }
    db.prepare('INSERT INTO map_fold_state (course_id, drill_id, folds_json) VALUES (?, ?, ?) ON CONFLICT(course_id, drill_id) DO UPDATE SET folds_json = excluded.folds_json').run(courseId, drillId, JSON.stringify(folds));
    db.exec('COMMIT'); return { applied: true, sequence };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
db.exec(`CREATE TABLE IF NOT EXISTS revealed_hints (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, hint_id TEXT NOT NULL, revealed_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id, hint_id));`);
export function ensureSubmissionSchema(database: DatabaseLike): void {
  // Retained legacy snapshot data and columns: no longer read or written by the runner.
  database.exec(`CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT NOT NULL, drill_id TEXT NOT NULL, submitted_at TEXT NOT NULL, content TEXT NOT NULL, result_json TEXT NOT NULL, custom_name TEXT);`);
  const columns = database.prepare('PRAGMA table_info(submissions)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'custom_name')) database.exec('ALTER TABLE submissions ADD COLUMN custom_name TEXT');
  if (!columns.some((column) => column.name === 'timeline_json')) database.exec('ALTER TABLE submissions ADD COLUMN timeline_json TEXT');
  if (!columns.some((column) => column.name === 'snapshot_id')) database.exec('ALTER TABLE submissions ADD COLUMN snapshot_id TEXT');
  if (!columns.some((column) => column.name === 'commit_sha')) database.exec('ALTER TABLE submissions ADD COLUMN commit_sha TEXT');
  database.exec(`CREATE TABLE IF NOT EXISTS draft_timelines (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, timeline_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_blobs (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL);`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_snapshots (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, stage INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('run','submit','stage')), created_at TEXT NOT NULL, files_json TEXT NOT NULL, total_bytes INTEGER NOT NULL);`);
  database.exec(`CREATE INDEX IF NOT EXISTS workspace_snapshots_drill_attempt_time ON workspace_snapshots (course_id, drill_id, attempt_number, created_at);`);
  database.exec(`CREATE TABLE IF NOT EXISTS attempt_stages (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, stage INTEGER NOT NULL, unlocked_at TEXT NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('start','manual','timer')), snapshot_id TEXT, PRIMARY KEY (course_id, drill_id, attempt_number, stage));`);
  const stageColumns = database.prepare('PRAGMA table_info(attempt_stages)').all() as Array<{ name: string }>;
  if (!stageColumns.some((column) => column.name === 'commit_sha')) database.exec('ALTER TABLE attempt_stages ADD COLUMN commit_sha TEXT');
  database.exec(`CREATE INDEX IF NOT EXISTS submissions_drill_time ON submissions (course_id, drill_id, id);`);
}
ensureSubmissionSchema(db);
export function ensureDrillAttemptSchema(database: DatabaseLike): void {
  database.exec(`CREATE TABLE IF NOT EXISTS drill_attempts (
    course_id TEXT NOT NULL,
    drill_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    started_at TEXT NOT NULL,
    accumulated_active_ms INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_active_ms >= 0),
    active_since TEXT,
    completed_at TEXT,
    PRIMARY KEY (course_id, drill_id, attempt_number)
  );`);
  const columns = database.prepare('PRAGMA table_info(drill_attempts)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'content_revision')) database.exec('ALTER TABLE drill_attempts ADD COLUMN content_revision INTEGER');
  database.exec(`CREATE INDEX IF NOT EXISTS drill_attempts_course ON drill_attempts (course_id, drill_id, attempt_number);`);
}
ensureDrillAttemptSchema(db);
db.exec(`CREATE TABLE IF NOT EXISTS book_shelf (course_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('reading','archived')), updated_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS book_chapter_rank (course_id TEXT NOT NULL, chapter_id TEXT NOT NULL, rank INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, chapter_id));`);
db.exec(`CREATE TABLE IF NOT EXISTS course_tag_overrides (course_id TEXT PRIMARY KEY, tags_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
export function ensureCourseScheduleSchema(database: DatabaseLike): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS course_schedule_overrides (course_id TEXT PRIMARY KEY, deadline TEXT, tier INTEGER CHECK (tier IN (1,2,3)), updated_at TEXT NOT NULL);`);
    const columns = database.prepare('PRAGMA table_info(course_schedule_overrides)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'deadline_cleared')) database.exec('ALTER TABLE course_schedule_overrides ADD COLUMN deadline_cleared INTEGER NOT NULL DEFAULT 0 CHECK (deadline_cleared IN (0,1))');
    if (!columns.some((column) => column.name === 'tier_cleared')) database.exec('ALTER TABLE course_schedule_overrides ADD COLUMN tier_cleared INTEGER NOT NULL DEFAULT 0 CHECK (tier_cleared IN (0,1))');
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
ensureCourseScheduleSchema(db);
export function ensureLibrarySchema(database: DatabaseLike, owners: ReadonlyMap<string, string> = new Map()): boolean {
  database.exec('BEGIN IMMEDIATE');
  try {
    const exists = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const categoriesExist = exists('library_categories'); const itemsExist = exists('library_items');
    if (categoriesExist !== itemsExist) throw new Error('Incomplete library schema; refusing migration');
    database.exec(`CREATE TABLE IF NOT EXISTS library_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, fixed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`);
    database.exec(`CREATE TABLE IF NOT EXISTS library_items (kind TEXT NOT NULL CHECK (kind IN ('course','cheatsheet')), item_id TEXT NOT NULL, category_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')), status_explicit INTEGER NOT NULL DEFAULT 0, title_override TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (kind, item_id));`);
    const categoriesScoped = (database.prepare('PRAGMA table_info(library_categories)').all() as Array<{ name: string }>).some((column) => column.name === 'workspace_id');
    const itemsScoped = (database.prepare('PRAGMA table_info(library_items)').all() as Array<{ name: string }>).some((column) => column.name === 'workspace_id');
    if (categoriesScoped !== itemsScoped) throw new Error('Incomplete workspace migration; refusing migration');
    if (!categoriesScoped) {
      database.exec(`ALTER TABLE library_categories ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${defaultWorkspace}'`);
      database.exec(`ALTER TABLE library_items ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${defaultWorkspace}'`);
      if (exists('book_shelf')) database.exec(`INSERT OR IGNORE INTO library_items (kind,item_id,category_id,position,status,status_explicit,updated_at,workspace_id)
        SELECT 'course',course_id,'uncategorized',(SELECT COUNT(*) FROM library_items WHERE workspace_id='${defaultWorkspace}'),'archived',1,updated_at,'${defaultWorkspace}' FROM book_shelf WHERE status='archived'`);
      const items = database.prepare('SELECT kind,item_id,category_id FROM library_items').all() as Array<{ kind: string; item_id: string; category_id: string }>;
      for (const item of items) {
        const owner = owners.get(`${item.kind}:${item.item_id}`);
        if (!owner || owner === defaultWorkspace) continue;
        if (item.category_id !== 'uncategorized') throw new Error(`Legacy item ${item.item_id} belongs to ${owner} but has a shared category; migration requires review`);
        database.prepare('UPDATE library_items SET workspace_id=? WHERE kind=? AND item_id=?').run(owner, item.kind, item.item_id);
      }
    }
    database.exec('COMMIT'); return !categoriesExist || !categoriesScoped;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
const oldLibraryColumns = db.prepare('PRAGMA table_info(library_items)').all() as Array<{ name: string }>;
const legacyOwners = new Map<string, string>();
if (oldLibraryColumns.length && !oldLibraryColumns.some((column) => column.name === 'workspace_id') && contentSource() === 'db') {
  const rows = (await contentDatabase()).prepare('SELECT id,type,namespace_id FROM course').all() as Array<{ id: string; type: string; namespace_id: string }>;
  for (const row of rows) legacyOwners.set(`${row.type === 'cheatsheet' ? 'cheatsheet' : 'course'}:${row.id}`, row.namespace_id);
}
const libraryMigrated = ensureLibrarySchema(db, legacyOwners);
// File mode keeps its legacy built-in category; new DB-mode workspaces have none.
if (libraryMigrated && process.env.INTERVIEW_RUNNER_CONTENT_SOURCE === 'files') db.prepare(`INSERT OR IGNORE INTO library_categories (id, name, position, fixed, updated_at, workspace_id) VALUES ('uncategorized', 'Uncategorized', 0, 1, ?, '${defaultWorkspace}')`).run(new Date().toISOString());
// Legacy archive state is retained, and copied once into the shared library model.
export function migrateLegacyBookShelf(): void { db.exec(`INSERT OR IGNORE INTO library_items (kind, item_id, category_id, position, status, status_explicit, updated_at)
  SELECT 'course', course_id, 'uncategorized', (SELECT COUNT(*) FROM library_items WHERE workspace_id='${defaultWorkspace}'), 'archived', 1, updated_at
  FROM book_shelf WHERE status = 'archived';`); }

export type ProgressStatus = 'not-started' | 'in-progress' | 'blocked' | 'done';
export type ProgressRecord = { status: ProgressStatus; updatedAt: string; notes?: string };
export type DrillAttemptRecord = { attemptNumber: number; startedAt: string; accumulatedActiveMs: number; elapsedMs: number; activeSince?: string; completedAt?: string; contentRevision?: number };
export type AttemptStageRecord = { stage: number; unlockedAt: string; reason: 'start' | 'manual' | 'timer'; commitSha?: string };
type DrillAttemptRow = { attempt_number: number; started_at: string; accumulated_active_ms: number; active_since: string | null; completed_at: string | null; content_revision: number | null };
function attemptRecord(row: DrillAttemptRow, at = new Date()): DrillAttemptRecord {
  const liveMs = row.active_since === null ? 0 : Math.max(0, at.getTime() - Date.parse(row.active_since));
  return { attemptNumber: row.attempt_number, startedAt: row.started_at, accumulatedActiveMs: row.accumulated_active_ms, elapsedMs: row.accumulated_active_ms + liveMs, ...(row.active_since === null ? {} : { activeSince: row.active_since }), ...(row.completed_at === null ? {} : { completedAt: row.completed_at }), ...(row.content_revision === null ? {} : { contentRevision: row.content_revision }) };
}
function attemptRows(courseId: string, drillId: string): DrillAttemptRow[] { return db.prepare('SELECT attempt_number, started_at, accumulated_active_ms, active_since, completed_at, content_revision FROM drill_attempts WHERE course_id = ? AND drill_id = ? ORDER BY attempt_number').all(courseId, drillId) as DrillAttemptRow[]; }
export function getDrillAttempts(courseId: string, drillId: string, at = new Date()): DrillAttemptRecord[] { return attemptRows(courseId, drillId).map((row) => attemptRecord(row, at)); }
export function getCourseDrillAttempts(courseId: string, at = new Date()): Record<string, DrillAttemptRecord[]> {
  const rows = db.prepare('SELECT drill_id, attempt_number, started_at, accumulated_active_ms, active_since, completed_at, content_revision FROM drill_attempts WHERE course_id = ? ORDER BY drill_id, attempt_number').all(courseId) as Array<DrillAttemptRow & { drill_id: string }>;
  const attempts: Record<string, DrillAttemptRecord[]> = {};
  for (const row of rows) (attempts[row.drill_id] ??= []).push(attemptRecord(row, at));
  return attempts;
}
function latestAttempt(courseId: string, drillId: string): DrillAttemptRow | undefined {
  return db.prepare('SELECT attempt_number, started_at, accumulated_active_ms, active_since, completed_at, content_revision FROM drill_attempts WHERE course_id = ? AND drill_id = ? ORDER BY attempt_number DESC LIMIT 1').get(courseId, drillId) as DrillAttemptRow | undefined;
}
export function startDrillAttempt(courseId: string, drillId: string, at = new Date(), contentRevision?: number): DrillAttemptRecord[] {
  if (contentRevision !== undefined && (!Number.isSafeInteger(contentRevision) || contentRevision < 1)) throw new Error('Invalid content revision');
  const timestamp = at.toISOString(); db.exec('BEGIN IMMEDIATE');
  try {
    const latest = latestAttempt(courseId, drillId);
    if (!latest || latest.completed_at !== null) db.prepare('INSERT INTO drill_attempts (course_id, drill_id, attempt_number, started_at, active_since, content_revision) VALUES (?, ?, ?, ?, ?, ?)').run(courseId, drillId, (latest?.attempt_number ?? 0) + 1, timestamp, timestamp, contentRevision ?? null);
    else if (latest.active_since === null) db.prepare('UPDATE drill_attempts SET active_since = ? WHERE course_id = ? AND drill_id = ? AND attempt_number = ?').run(timestamp, courseId, drillId, latest.attempt_number);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getDrillAttempts(courseId, drillId, at);
}
export function openAttemptContentRevisions(courseId: string): number[] {
  return (db.prepare('SELECT DISTINCT content_revision FROM drill_attempts WHERE course_id = ? AND completed_at IS NULL AND content_revision IS NOT NULL').all(courseId) as Array<{ content_revision: number }>).map((row) => row.content_revision);
}
export function pinOpenAttemptContentRevision(courseId: string, drillId: string, attemptNumber: number, revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid content revision');
  db.prepare('UPDATE drill_attempts SET content_revision = ? WHERE course_id = ? AND drill_id = ? AND attempt_number = ? AND completed_at IS NULL AND content_revision IS NULL').run(revision, courseId, drillId, attemptNumber);
  const row = db.prepare('SELECT content_revision FROM drill_attempts WHERE course_id = ? AND drill_id = ? AND attempt_number = ? AND completed_at IS NULL').get(courseId, drillId, attemptNumber) as { content_revision: number | null } | undefined;
  if (!row?.content_revision) throw new Error('Open attempt not found'); return row.content_revision;
}
export function pauseDrillAttempt(courseId: string, drillId: string, at = new Date()): DrillAttemptRecord[] {
  const latest = latestAttempt(courseId, drillId);
  if (latest?.completed_at === null && latest.active_since !== null) {
    const elapsed = Math.max(0, at.getTime() - Date.parse(latest.active_since));
    db.prepare('UPDATE drill_attempts SET accumulated_active_ms = accumulated_active_ms + ?, active_since = NULL WHERE course_id = ? AND drill_id = ? AND attempt_number = ?').run(elapsed, courseId, drillId, latest.attempt_number);
  }
  return getDrillAttempts(courseId, drillId, at);
}
export function completeDrillAttempt(courseId: string, drillId: string, at = new Date()): DrillAttemptRecord[] {
  const timestamp = at.toISOString(); db.exec('BEGIN IMMEDIATE');
  try {
    const latest = latestAttempt(courseId, drillId);
    if (!latest) db.prepare('INSERT INTO drill_attempts (course_id, drill_id, attempt_number, started_at, accumulated_active_ms, completed_at) VALUES (?, ?, 1, ?, 0, ?)').run(courseId, drillId, timestamp, timestamp);
    else if (latest.completed_at === null) {
      const elapsed = latest.active_since === null ? 0 : Math.max(0, at.getTime() - Date.parse(latest.active_since));
      db.prepare('UPDATE drill_attempts SET accumulated_active_ms = accumulated_active_ms + ?, active_since = NULL, completed_at = ? WHERE course_id = ? AND drill_id = ? AND attempt_number = ?').run(elapsed, timestamp, courseId, drillId, latest.attempt_number);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getDrillAttempts(courseId, drillId, at);
}
export function getAttemptStages(courseId: string, drillId: string, attemptNumber: number): AttemptStageRecord[] {
  const rows = db.prepare('SELECT stage, unlocked_at, reason, commit_sha FROM attempt_stages WHERE course_id = ? AND drill_id = ? AND attempt_number = ? ORDER BY stage').all(courseId, drillId, attemptNumber) as Array<{ stage: number; unlocked_at: string; reason: AttemptStageRecord['reason']; commit_sha: string | null }>;
  return rows.map((row) => ({ stage: row.stage, unlockedAt: row.unlocked_at, reason: row.reason, ...(row.commit_sha ? { commitSha: row.commit_sha } : {}) }));
}
export function recordAttemptStage(courseId: string, drillId: string, attemptNumber: number, stage: number, reason: AttemptStageRecord['reason'], at = new Date(), commitSha?: string): AttemptStageRecord[] {
  db.prepare('INSERT OR IGNORE INTO attempt_stages (course_id, drill_id, attempt_number, stage, unlocked_at, reason, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?)').run(courseId, drillId, attemptNumber, stage, at.toISOString(), reason, commitSha ?? null);
  return getAttemptStages(courseId, drillId, attemptNumber);
}
export function staleAttemptWorkspaces(before: Date): Array<{ courseId: string; drillId: string; attemptNumber: number }> {
  return (db.prepare('SELECT course_id, drill_id, attempt_number FROM drill_attempts WHERE started_at < ? AND completed_at IS NULL').all(before.toISOString()) as Array<{ course_id: string; drill_id: string; attempt_number: number }>).map((row) => ({ courseId: row.course_id, drillId: row.drill_id, attemptNumber: row.attempt_number }));
}
export type BookStatus = 'reading' | 'archived';
export function getBookStatuses(): Record<string, BookStatus> {
  const rows = db.prepare('SELECT course_id, status FROM book_shelf').all() as Array<{ course_id: string; status: BookStatus }>;
  return Object.fromEntries(rows.map((row) => [row.course_id, row.status]));
}
export function setBookStatus(courseId: string, status: BookStatus, workspace = defaultWorkspace): { status: BookStatus; updatedAt: string } {
  const updatedAt = new Date().toISOString();
  ensureLibraryItem('course', courseId, workspace);
  db.prepare('INSERT INTO book_shelf (course_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(course_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at').run(courseId, status, updatedAt);
  db.prepare('UPDATE library_items SET status = ?, status_explicit = 1, updated_at = ? WHERE kind = ? AND item_id = ? AND workspace_id = ?').run(status === 'archived' ? 'archived' : 'active', updatedAt, 'course', courseId, workspace);
  return { status, updatedAt };
}

import type { LibraryKind } from '../shared/courseSchema';
export type { LibraryKind } from '../shared/courseSchema';
export type LibraryStatus = 'active' | 'done' | 'archived';
export type LibraryCategory = { id: string; name: string; position: number; fixed: boolean };
export type LibraryItemState = { kind: LibraryKind; id: string; categoryId: string; position: number; status: LibraryStatus; statusExplicit: boolean; titleOverride?: string };
const now = () => new Date().toISOString();
export function ensureLibraryItem(kind: LibraryKind, id: string, workspace = defaultWorkspace): void {
  const row = db.prepare('SELECT workspace_id FROM library_items WHERE kind = ? AND item_id = ?').get(kind, id) as { workspace_id: string } | undefined;
  if (row && row.workspace_id !== workspace) throw new Error('Library item belongs to another workspace');
  if (row) return;
  const position = Number((db.prepare(`SELECT COUNT(*) AS count FROM library_items WHERE category_id = 'uncategorized' AND workspace_id = ?`).get(workspace) as { count: number }).count);
  db.prepare('INSERT INTO library_items (kind, item_id, category_id, position, status, status_explicit, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(kind, id, 'uncategorized', position, 'active', now(), workspace);
}
export function syncLibraryItems(items: Array<{ kind: LibraryKind; id: string }>, workspace = defaultWorkspace): void { for (const item of items) ensureLibraryItem(item.kind, item.id, workspace); }
export function getLibraryCategories(workspace = defaultWorkspace): LibraryCategory[] {
  const rows = db.prepare('SELECT id, name, position, fixed FROM library_categories WHERE workspace_id = ? ORDER BY position, id').all(workspace) as Array<{ id: string; name: string; position: number; fixed: number }>;
  return rows.map((row) => ({ ...row, fixed: row.fixed !== 0 }));
}
export function getLibraryItems(workspace = defaultWorkspace): LibraryItemState[] {
  const rows = db.prepare('SELECT kind, item_id, category_id, position, status, status_explicit, title_override FROM library_items WHERE workspace_id = ? ORDER BY category_id, position, kind, item_id').all(workspace) as Array<{ kind: LibraryKind; item_id: string; category_id: string; position: number; status: LibraryStatus; status_explicit: number; title_override: string | null }>;
  return rows.map((row) => ({ kind: row.kind, id: row.item_id, categoryId: row.category_id, position: row.position, status: row.status, statusExplicit: row.status_explicit !== 0, ...(row.title_override === null ? {} : { titleOverride: row.title_override }) }));
}
function normalizeCategoryPositions(categoryId: string, workspace: string): void {
  const rows = db.prepare('SELECT kind, item_id FROM library_items WHERE category_id = ? AND workspace_id = ? ORDER BY position, kind, item_id').all(categoryId, workspace) as Array<{ kind: LibraryKind; item_id: string }>;
  rows.forEach((row, position) => db.prepare('UPDATE library_items SET position = ? WHERE kind = ? AND item_id = ? AND workspace_id = ?').run(position, row.kind, row.item_id, workspace));
}
function normalizeCategoryOrder(workspace: string): void {
  const categories = getLibraryCategories(workspace); const rows = categories.filter((item) => !item.fixed);
  const fixed = categories.filter((item) => item.fixed);
  fixed.forEach((row, index) => db.prepare('UPDATE library_categories SET position = ? WHERE id = ? AND workspace_id = ?').run(index, row.id, workspace));
  rows.forEach((row, index) => db.prepare('UPDATE library_categories SET position = ? WHERE id = ? AND workspace_id = ?').run(index + fixed.length, row.id, workspace));
}
export function createLibraryCategory(name: string, workspace = defaultWorkspace): LibraryCategory {
  const id = randomUUID(); const position = getLibraryCategories(workspace).length;
  db.prepare('INSERT INTO library_categories (id, name, position, fixed, updated_at, workspace_id) VALUES (?, ?, ?, 0, ?, ?)').run(id, name, position, now(), workspace);
  return { id, name, position, fixed: false };
}
export function renameLibraryCategory(id: string, name: string, workspace = defaultWorkspace): LibraryCategory | undefined {
  const category = getLibraryCategories(workspace).find((item) => item.id === id); if (!category || category.fixed) return undefined;
  db.prepare('UPDATE library_categories SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(name, now(), id, workspace);
  return { ...category, name };
}
export function deleteLibraryCategory(id: string, workspace = defaultWorkspace): boolean {
  const category = getLibraryCategories(workspace).find((item) => item.id === id); if (!category || category.fixed) return false;
  db.exec('BEGIN'); try { const offset = Number((db.prepare(`SELECT COUNT(*) AS count FROM library_items WHERE category_id = 'uncategorized' AND workspace_id = ?`).get(workspace) as { count: number }).count); const moved = db.prepare(`UPDATE library_items SET category_id = 'uncategorized', position = position + ?, updated_at = ? WHERE category_id = ? AND workspace_id = ?`).run(offset, now(), id, workspace) as { changes: number | bigint }; db.prepare('DELETE FROM library_categories WHERE id = ? AND workspace_id = ?').run(id, workspace); if (Number(moved.changes)) normalizeCategoryPositions('uncategorized', workspace); normalizeCategoryOrder(workspace); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
export function moveLibraryCategory(id: string, position: number, workspace = defaultWorkspace): void {
  db.exec('BEGIN'); try { const all = getLibraryCategories(workspace); const rows = all.filter((item) => !item.fixed && item.id !== id); const at = Math.max(0, Math.min(position, rows.length)); const current = all.find((item) => item.id === id && !item.fixed); if (!current) throw new Error('Unknown category'); rows.splice(at, 0, current); rows.forEach((row, index) => db.prepare('UPDATE library_categories SET position = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(index + all.filter((item) => item.fixed).length, now(), row.id, workspace)); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function moveLibraryItem(kind: LibraryKind, id: string, categoryId: string, position: number, workspace = defaultWorkspace): void {
  if (categoryId !== 'uncategorized' && !getLibraryCategories(workspace).some((item) => item.id === categoryId)) throw new Error('Unknown category');
  ensureLibraryItem(kind, id, workspace); const before = getLibraryItems(workspace).find((item) => item.kind === kind && item.id === id)!;
  db.exec('BEGIN'); try { db.prepare('UPDATE library_items SET category_id = ?, position = ?, updated_at = ? WHERE kind = ? AND item_id = ? AND workspace_id = ?').run(categoryId, 1_000_000, now(), kind, id, workspace); const rows = getLibraryItems(workspace).filter((item) => item.categoryId === categoryId && !(item.kind === kind && item.id === id)); const at = Math.max(0, Math.min(position, rows.length)); rows.splice(at, 0, { ...before, categoryId }); rows.forEach((row, index) => db.prepare('UPDATE library_items SET position = ? WHERE kind = ? AND item_id = ? AND workspace_id = ?').run(index, row.kind, row.id, workspace)); if (before.categoryId !== categoryId) normalizeCategoryPositions(before.categoryId, workspace); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function setLibraryItemStatus(kind: LibraryKind, id: string, status: LibraryStatus, workspace = defaultWorkspace): void { ensureLibraryItem(kind, id, workspace); db.prepare('UPDATE library_items SET status = ?, status_explicit = 1, updated_at = ? WHERE kind = ? AND item_id = ? AND workspace_id = ?').run(status, now(), kind, id, workspace); if (kind === 'course') db.prepare('INSERT INTO book_shelf (course_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(course_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at').run(id, status === 'archived' ? 'archived' : 'reading', now()); }
export function setLibraryItemTitle(kind: LibraryKind, id: string, title: string | null, workspace = defaultWorkspace): void { ensureLibraryItem(kind, id, workspace); db.prepare('UPDATE library_items SET title_override = ?, updated_at = ? WHERE kind = ? AND item_id = ? AND workspace_id = ?').run(title, now(), kind, id, workspace); }
export function getChapterRanks(courseId: string): Record<string, number> {
  const rows = db.prepare('SELECT chapter_id, rank FROM book_chapter_rank WHERE course_id = ?').all(courseId) as Array<{ chapter_id: string; rank: number }>;
  return Object.fromEntries(rows.map((row) => [row.chapter_id, row.rank]));
}
export function getCourseTagOverrides(): Record<string, string[]> {
  const rows = db.prepare('SELECT course_id, tags_json FROM course_tag_overrides').all() as Array<{ course_id: string; tags_json: string }>;
  return Object.fromEntries(rows.map((row) => [row.course_id, JSON.parse(row.tags_json) as string[]]));
}
export function getCourseTagOverride(courseId: string): string[] | undefined {
  const row = db.prepare('SELECT tags_json FROM course_tag_overrides WHERE course_id = ?').get(courseId) as { tags_json: string } | undefined;
  return row ? JSON.parse(row.tags_json) as string[] : undefined;
}
export function setCourseTagOverride(courseId: string, tags: string[]): void {
  db.prepare('INSERT INTO course_tag_overrides (course_id, tags_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(course_id) DO UPDATE SET tags_json=excluded.tags_json, updated_at=excluded.updated_at').run(courseId, JSON.stringify(tags), new Date().toISOString());
}
export type CourseScheduleOverride = { deadline?: string | null; tier?: 1 | 2 | 3 | null };
export function getCourseScheduleOverrides(): Record<string, CourseScheduleOverride> {
  const rows = db.prepare('SELECT course_id, deadline, tier, deadline_cleared, tier_cleared FROM course_schedule_overrides').all() as Array<{ course_id: string; deadline: string | null; tier: 1 | 2 | 3 | null; deadline_cleared: number; tier_cleared: number }>;
  return Object.fromEntries(rows.map((row) => [row.course_id, { ...(row.deadline_cleared ? { deadline: null } : row.deadline === null ? {} : { deadline: row.deadline }), ...(row.tier_cleared ? { tier: null } : row.tier === null ? {} : { tier: row.tier }) }]));
}
export function setCourseScheduleOverride(courseId: string, deadline: string | null, tier: 1 | 2 | 3 | null, deadlineCleared = false, tierCleared = false): void {
  if (deadline === null && tier === null && !deadlineCleared && !tierCleared) { db.prepare('DELETE FROM course_schedule_overrides WHERE course_id = ?').run(courseId); return; }
  db.prepare('INSERT INTO course_schedule_overrides (course_id, deadline, tier, deadline_cleared, tier_cleared, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(course_id) DO UPDATE SET deadline=excluded.deadline, tier=excluded.tier, deadline_cleared=excluded.deadline_cleared, tier_cleared=excluded.tier_cleared, updated_at=excluded.updated_at').run(courseId, deadline, tier, Number(deadlineCleared), Number(tierCleared), now());
}
export function setChapterRank(courseId: string, chapterId: string, rank: number): void {
  db.prepare('INSERT INTO book_chapter_rank (course_id, chapter_id, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(course_id, chapter_id) DO UPDATE SET rank=excluded.rank, updated_at=excluded.updated_at').run(courseId, chapterId, rank, new Date().toISOString());
}

export function getProgress(courseId: string): Record<string, ProgressRecord> {
  const rows = db.prepare('SELECT drill_id, status, updated_at, notes FROM progress WHERE course_id = ?').all(courseId) as Array<{ drill_id: string; status: ProgressStatus; updated_at: string; notes: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.drill_id, { status: row.status, updatedAt: row.updated_at, ...(row.notes === null ? {} : { notes: row.notes }) }]));
}
export function setProgress(courseId: string, drillId: string, status: ProgressStatus, notes?: string): ProgressRecord {
  const updatedAt = new Date().toISOString();
  db.prepare('INSERT INTO progress (course_id, drill_id, status, notes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(course_id, drill_id) DO UPDATE SET status=excluded.status, notes=excluded.notes, updated_at=excluded.updated_at').run(courseId, drillId, status, notes ?? null, updatedAt);
  return { status, updatedAt, ...(notes === undefined ? {} : { notes }) };
}
export function getRevealedHints(courseId: string, drillId: string): string[] {
  const rows = db.prepare('SELECT hint_id FROM revealed_hints WHERE course_id = ? AND drill_id = ? ORDER BY hint_id').all(courseId, drillId) as Array<{ hint_id: string }>;
  return rows.map((row) => row.hint_id);
}
export function revealHint(courseId: string, drillId: string, hintId: string): string[] {
  db.prepare('INSERT OR IGNORE INTO revealed_hints (course_id, drill_id, hint_id, revealed_at) VALUES (?, ?, ?, ?)').run(courseId, drillId, hintId, new Date().toISOString());
  return getRevealedHints(courseId, drillId);
}
export type SubmissionResult = { status: 'passed' | 'tests-failed' | 'type-errors' | 'incomplete' | 'error'; diagnostics: Array<{ file?: string; line?: number; col?: number; message: string }>; tests: Array<{ name: string; status: string; message?: string }>; output?: { entries: Array<{ stream: 'stdout' | 'stderr'; text: string; testName?: string }>; truncated?: boolean } };
type BrowserResultLike = { status: string; tests: Array<{ name: string; status: string; message?: string }>; diagnostics?: Array<{ file?: string; line?: number; col?: number; message: string }>; output?: unknown; counts?: { total: number; passed: number; failed: number; skipped: number; pending: number } };
const acceptanceTestName = (name: string) => /(?:^|[\\/])(?:\.ir-acceptance|acceptance)[\\/]stage-\d+\.(?:test\.(?:ts|tsx)|py)(?:\s|$)/.test(name);
const allPassed = (result: BrowserResultLike, requireTest = true) => result.status === 'passed' && (!requireTest || result.tests.length > 0) && result.tests.every((test) => test.status === 'passed');
export function browserFacingAiResult<T extends BrowserResultLike>(workspace: T, acceptance?: BrowserResultLike): T {
  const hidden = acceptance?.tests ?? workspace.tests.filter((test) => acceptanceTestName(test.name));
  if (!acceptance && !hidden.length) return workspace;
  const visible = acceptance ? workspace.tests : workspace.tests.filter((test) => !acceptanceTestName(test.name));
  const passed = hidden.filter((test) => test.status === 'passed').length;
  const aggregate = { name: `Acceptance: ${passed}/${hidden.length} passed`, status: hidden.length > 0 && hidden.every((test) => test.status === 'passed') ? 'passed' : 'failed' };
  const status = acceptance ? allPassed(workspace) && allPassed(acceptance) ? 'passed' : workspace.status === 'error' || acceptance.status === 'error' ? 'error' : workspace.status === 'type-errors' ? 'type-errors' : workspace.status === 'failed' ? 'failed' : 'tests-failed' : workspace.status;
  const diagnostics = workspace.diagnostics?.filter((item) => !item.file || !acceptanceTestName(item.file));
  const tests = [...visible, ...(acceptance?.status === 'error' ? [{ name: 'Test execution error', status: 'failed', message: courseTestTimeoutMessage() }] : []), aggregate];
  const counts = workspace.counts ? { total: tests.length, passed: tests.filter((test) => test.status === 'passed').length, failed: tests.filter((test) => test.status === 'failed').length, skipped: tests.filter((test) => test.status === 'skipped').length, pending: tests.filter((test) => test.status === 'pending' || test.status === 'todo').length } : undefined;
  if (acceptance) return { ...workspace, status, tests, ...(diagnostics ? { diagnostics } : {}), ...(counts ? { counts } : {}) };
  const { output: _hiddenOutput, ...safe } = workspace;
  return { ...safe, status, tests, ...(diagnostics ? { diagnostics } : {}), ...(counts ? { counts } : {}) } as T;
}
export type WorkspaceFile = { path: string; size: number; mode: number; content?: string; binary?: true; sha256?: string };
export type WorkspaceFiles = { files: WorkspaceFile[]; totalBytes: number };
export type SubmissionRecord = { id: number; submittedAt: string; result: SubmissionResult; name?: string; commitSha?: string };
const SUBMISSION_HISTORY_LIMIT = 50;
const WORKSPACE_FILE_LIMITS = { files: 2_000, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 } as const;
const WORKSPACE_FILE_EXCLUDED = new Set(['node_modules', '.git', '.ir-acceptance', 'dist', 'build', 'coverage', '__pycache__', '.pytest_cache', '.venv']);
function validateWorkspaceFilePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..' || WORKSPACE_FILE_EXCLUDED.has(part))) throw new Error(`Invalid workspace file path: ${path}`);
}
export function validateWorkspaceFiles(value: WorkspaceFiles): WorkspaceFiles {
  if (!value || !Array.isArray(value.files) || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.files.length > WORKSPACE_FILE_LIMITS.files) throw new Error('Invalid workspace files');
  let total = 0; const seen = new Set<string>();
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string') throw new Error('Invalid workspace file');
    validateWorkspaceFilePath(file.path); if (seen.has(file.path)) throw new Error(`Duplicate workspace file path: ${file.path}`); seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > WORKSPACE_FILE_LIMITS.fileBytes || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error(`Invalid workspace file metadata: ${file.path}`);
    if (file.binary === true) { if (file.content !== undefined || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid binary workspace file: ${file.path}`); }
    else { if (typeof file.content !== 'string' || Buffer.byteLength(file.content) !== file.size || file.content.includes('\0')) throw new Error(`Invalid text workspace file: ${file.path}`); }
    total += file.size; if (total > WORKSPACE_FILE_LIMITS.totalBytes) throw new Error('Workspace total limit exceeded');
  }
  if (total !== value.totalBytes) throw new Error('Workspace total does not match files');
  return value;
}
export function getSubmissions(courseId: string, drillId: string, aiCoding = false): SubmissionRecord[] {
  const rows = db.prepare('SELECT id, submitted_at, result_json, custom_name, commit_sha FROM submissions WHERE course_id = ? AND drill_id = ? ORDER BY id').all(courseId, drillId) as Array<{ id: number; submitted_at: string; result_json: string; custom_name: string | null; commit_sha: string | null }>;
  return rows.map((row) => { const result = JSON.parse(row.result_json) as SubmissionResult; return { id: row.id, submittedAt: row.submitted_at, result: aiCoding ? browserFacingAiResult(result) : result, ...(row.commit_sha ? { commitSha: row.commit_sha } : {}), ...(row.custom_name === null ? {} : { name: row.custom_name }) }; });
}
export function addGitSubmission(courseId: string, drillId: string, result: SubmissionResult, commitSha: string, aiCoding = false): SubmissionRecord[] {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commitSha)) throw new Error('Invalid workspace commit');
  db.exec('BEGIN');
  try {
    // Older databases require a non-null content placeholder; source lives in Git.
    db.prepare("INSERT INTO submissions (course_id, drill_id, submitted_at, content, result_json, commit_sha) VALUES (?, ?, ?, '', ?, ?)").run(courseId, drillId, new Date().toISOString(), JSON.stringify(result), commitSha);
    db.prepare('DELETE FROM submissions WHERE course_id = ? AND drill_id = ? AND id NOT IN (SELECT id FROM submissions WHERE course_id = ? AND drill_id = ? ORDER BY id DESC LIMIT ?)').run(courseId, drillId, courseId, drillId, SUBMISSION_HISTORY_LIMIT);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getSubmissions(courseId, drillId, aiCoding);
}
export function renameSubmission(courseId: string, drillId: string, id: number, name: string | null, aiCoding = false): SubmissionRecord[] | undefined {
  const updated = db.prepare('UPDATE submissions SET custom_name = ? WHERE course_id = ? AND drill_id = ? AND id = ?').run(name, courseId, drillId, id);
  return Number(updated.changes) ? getSubmissions(courseId, drillId, aiCoding) : undefined;
}
export function deleteSubmission(courseId: string, drillId: string, id: number, aiCoding = false): SubmissionRecord[] | undefined {
  const deleted = db.prepare('DELETE FROM submissions WHERE course_id = ? AND drill_id = ? AND id = ?').run(courseId, drillId, id);
  return Number(deleted.changes) ? getSubmissions(courseId, drillId, aiCoding) : undefined;
}
export type OutlineNodeState = { folded?: boolean; checked?: boolean };
type OutlineNodeRow = { node_id: string; folded: number | null; checked: number | null };
export function getOutlineState(courseId: string, drillId: string): Record<string, OutlineNodeState> {
  const rows = db.prepare('SELECT node_id, folded, checked FROM outline_nodes WHERE course_id = ? AND drill_id = ?').all(courseId, drillId) as OutlineNodeRow[];
  return Object.fromEntries(rows.map((row) => [row.node_id, { ...(row.folded === null ? {} : { folded: row.folded !== 0 }), ...(row.checked === null ? {} : { checked: row.checked !== 0 }) }]));
}
export function setOutlineNode(courseId: string, drillId: string, nodeId: string, patch: OutlineNodeState): void {
  const current = getOutlineState(courseId, drillId)[nodeId] ?? {};
  const folded = patch.folded ?? current.folded ?? null;
  const checked = patch.checked ?? current.checked ?? null;
  const updatedAt = new Date().toISOString();
  db.prepare('INSERT INTO outline_nodes (course_id, drill_id, node_id, folded, checked, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(course_id, drill_id, node_id) DO UPDATE SET folded=excluded.folded, checked=excluded.checked, updated_at=excluded.updated_at WHERE excluded.updated_at >= outline_nodes.updated_at').run(courseId, drillId, nodeId, folded === null ? null : Number(folded), checked === null ? null : Number(checked), updatedAt);
}
/** Reset recall checks, including IDs no longer present in regenerated content. */
export function clearRecallChecks(courseId: string, drillId: string): void {
  db.prepare('UPDATE outline_nodes SET checked = 0, updated_at = ? WHERE course_id = ? AND drill_id = ? AND checked IS NOT NULL').run(new Date().toISOString(), courseId, drillId);
}
// Orphaned node ids intentionally remain: a regenerated outline simply makes them invisible.
export function setOutlineNodesBulk(courseId: string, drillId: string, nodeIds: string[], patch: OutlineNodeState): void {
  db.exec('BEGIN');
  try { const current = getOutlineState(courseId, drillId); for (const nodeId of nodeIds) { const prior = current[nodeId] ?? {}; setOutlineNodeWithCurrent(courseId, drillId, nodeId, patch, prior); } db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function setOutlineNodeWithCurrent(courseId: string, drillId: string, nodeId: string, patch: OutlineNodeState, current: OutlineNodeState): void {
  const folded = patch.folded ?? current.folded ?? null;
  const checked = patch.checked ?? current.checked ?? null;
  const updatedAt = new Date().toISOString();
  db.prepare('INSERT INTO outline_nodes (course_id, drill_id, node_id, folded, checked, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(course_id, drill_id, node_id) DO UPDATE SET folded=excluded.folded, checked=excluded.checked, updated_at=excluded.updated_at WHERE excluded.updated_at >= outline_nodes.updated_at').run(courseId, drillId, nodeId, folded === null ? null : Number(folded), checked === null ? null : Number(checked), updatedAt);
}
export type TestFileRecord = { status: string; tests: Array<{ name: string; status: string; message?: string }>; updatedAt: string };
function timestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export function upsertTestFile(filePath: string, status: string, tests: TestFileRecord['tests'], updatedAt: string): boolean {
  const existing = db.prepare('SELECT updated_at FROM test_results WHERE file_path = ?').get(filePath) as { updated_at: string } | undefined;
  const incomingMs = timestampMs(updatedAt);
  if (incomingMs === undefined) return false;
  const existingMs = existing ? timestampMs(existing.updated_at) : undefined;
  if (existingMs !== undefined && incomingMs < existingMs) return false;
  // Compare parsed instants above rather than relying on ISO string ordering:
  // extended-year and malformed legacy values are not lexicographically safe.
  db.prepare('INSERT INTO test_results (file_path, status, tests_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET status=excluded.status, tests_json=excluded.tests_json, updated_at=excluded.updated_at').run(filePath, status, JSON.stringify(tests), updatedAt);
  return true;
}
export function getAllTestFiles(aiCodingPaths: ReadonlySet<string> = new Set()): Record<string, TestFileRecord> {
  const rows = db.prepare('SELECT file_path, status, tests_json, updated_at FROM test_results ORDER BY file_path').all() as Array<{ file_path: string; status: string; tests_json: string; updated_at: string }>;
  return Object.fromEntries(rows.map((row) => { const result = { status: row.status, tests: JSON.parse(row.tests_json) as TestFileRecord['tests'], updatedAt: row.updated_at }; return [row.file_path, aiCodingPaths.has(row.file_path) ? browserFacingAiResult(result) : result]; }));
}
export async function resetProgress(courseId: string, chapterId?: string): Promise<{ cleared: number }> {
  let ids: string[] | undefined;
  if (chapterId !== undefined) { const course = await loadCourse(courseId); if (!course) throw new Error(`Unknown course: ${courseId}`); ids = chapterDrillIds(course, chapterId); if (!ids) throw new Error(`Unknown chapter: ${chapterId}`); if (!ids.length) return { cleared: 0 }; }
  const clause = ids ? `course_id = ? AND drill_id IN (${ids.map(() => '?').join(',')})` : 'course_id = ?'; const args = ids ? [courseId, ...ids] : [courseId];
  db.exec('BEGIN');
  try { const progress = db.prepare(`DELETE FROM progress WHERE ${clause}`).run(...args); const hints = db.prepare(`DELETE FROM revealed_hints WHERE ${clause}`).run(...args); const submissions = db.prepare(`DELETE FROM submissions WHERE ${clause}`).run(...args); const stages = db.prepare(`DELETE FROM attempt_stages WHERE ${clause}`).run(...args); db.exec('COMMIT'); return { cleared: Number(progress.changes) + Number(hints.changes) + Number(submissions.changes) + Number(stages.changes) }; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export { db, dbPath };
