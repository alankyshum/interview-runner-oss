import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--db' || !args[1]) throw new Error('Usage: content-fingerprint-fts --db <existing database>');
const path = resolve(args[1]); const stat = lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The content database must be an existing regular file, not a symlink');
const db = new DatabaseSync(path, { readOnly: true });
try {
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok') throw new Error('Content database integrity check failed');
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
  const tables = objects.filter((row) => row.type === 'table').map((row) => row.name);
  const hash = createHash('sha256'); let rows = 0;
  const add = (value) => {
    let bytes; let type;
    if (value === null) { type = 'n'; bytes = Buffer.alloc(0); }
    else if (value instanceof Uint8Array) { type = 'b'; bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength); }
    else { type = typeof value; bytes = Buffer.from(String(value)); }
    hash.update(`${type}:${bytes.length}:`); hash.update(bytes); hash.update('\n');
  };
  for (const object of objects) for (const value of Object.values(object)) add(value);
  for (const table of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`; const definition = objects.find((row) => row.type === 'table' && row.name === table).sql;
    const primary = db.prepare(`PRAGMA table_info(${quoted})`).all().filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => `"${column.name.replaceAll('"', '""')}"`);
    const order = /\bWITHOUT\s+ROWID\b/i.test(definition) ? primary.join(',') : 'rowid';
    if (!order) throw new Error(`Cannot order table ${table}`);
    add(table);
    const statement = db.prepare(`SELECT * FROM ${quoted} ORDER BY ${order}`); statement.setReadBigInts(true);
    for (const row of statement.iterate()) { rows++; for (const value of Object.values(row)) add(value); }
  }
  const revision = db.prepare("SELECT value FROM content_meta WHERE key='revision'").get();
  if (!revision || typeof revision.value !== 'string') throw new Error('Content revision is missing');
  console.log(JSON.stringify({ sha256: hash.digest('hex'), contentRevision: revision.value, tables: tables.length, rows, integrity: 'ok' }));
} finally { db.close(); }
