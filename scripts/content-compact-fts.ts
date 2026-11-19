import { closeSync, lstatSync, openSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { compactAssetIndex } from '../server/content/compactAssetIndex';

const args = process.argv.slice(2);
if ((args.length !== 2 && args.length !== 5) || args[0] !== '--db' || !args[1] || (args.length === 5 && (args[2] !== '--output' || !args[3] || args[4] !== '--apply'))) throw new Error('Usage: content-compact-fts --db <working snapshot> [--output <new database> --apply]');
const path = resolve(args[1]); const apply = args.length === 5; const output = apply ? resolve(args[3]!) : undefined; const info = lstatSync(path);
if (!info.isFile() || info.isSymbolicLink()) throw new Error('The content database must be an existing regular file, not a symlink');
if (output === path) throw new Error('Output must differ from the working snapshot');
const db = new Database(path, { fileMustExist: true, readonly: !apply });
try {
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null };
  if (version.version !== 1) throw new Error('Unsupported content database schema version');
  const check = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (check.length !== 1 || check[0]!.integrity_check !== 'ok') throw new Error('Content database integrity check failed');
  const before = statSync(path).size;
  if (output) closeSync(openSync(output, 'wx', 0o600));
  const result = compactAssetIndex(db, apply, output);
  const after = statSync(output ?? path).size;
  const target = output ? new Database(output, { fileMustExist: true, readonly: true }) : db;
  try { const finalCheck = target.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>; if (finalCheck.length !== 1 || finalCheck[0]!.integrity_check !== 'ok') throw new Error('Content database integrity check failed after compaction'); }
  finally { if (output) target.close(); }
  console.log(JSON.stringify({ applied: apply, ...result, before, after, integrity: 'ok' }));
} finally { db.close(); }
