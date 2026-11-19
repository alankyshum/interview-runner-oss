// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { completeDrillAttempt, db, ensureDrillAttemptSchema, getDrillAttempts, pauseDrillAttempt, startDrillAttempt } from './db';

const at = (value: string) => new Date(value);

describe('drill attempt persistence', () => {
  beforeEach(() => { db.prepare('DELETE FROM drill_attempts').run(); });

  it('accumulates only active spans and preserves completed attempts across a redo', () => {
    startDrillAttempt('course', 'drill', at('2026-10-25T10:00:00.000Z'));
    startDrillAttempt('course', 'drill', at('2026-10-25T10:00:01.000Z'));
    expect(pauseDrillAttempt('course', 'drill', at('2026-10-25T10:00:05.000Z'))[0]).toMatchObject({ attemptNumber: 1, accumulatedActiveMs: 5_000 });
    startDrillAttempt('course', 'drill', at('2026-10-25T10:00:10.000Z'));
    pauseDrillAttempt('course', 'drill', at('2026-10-25T10:00:13.000Z'));
    const first = completeDrillAttempt('course', 'drill', at('2026-10-25T10:00:15.000Z'));
    expect(first).toEqual([{ attemptNumber: 1, startedAt: '2026-10-25T10:00:00.000Z', accumulatedActiveMs: 8_000, elapsedMs: 8_000, completedAt: '2026-10-25T10:00:15.000Z' }]);

    startDrillAttempt('course', 'drill', at('2026-10-25T10:00:20.000Z'));
    const repeated = completeDrillAttempt('course', 'drill', at('2026-10-25T10:00:24.000Z'));
    expect(repeated).toHaveLength(2);
    expect(repeated[1]).toEqual({ attemptNumber: 2, startedAt: '2026-10-25T10:00:20.000Z', accumulatedActiveMs: 4_000, elapsedMs: 4_000, completedAt: '2026-10-25T10:00:24.000Z' });
    expect(completeDrillAttempt('course', 'drill', at('2026-10-25T10:01:00.000Z'))).toEqual(repeated);
  });

  it('creates a zero-duration completed attempt when done is recorded without starting the timer', () => {
    expect(completeDrillAttempt('course', 'drill', at('2026-10-25T12:00:00.000Z'))).toEqual([{ attemptNumber: 1, startedAt: '2026-10-25T12:00:00.000Z', accumulatedActiveMs: 0, elapsedMs: 0, completedAt: '2026-10-25T12:00:00.000Z' }]);
    expect(getDrillAttempts('course', 'drill', at('2026-10-25T13:00:00.000Z'))[0].elapsedMs).toBe(0);
  });

  it('adds the attempt table without changing an existing progress table', () => {
    const fixture = new DatabaseSync(':memory:');
    fixture.exec("CREATE TABLE progress (course_id TEXT, drill_id TEXT, status TEXT, updated_at TEXT); INSERT INTO progress VALUES ('c', 'd', 'done', '2026-01-01T00:00:00.000Z');");
    ensureDrillAttemptSchema(fixture);
    expect(fixture.prepare('SELECT status FROM progress').get()).toEqual({ status: 'done' });
    expect(fixture.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drill_attempts'").get()).toEqual({ name: 'drill_attempts' });
    fixture.close();
  });
});
