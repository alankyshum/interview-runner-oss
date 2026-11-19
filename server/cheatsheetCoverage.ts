import { stateDb } from './db';
import { COVERAGE_MAX_REGIONS, COVERAGE_REGION_ID, COVERAGE_SIGNALS, COVERAGE_WRITER, type CoverageSignals, type CoverageSnapshot } from '../shared/cheatsheetCoverage';

const db = stateDb();
let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cheatsheet_coverage_meta (course_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cheatsheet_coverage_regions (course_id TEXT NOT NULL, region_id TEXT NOT NULL, selection INTEGER NOT NULL, deep INTEGER NOT NULL, map INTEGER NOT NULL, link INTEGER NOT NULL, copy INTEGER NOT NULL, dwell_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(course_id, region_id));
CREATE TABLE IF NOT EXISTS cheatsheet_coverage_writers (course_id TEXT NOT NULL, writer TEXT NOT NULL, sequence INTEGER NOT NULL, window_start INTEGER NOT NULL DEFAULT 0, window_count INTEGER NOT NULL DEFAULT 0, last_write INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(course_id, writer));`);
    const columns = db.prepare('PRAGMA table_info(cheatsheet_coverage_writers)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'window_start')) db.exec('ALTER TABLE cheatsheet_coverage_writers ADD COLUMN window_start INTEGER NOT NULL DEFAULT 0');
    if (!columns.some((column) => column.name === 'window_count')) db.exec('ALTER TABLE cheatsheet_coverage_writers ADD COLUMN window_count INTEGER NOT NULL DEFAULT 0');
    if (!columns.some((column) => column.name === 'last_write')) db.exec('ALTER TABLE cheatsheet_coverage_writers ADD COLUMN last_write INTEGER NOT NULL DEFAULT 0');
    db.exec('COMMIT'); schemaReady = true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

type Batch = { generation: number; writer: string; sequence: number; createdAt: number; events: Record<string, CoverageSignals> };
export function coverageBatch(value: unknown): Batch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'createdAt,events,generation,sequence,writer') return;
  const { generation, sequence, writer, createdAt, events } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(generation) || Number(generation) < 0 || !Number.isSafeInteger(sequence) || Number(sequence) < 1 || !Number.isSafeInteger(createdAt) || Number(createdAt) < 0 || Number(createdAt) > Date.now() + 300_000 || typeof writer !== 'string' || !COVERAGE_WRITER.test(writer) || !events || typeof events !== 'object' || Array.isArray(events)) return;
  const entries = Object.entries(events);
  if (!entries.length || entries.length > COVERAGE_MAX_REGIONS || entries.some(([id, raw]) => !COVERAGE_REGION_ID.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== [...COVERAGE_SIGNALS].sort().join(',') || COVERAGE_SIGNALS.some((key) => !Number.isSafeInteger((raw as Record<string, unknown>)[key]) || Number((raw as Record<string, unknown>)[key]) < 0 || Number((raw as Record<string, unknown>)[key]) > (key === 'dwellMs' ? 60_000 : 1000)))) return;
  return value as Batch;
}
export function getCheatsheetCoverage(courseId: string): CoverageSnapshot {
  ensureSchema();
  const meta = db.prepare('SELECT generation, revision FROM cheatsheet_coverage_meta WHERE course_id = ?').get(courseId) as { generation: number; revision: number } | undefined;
  const rows = db.prepare('SELECT region_id, selection, deep, map, link, copy, dwell_ms, updated_at FROM cheatsheet_coverage_regions WHERE course_id = ?').all(courseId) as Array<{ region_id: string; selection: number; deep: number; map: number; link: number; copy: number; dwell_ms: number; updated_at: number }>;
  return { generation: meta?.generation ?? 0, revision: meta?.revision ?? 0, regions: Object.fromEntries(rows.map(({ region_id, dwell_ms, updated_at, ...counts }) => [region_id, { ...counts, dwellMs: dwell_ms, updatedAt: updated_at }])) };
}
export function addCheatsheetCoverage(courseId: string, batch: Batch): { applied: boolean; snapshot: CoverageSnapshot } | null {
  ensureSchema();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getCheatsheetCoverage(courseId);
    if (current.generation !== batch.generation) { db.exec('ROLLBACK'); return null; }
    const last = db.prepare('SELECT sequence, window_start, window_count FROM cheatsheet_coverage_writers WHERE course_id = ? AND writer = ?').get(courseId, batch.writer) as { sequence: number; window_start: number; window_count: number } | undefined;
    const now = Date.now();
    const windowStart = last && now >= last.window_start && now - last.window_start < 60_000 ? last.window_start : now;
    const windowCount = last && windowStart === last.window_start ? last.window_count + 1 : 1;
    if (windowCount > 60) throw Object.assign(new Error('Coverage writer rate limit exceeded'), { status: 429 });
    if (last && last.sequence >= batch.sequence) {
      db.prepare('UPDATE cheatsheet_coverage_writers SET window_start = ?, window_count = ? WHERE course_id = ? AND writer = ?').run(windowStart, windowCount, courseId, batch.writer);
      db.exec('COMMIT'); return { applied: false, snapshot: current };
    }
    if (!last) {
      if (!Object.values(batch.events).some((event) => COVERAGE_SIGNALS.some((key) => event[key] > 0))) throw Object.assign(new Error('Empty coverage batch'), { status: 400 });
      // A replay from an evicted writer must not be applied twice.
      if (batch.sequence !== 1 || batch.createdAt < now - 14 * 24 * 60 * 60 * 1000) throw Object.assign(new Error('Coverage writer expired'), { status: 409 });
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM cheatsheet_coverage_writers WHERE course_id = ?').get(courseId) as { count: number };
      if (count >= 64) {
        const stale = db.prepare('SELECT writer FROM cheatsheet_coverage_writers WHERE course_id = ? AND last_write < ? ORDER BY last_write, writer LIMIT 1').get(courseId, now - 14 * 24 * 60 * 60 * 1000) as { writer: string } | undefined;
        if (!stale) throw Object.assign(new Error('Coverage writer limit reached'), { status: 429 });
        db.prepare('DELETE FROM cheatsheet_coverage_writers WHERE course_id = ? AND writer = ?').run(courseId, stale.writer);
      }
    }
    const keys = new Set([...Object.keys(current.regions), ...Object.keys(batch.events)]);
    if (keys.size > COVERAGE_MAX_REGIONS) throw Object.assign(new Error('Too many coverage regions'), { status: 400 });
    const update = db.prepare(`INSERT INTO cheatsheet_coverage_regions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(course_id, region_id) DO UPDATE SET selection=MIN(1000000000,selection+excluded.selection), deep=MIN(1000000000,deep+excluded.deep), map=MIN(1000000000,map+excluded.map), link=MIN(1000000000,link+excluded.link), copy=MIN(1000000000,copy+excluded.copy), dwell_ms=MIN(1000000000,dwell_ms+excluded.dwell_ms), updated_at=excluded.updated_at`);
    for (const [id, e] of Object.entries(batch.events)) update.run(courseId, id, e.selection, e.deep, e.map, e.link, e.copy, e.dwellMs, now);
    db.prepare('INSERT INTO cheatsheet_coverage_writers (course_id, writer, sequence, window_start, window_count, last_write) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(course_id, writer) DO UPDATE SET sequence=excluded.sequence, window_start=excluded.window_start, window_count=excluded.window_count, last_write=excluded.last_write').run(courseId, batch.writer, batch.sequence, windowStart, windowCount, now);
    db.prepare('INSERT INTO cheatsheet_coverage_meta VALUES (?, 0, 1) ON CONFLICT(course_id) DO UPDATE SET revision=revision+1').run(courseId);
    const snapshot = getCheatsheetCoverage(courseId); db.exec('COMMIT'); return { applied: true, snapshot };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function resetCheatsheetCoverage(courseId: string, revision: number): CoverageSnapshot | null {
  ensureSchema();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getCheatsheetCoverage(courseId);
    if (current.revision !== revision) { db.exec('ROLLBACK'); return null; }
    db.prepare('DELETE FROM cheatsheet_coverage_regions WHERE course_id = ?').run(courseId);
    db.prepare('DELETE FROM cheatsheet_coverage_writers WHERE course_id = ?').run(courseId);
    db.prepare('INSERT INTO cheatsheet_coverage_meta VALUES (?, 1, 1) ON CONFLICT(course_id) DO UPDATE SET generation=generation+1, revision=revision+1').run(courseId);
    const result = getCheatsheetCoverage(courseId); db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
