import { getCourseBundle } from '../server/content/writer';
import { openContentDb } from '../server/content/contentDb';
import { writeBundleToDirectory } from '../server/content/bundle';

async function main(): Promise<void> {
  const args = process.argv.slice(2); const positional: string[] = []; let dbPath: string | undefined; let revision: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--db' || arg === '--revision') { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`); if (arg === '--db') dbPath = value; else { revision = Number(value); if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid revision'); } }
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`); else positional.push(arg);
  }
  if (positional.length !== 2) throw new Error('Usage: content:export <course-id> <dir> [--revision n] [--db path]');
  const db = await openContentDb(dbPath);
  try {
    const bundle = getCourseBundle(db, positional[0]!, revision); if (!bundle) throw new Error('Course revision not found');
    const blobs = new Map<string, Uint8Array>();
    for (const file of Object.values(bundle.files)) { const row = db.prepare('SELECT bytes FROM blob WHERE sha256=?').get(file.sha256) as { bytes: Uint8Array } | undefined; if (!row) throw new Error(`Missing blob ${file.sha256}`); blobs.set(file.sha256, row.bytes); }
    await writeBundleToDirectory(bundle, blobs, positional[1]!); console.log(`Exported ${positional[0]}.`);
  } finally { db.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
