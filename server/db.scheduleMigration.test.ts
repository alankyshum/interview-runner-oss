// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ensureCourseScheduleSchema } from './db';

it('migrates existing schedule rows without changing their meaning and is idempotent', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE course_schedule_overrides (course_id TEXT PRIMARY KEY, deadline TEXT, tier INTEGER CHECK (tier IN (1,2,3)), updated_at TEXT NOT NULL);
      INSERT INTO course_schedule_overrides VALUES ('both','2027-01-15',2,'time'), ('deadline','2027-02-01',NULL,'time'), ('tier',NULL,3,'time');`);
    ensureCourseScheduleSchema(database); ensureCourseScheduleSchema(database);
    expect(database.prepare('SELECT * FROM course_schedule_overrides ORDER BY course_id').all()).toEqual([
      { course_id: 'both', deadline: '2027-01-15', tier: 2, updated_at: 'time', deadline_cleared: 0, tier_cleared: 0 },
      { course_id: 'deadline', deadline: '2027-02-01', tier: null, updated_at: 'time', deadline_cleared: 0, tier_cleared: 0 },
      { course_id: 'tier', deadline: null, tier: 3, updated_at: 'time', deadline_cleared: 0, tier_cleared: 0 },
    ]);
  } finally { database.close(); }
});
