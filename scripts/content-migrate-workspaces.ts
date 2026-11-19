import { cp, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { repoForCourse, packageRoot } from '../server/courseRepos';
import { openContentDb } from '../server/content/contentDb';
import { assertNoSymlink, codingWorkspace, managedStateRoot, prepareCodingWorkspace, seedLinkedCodingWorkspace, withWorkspaceLock } from '../server/content/materialize';
import { getCourseBundle } from '../server/content/writer';
import { parseCourse } from '../shared/courseSchema';

const exists = async (path: string) => {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
};

async function main(): Promise<void> {
  const args = process.argv.slice(2); let stateRoot = managedStateRoot(); let dbPath = process.env.CONTENT_DB_PATH ?? join(packageRoot, 'content.db');
  let gitRoot = join(packageRoot, 'sandbox/.workspace-git'); let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log('Usage: content:migrate-workspaces [--db PATH] [--state-dir STATE] [--git-dir PATH] [--dry-run]\n--state-dir is the interview-runner state root; managed files are stored under STATE/managed. Workspace preparation is locked across processes, but editor saves are not: freeze coding saves and run before switching to db mode or with the runner stopped.'); return; }
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--state-dir' || arg === '--db' || arg === '--git-dir') {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--state-dir') stateRoot = join(resolve(value), 'managed'); else if (arg === '--db') dbPath = resolve(value); else gitRoot = resolve(value);
    } else throw new Error(`Unknown option ${arg}`);
  }
  const dbInfo = await exists(dbPath); if (!dbInfo?.isFile()) throw new Error(`Content database does not exist: ${dbPath}`);
  const db = await openContentDb(dbPath); const counts = { seeded: 0, 'skipped-existing': 0, 'skipped-raced': 0, 'no-source': 0 };
  try {
    const courses = db.prepare('SELECT id, revision FROM course WHERE deleted_at IS NULL ORDER BY id').all() as Array<{ id: string; revision: number }>;
    for (const { id, revision } of courses) {
      const bundle = getCourseBundle(db, id); if (!bundle) throw new Error(`Missing current bundle: ${id}`);
      if ((bundle.manifest as { type?: string }).type === 'cheatsheet') continue;
      const course = parseCourse('bundle', bundle.manifest); const repo = repoForCourse(id);
      for (const drill of course.chapters.flatMap((chapter) => chapter.drills)) {
        if (drill.contentType !== 'coding') continue;
        const source = repo && join(repo.root, 'drills', id, drill.id); const workspace = codingWorkspace(id, drill.id, stateRoot);
        if (source && repo) await assertNoSymlink(repo.root, source);
        const sourceInfo = source ? await exists(source) : undefined;
        if (!sourceInfo?.isDirectory()) { counts['no-source']++; console.log(`no-source ${id}/${drill.id}`); continue; }
        const current = await exists(workspace); const result = dryRun ? (current ? 'skipped-existing' : 'seeded') : await seedLinkedCodingWorkspace(id, drill.id, source!, stateRoot);
        const status = !current && result === 'skipped-existing' ? 'skipped-raced' : result; counts[status]++;
        console.log(`${dryRun ? 'would ' : ''}${status} ${id}/${drill.id}; synchronize protected files`);
        if (status === 'no-source') continue;
        const copyHistory = async () => {
          const fromGit = join(dirname(stateRoot), 'workspace-git', id, `${drill.id}.git`); const toGit = join(gitRoot, id, `${drill.id}.git`);
          const history = await exists(fromGit); const target = await exists(toGit);
          if (history && resolve(fromGit) !== resolve(toGit) && !target) {
            if (!history.isDirectory() || history.isSymbolicLink() || !(await exists(join(fromGit, 'HEAD')))?.isFile() || !(await exists(join(fromGit, 'objects')))?.isDirectory()) throw new Error(`Invalid workspace Git history: ${fromGit}`);
            await assertNoSymlink(dirname(stateRoot), fromGit); console.log(`${dryRun ? 'would copy' : 'copy'} history ${id}/${drill.id}`);
            if (!dryRun) {
              await mkdir(gitRoot, { recursive: true }); await assertNoSymlink(gitRoot, toGit); await mkdir(dirname(toGit), { recursive: true }); await assertNoSymlink(gitRoot, dirname(toGit));
              let created = false;
              try {
                await mkdir(toGit); created = true;
                await cp(fromGit, toGit, { recursive: true, filter: async (path) => { if ((await lstat(path)).isSymbolicLink()) throw new Error('Workspace Git history contains a symbolic link'); return true; } });
              } catch (error) { if (created) await rm(toGit, { recursive: true, force: true }); throw error; }
            }
          }
        };
        if (dryRun) await copyHistory(); else await withWorkspaceLock(id, drill.id, stateRoot, copyHistory);
        if (!dryRun) await prepareCodingWorkspace({ db, courseId: id, drillId: drill.id, revision, testPaths: [drill.testPath], linkedDrillPath: source, stateRoot });
      }
    }
    console.log(`Summary: seeded=${counts.seeded} skipped-existing=${counts['skipped-existing']} skipped-raced=${counts['skipped-raced']} no-source=${counts['no-source']}`);
  } finally { db.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
