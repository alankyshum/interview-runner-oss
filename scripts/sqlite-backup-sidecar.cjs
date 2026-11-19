'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');

const VERSION = 'interview-runner-sqlite-backup-v1';
const coreTables = { 'content.db': ['course', 'lesson', 'blob', 'lesson_file', 'course_revision'], 'progress.db': ['progress', 'api_key'] };

async function main({ order, allowMissingContent }) {
  if (!Array.isArray(order) || order.length !== 2 || new Set(order).size !== 2 || order.some((name) => !Object.hasOwn(coreTables, name)) || typeof allowMissingContent !== 'boolean') throw new Error('Invalid SQLite backup request');
  const output = fs.lstatSync('/backup');
  if (!output.isDirectory() || output.isSymbolicLink() || output.uid !== process.getuid() || (output.mode & 0o777) !== 0o700) throw new Error('Invalid SQLite backup output directory owner or mode');
  const deadline = Date.now() + 60000;
  const alarm = setTimeout(() => { console.error('SQLite backup retry deadline exceeded'); process.exit(1); }, 60000);
  const yieldSignal = new Int32Array(new SharedArrayBuffer(4));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = {};
  try {
    for (const name of order) {
      const source = `/data/${name}`; const destination = `/backup/${name}`;
      let sourceStat;
      try { sourceStat = fs.lstatSync(source); }
      catch (error) { if (error.code === 'ENOENT' && name === 'content.db' && allowMissingContent) { results[name] = null; continue; } throw error; }
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Invalid source database: ${name}`);
      fs.closeSync(fs.openSync(destination, 'wx', 0o600));
      let attempts = 0; let backoff = 100;
      while (Date.now() < deadline) {
        attempts++;
        let db;
        try {
          db = new Database(source, { readonly: true, fileMustExist: true, timeout: 5000 });
          db.pragma('busy_timeout = 5000');
          const progress = await db.backup(destination, { progress() { Atomics.wait(yieldSignal, 0, 0, 1); return 32; } });
          const stat = fs.lstatSync(destination);
          if (!progress || !Number.isInteger(progress.totalPages) || progress.totalPages < 1 || progress.remainingPages !== 0 || !stat.isFile() || stat.isSymbolicLink() || stat.size < 512) {
            const error = new Error(`Incomplete SQLite backup: ${name}`); error.code = 'BACKUP_INCOMPLETE'; throw error;
          }
          const copy = new Database(destination, { readonly: true, fileMustExist: true });
          try {
            const pages = copy.pragma('page_count', { simple: true }); const pageSize = copy.pragma('page_size', { simple: true });
            if (pages !== progress.totalPages || stat.size !== pages * pageSize || copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error(`Invalid SQLite backup: ${name}`);
            const counts = {};
            for (const table of coreTables[name]) {
              const value = copy.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
              if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Empty core table in ${name}: ${table}`);
              counts[table] = value;
            }
            results[name] = { bytes: stat.size, attempts, counts };
          } finally { copy.close(); }
          break;
        } catch (error) {
          if (!['SQLITE_BUSY', 'SQLITE_LOCKED', 'BACKUP_INCOMPLETE'].some((code) => error.code === code || error.code?.startsWith(`${code}_`))) throw error;
          if (Date.now() + backoff >= deadline) throw new Error(`SQLite backup retry deadline exceeded: ${name}`, { cause: error });
          console.error(`SQLite backup temporarily unavailable for ${name} (${error.code}); retrying`);
          await wait(backoff); backoff = Math.min(backoff * 2, 2000);
        } finally { if (db) db.close(); }
      }
      if (!(name in results)) throw new Error(`SQLite backup retry deadline exceeded: ${name}`);
    }
    console.log(JSON.stringify({ version: VERSION, snapshots: results }));
  } finally { clearTimeout(alarm); }
}

module.exports = { VERSION, main };
