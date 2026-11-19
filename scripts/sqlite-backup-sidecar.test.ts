// @vitest-environment node
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('backs up both real SQLite files, rejects empty core tables and never overwrites a destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-sidecar-')); const data = join(root, 'data'); const output = join(root, 'output');
  await mkdir(data, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  const create = (name: string, tables: string[], populated: boolean) => { const db = new DatabaseSync(join(data, name)); try { for (const table of tables) { db.exec(`CREATE TABLE "${table}"(value TEXT)`); if (populated) db.exec(`INSERT INTO "${table}" VALUES('fixture')`); } } finally { db.close(); } };
  try {
    create('content.db', ['course', 'lesson', 'blob', 'lesson_file', 'course_revision'], true); create('progress.db', ['progress', 'api_key'], true);
    const raw = await readFile(resolve('scripts/sqlite-backup-sidecar.cjs'), 'utf8');
    const run = (allowMissingContent = false) => {
      const source = raw.replaceAll('/data/', `${data}/`).replaceAll('/backup/', `${output}/`).replace("lstatSync('/backup')", `lstatSync(${JSON.stringify(output)})`);
      const launcher = `\nif(VERSION!=='interview-runner-sqlite-backup-v1')throw Error('wrong version');main({order:['content.db','progress.db'],allowMissingContent:${allowMissingContent}}).catch(e=>{console.error(e.message);process.exitCode=1})`;
      return exec(process.execPath, ['-e', source + launcher], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } });
    };
    const first = JSON.parse((await run()).stdout) as { snapshots: Record<string, { bytes: number }> };
    for (const name of ['content.db', 'progress.db']) { expect(first.snapshots[name].bytes).toBeGreaterThan(0); const db = new DatabaseSync(join(output, name), { readOnly: true }); try { expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' }); } finally { db.close(); } }
    await expect(run()).rejects.toThrow('EEXIST');
    await rm(join(output, 'content.db')); await rm(join(output, 'progress.db')); await rm(join(data, 'content.db'));
    const optional = JSON.parse((await run(true)).stdout) as { snapshots: Record<string, unknown> }; expect(optional.snapshots['content.db']).toBeNull();
    await rm(join(output, 'progress.db')); create('content.db', ['course', 'lesson', 'blob', 'lesson_file', 'course_revision'], false);
    await expect(run()).rejects.toThrow('Empty core table');
    await rm(join(output, 'content.db')); await chmod(output, 0o755); await expect(run()).rejects.toThrow('output directory owner or mode');
    await chmod(output, 0o700); await writeFile(join(output, 'content.db'), 'protected', { mode: 0o600 }); await expect(run()).rejects.toThrow('EEXIST'); expect(await readFile(join(output, 'content.db'), 'utf8')).toBe('protected');
  } finally { await rm(root, { recursive: true, force: true }); }
});
