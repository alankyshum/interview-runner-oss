import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { courseRepos } from '../server/courseRepos';
import { bundleFromDirectory } from '../server/content/bundle';
import { openContentDb } from '../server/content/contentDb';
import { getCourseBundle, putCourseBundle } from '../server/content/writer';

async function main(): Promise<void> {
  const args = process.argv.slice(2); const roots: string[] = []; let namespace: string | undefined; let dbPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--namespace' || arg === '--db') { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`); if (arg === '--namespace') namespace = value; else dbPath = value; }
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`); else roots.push(resolve(arg));
  }
  const repos = roots.length ? await Promise.all(roots.map(async (root) => ({ root, linked: courseRepos.find((repo) => repo.root === root || repo.root === root.replace(/\/$/, '')) ?? courseRepos.find((repo) => repo.root === resolve(root)) }))) : courseRepos.map((repo) => ({ root: repo.root, linked: repo }));
  const db = await openContentDb(dbPath); let imported = 0; let skipped = 0;
  try {
    for (const repo of repos) {
      const actual = await realpath(repo.root);
      const owner = namespace ?? repo.linked?.id.split('/')[0] ?? courseRepos.find((item) => item.root === actual)?.id.split('/')[0];
      if (!owner) throw new Error(`Unlinked repository ${repo.root}: --namespace is required`);
      for (const name of (await readdir(join(repo.root, 'courses'))).filter((file) => file.endsWith('.json') && !file.endsWith('.hints.json')).sort()) {
        const id = name.slice(0, -5); const { bundle, blobs } = await bundleFromDirectory(repo.root, id);
        if ((bundle.manifest as { id?: unknown })?.id !== id) throw new Error(`${name}: manifest id must match filename`);
        const previous = getCourseBundle(db, id);
        // Only the owner-executable bit is content; other mode bits vary with the checkout's umask and must not create revisions.
        const files = (value: typeof bundle) => Object.entries(value.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [path, file.sha256, file.size, Boolean((file.mode ?? 0) & 0o100)]);
        const ownerRow = db.prepare('SELECT namespace_id FROM course WHERE id=?').get(id) as { namespace_id: string } | undefined;
        if (ownerRow && ownerRow.namespace_id !== owner) throw new Error(`Course ${id} belongs to a different namespace`);
        if (previous && JSON.stringify(previous.manifest) === JSON.stringify(bundle.manifest) && JSON.stringify(previous.hints) === JSON.stringify(bundle.hints) && JSON.stringify(files(previous)) === JSON.stringify(files(bundle))) { skipped += 1; continue; }
        await putCourseBundle(db, bundle, blobs, { namespace: owner }); imported += 1;
      }
    }
    console.log(`Imported ${imported} course(s); skipped ${skipped} unchanged.`);
  } finally { db.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); if ('errors' in (error as object)) console.error((error as { errors: unknown }).errors); process.exitCode = 1; });
