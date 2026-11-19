import { DatabaseSync } from 'node:sqlite';
import { parseCheatsheet, parseCourse, removedDrillErrors } from '../shared/courseSchema';

type Row = { id: string; type: string; manifest_json: string };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let rows: Row[];
  if (args.length === 2 && args[0] === '--db' && args[1]) {
    const db = new DatabaseSync(args[1], { readOnly: true });
    try { rows = db.prepare('SELECT id, type, manifest_json FROM course WHERE deleted_at IS NULL ORDER BY id').all() as Row[]; }
    finally { db.close(); }
  } else if (args.length === 1 && args[0] === '--stdin') {
    let input = ''; for await (const chunk of process.stdin) input += String(chunk);
    rows = JSON.parse(input) as Row[];
  } else throw new Error('Usage: npm run check:catalog-schema -- --db <content.db> | --stdin');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Catalog is empty or invalid; preflight cannot establish readiness');
  let failed = 0; let legacyDrills = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || typeof row.type !== 'string' || typeof row.manifest_json !== 'string') throw new Error('Invalid catalog row');
    let raw: unknown;
    try { raw = JSON.parse(row.manifest_json); }
    catch { console.error(`${row.id}: malformed manifest JSON`); failed++; continue; }
    const errors: string[] = [];
    if (row.type !== 'cheatsheet' && raw && typeof raw === 'object' && 'chapters' in raw && Array.isArray(raw.chapters)) {
      for (const chapter of raw.chapters) if (chapter && typeof chapter === 'object' && Array.isArray(chapter.drills)) {
        for (const drill of chapter.drills) if (drill && typeof drill === 'object' && !Array.isArray(drill)) {
          const issues = removedDrillErrors(drill, typeof drill.id === 'string' ? drill.id : '(unknown drill)');
          if (issues.length) { legacyDrills++; errors.push(...issues); }
        }
      }
    }
    try { if (row.type === 'cheatsheet') parseCheatsheet(`${row.id}.json`, raw); else parseCourse(`${row.id}.json`, raw); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!errors.some((issue) => message.endsWith(issue))) errors.push(message);
    }
    if (errors.length) { failed++; for (const error of errors) console.error(`${row.id}: ${error}`); }
  }
  console.log(`Catalog schema preflight: ${rows.length} entries, ${failed} invalid entries, ${legacyDrills} removed-shape drills`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
