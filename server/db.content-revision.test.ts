// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { completeDrillAttempt, db, ensureDrillAttemptSchema, openAttemptContentRevisions, pauseDrillAttempt, startDrillAttempt } from './db';

describe('attempt content revisions', () => {
  beforeEach(() => { db.prepare('DELETE FROM drill_attempts').run(); });
  it('migrates existing attempts without changing their data', () => {
    const fixture = new DatabaseSync(':memory:');
    fixture.exec("CREATE TABLE drill_attempts(course_id TEXT NOT NULL, drill_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, accumulated_active_ms INTEGER NOT NULL DEFAULT 0, active_since TEXT, completed_at TEXT, PRIMARY KEY(course_id,drill_id,attempt_number)); INSERT INTO drill_attempts VALUES('c','d',1,'then',0,NULL,NULL)");
    ensureDrillAttemptSchema(fixture); ensureDrillAttemptSchema(fixture);
    expect(fixture.prepare('SELECT started_at,content_revision FROM drill_attempts').get()).toEqual({ started_at: 'then', content_revision: null });
    fixture.close();
  });
  it('pins the starting revision across pause and resume, and records the next attempt separately', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(startDrillAttempt('course', 'drill', at, 1)[0].contentRevision).toBe(1);
    pauseDrillAttempt('course', 'drill', at);
    expect(startDrillAttempt('course', 'drill', at, 2)[0].contentRevision).toBe(1);
    expect(openAttemptContentRevisions('course')).toEqual([1]);
    completeDrillAttempt('course', 'drill', at);
    expect(startDrillAttempt('course', 'drill', at, 2)[1].contentRevision).toBe(2);
    expect(openAttemptContentRevisions('course')).toEqual([2]);
  });
});
