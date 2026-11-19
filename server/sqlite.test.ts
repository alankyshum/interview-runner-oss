// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Better from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrate } from './content/contentDb';
import { configureSqliteBusyTimeout, SQLITE_BUSY_TIMEOUT_MS } from './sqlite';

it.each(['node:sqlite', 'better-sqlite3'] as const)('configures bounded lock waits without changing journal mode for %s', (provider) => {
  const db = provider === 'node:sqlite' ? new DatabaseSync(':memory:') : new Better(':memory:');
  try {
    const journal = db.prepare('PRAGMA journal_mode').get();
    configureSqliteBusyTimeout(db);
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: SQLITE_BUSY_TIMEOUT_MS });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual(journal);
    migrate(db);
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: SQLITE_BUSY_TIMEOUT_MS });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual(journal);
  } finally { db.close(); }
});

it('configures the application progress database', async () => {
  const { stateDb } = await import('./db');
  expect(stateDb().prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: SQLITE_BUSY_TIMEOUT_MS });
});

it.each(['node:sqlite', 'better-sqlite3'] as const)('waits for a short real SQLite lock with %s', async (provider) => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-lock-')); const path = join(root, 'test.db');
  const initial = new DatabaseSync(path); initial.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('ok')"); initial.close();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN EXCLUSIVE'); process.send('locked'); setTimeout(()=>{d.exec('ROLLBACK');d.close()},200);`, path], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    const db = provider === 'node:sqlite' ? new DatabaseSync(path) : new Better(path);
    try {
      configureSqliteBusyTimeout(db); const start = performance.now();
      expect(db.prepare('SELECT value FROM sample').get()).toMatchObject({ value: 'ok' });
      const waited = performance.now() - start; expect(waited).toBeGreaterThan(20); expect(waited).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS);
      expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' });
    } finally { db.close(); }
    const [code] = await exited; expect(code).toBe(0);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
