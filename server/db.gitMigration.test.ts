// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ensureDrillAttemptSchema, ensureProgressSchema, ensureSubmissionSchema } from './db';

describe('git revision schema migration', () => {
  it('adds nullable revision columns idempotently without rewriting legacy data', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE progress (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('not-started','in-progress','blocked','done')), notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));
        CREATE TABLE drill_attempts (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, accumulated_active_ms INTEGER NOT NULL, active_since TEXT, completed_at TEXT, PRIMARY KEY (course_id, drill_id, attempt_number));
        CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT NOT NULL, drill_id TEXT NOT NULL, submitted_at TEXT NOT NULL, content TEXT NOT NULL, result_json TEXT NOT NULL, custom_name TEXT, timeline_json TEXT, snapshot_id TEXT);
        CREATE TABLE attempt_stages (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, stage INTEGER NOT NULL, unlocked_at TEXT NOT NULL, reason TEXT NOT NULL, snapshot_id TEXT, PRIMARY KEY (course_id, drill_id, attempt_number, stage));
        CREATE TABLE workspace_snapshots (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, stage INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, files_json TEXT NOT NULL, total_bytes INTEGER NOT NULL);
        CREATE TABLE workspace_blobs (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL);
        CREATE TABLE draft_timelines (course_id TEXT NOT NULL, drill_id TEXT NOT NULL, timeline_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, drill_id));
        INSERT INTO progress VALUES ('c','d','done','notes','time');
        INSERT INTO drill_attempts VALUES ('c','d',1,'start',42,NULL,'end');
        INSERT INTO submissions VALUES (1,'c','d','time','source','{"status":"passed","diagnostics":[],"tests":[]}','name','[]','snap');
        INSERT INTO attempt_stages VALUES ('c','d',1,2,'time','manual','snap');
        INSERT INTO workspace_snapshots VALUES ('snap','c','d',1,1,'run','time','[]',0);
        INSERT INTO workspace_blobs VALUES ('hash',X'0102',2);
        INSERT INTO draft_timelines VALUES ('c','d','[]','time');
      `);
      const tables = ['progress', 'drill_attempts', 'submissions', 'attempt_stages', 'workspace_snapshots', 'workspace_blobs', 'draft_timelines'];
      const before = Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]));
      for (let i = 0; i < 2; i++) {
        ensureProgressSchema(database);
        ensureDrillAttemptSchema(database);
        ensureSubmissionSchema(database);
      }
      for (const table of tables) {
        const rows = database.prepare(`SELECT * FROM ${table}`).all().map(({ commit_sha: _sha, content_revision: _revision, ...row }) => row);
        expect(rows, table).toEqual(before[table]);
      }
      expect(database.prepare('SELECT commit_sha FROM submissions').get()).toEqual({ commit_sha: null });
      expect(database.prepare('SELECT commit_sha FROM attempt_stages').get()).toEqual({ commit_sha: null });
      expect(database.prepare('SELECT content_revision FROM drill_attempts').get()).toEqual({ content_revision: null });
      // Reopen the already-migrated fixture through the real application module.
      // The module normally opens its own isolated database under Vitest; replace
      // only that constructor so its readers use this old-schema fixture instead.
      vi.resetModules();
      vi.doMock('node:sqlite', () => ({ DatabaseSync: vi.fn(function () { return database; }) }));
      vi.doMock('./courses', () => ({ loadCourse: async () => ({ id: 'c' }), chapterDrillIds: () => ['d'] }));
      const application = await import('./db');
      expect(application.getProgress('c')).toMatchObject({ d: { status: 'done', notes: 'notes' } });
      expect(application.getDrillAttempts('c', 'd')).toMatchObject([{ attemptNumber: 1, accumulatedActiveMs: 42, completedAt: 'end' }]);
      expect(application.getSubmissions('c', 'd')).toMatchObject([{ id: 1, name: 'name', result: { status: 'passed' } }]);
      expect(application.getAttemptStages('c', 'd', 1)).toMatchObject([{ stage: 2, reason: 'manual' }]);
      for (const table of tables) {
        const rows = database.prepare(`SELECT * FROM ${table}`).all().map(({ commit_sha: _sha, content_revision: _revision, ...row }) => row);
        expect(rows, table).toEqual(before[table]);
      }
      database.exec(`
        INSERT INTO progress VALUES ('c','other','done','other notes','time');
        INSERT INTO drill_attempts (course_id,drill_id,attempt_number,started_at,accumulated_active_ms,active_since,completed_at) VALUES ('c','other',1,'start',42,NULL,'end');
        INSERT INTO submissions (course_id,drill_id,submitted_at,content,result_json,custom_name,commit_sha) VALUES ('c','other','time','retained source','{"status":"passed","diagnostics":[],"tests":[]}','other name','${'a'.repeat(40)}');
        INSERT INTO attempt_stages (course_id,drill_id,attempt_number,stage,unlocked_at,reason,commit_sha) VALUES ('c','other',1,2,'time','manual','${'b'.repeat(40)}');
        INSERT INTO revealed_hints VALUES ('c','d','hint','time');
      `);
      const newSubmission = application.addGitSubmission('c', 'd', { status: 'passed', diagnostics: [], tests: [] }, 'c'.repeat(40)).at(-1)!;
      application.deleteSubmission('c', 'd', newSubmission.id);
      expect(await application.resetProgress('c', 'chapter')).toEqual({ cleared: 4 });
      for (const table of ['workspace_snapshots', 'workspace_blobs', 'draft_timelines']) expect(database.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before[table]);
      expect(application.getProgress('c')).toMatchObject({ other: { status: 'done', notes: 'other notes' } });
      expect(application.getProgress('c')).not.toHaveProperty('d');
      expect(application.getDrillAttempts('c', 'd')).toHaveLength(1);
      expect(application.getDrillAttempts('c', 'other')).toMatchObject([{ attemptNumber: 1, accumulatedActiveMs: 42, completedAt: 'end' }]);
      expect(application.getSubmissions('c', 'd')).toEqual([]);
      expect(application.getSubmissions('c', 'other')).toMatchObject([{ name: 'other name', result: { status: 'passed' }, commitSha: 'a'.repeat(40) }]);
      expect(application.getAttemptStages('c', 'd', 1)).toEqual([]);
      expect(application.getAttemptStages('c', 'other', 1)).toMatchObject([{ stage: 2, reason: 'manual', commitSha: 'b'.repeat(40) }]);
    } finally { vi.doUnmock('node:sqlite'); vi.doUnmock('./courses'); vi.resetModules(); database.close(); }
  });
});
