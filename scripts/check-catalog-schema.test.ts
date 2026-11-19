// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

it('scans every active catalog entry read-only and fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-schema-')); const path = join(dir, 'content.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE course(id TEXT, type TEXT, manifest_json TEXT, deleted_at TEXT)');
    const drill = (id: string, extra: object = {}) => ({ id, title: id, contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: `reading/demo/${id}.md`, instructions: 'Read.', ...extra });
    const manifest = { id: 'demo', title: 'Demo', chapters: [{ id: 'one', title: 'One', drills: [drill('one', { evaluation: null }), drill('two'), drill('valid', { outlinePath: 'outlines/demo/valid.json' })] }] };
    const insert = db.prepare('INSERT INTO course VALUES(?,?,?,?)');
    insert.run('demo', 'course', JSON.stringify(manifest), null);
    insert.run('broken', 'course', '{', null);
    insert.run('deleted', 'course', '{', 'yesterday');
    db.close();
    const run = (args: string[], input?: string) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-catalog-schema.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', input });
    const result = run(['--db', path]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('2 entries, 2 invalid entries, 2 removed-shape drills');
    expect(result.stderr).toContain('one.evaluation is no longer supported');
    expect(result.stderr).toContain('one.outlinePath is required');
    expect(result.stderr).toContain('two.outlinePath is required');
    expect(result.stderr).toContain('broken: malformed manifest JSON');
    expect(result.stderr).not.toContain('deleted:');
    const stdin = run(['--stdin'], JSON.stringify([{ id: 'demo', type: 'course', manifest_json: JSON.stringify({ ...manifest, chapters: [] }) }]));
    expect(stdin.status).toBe(0);
    expect(stdin.stdout).toContain('1 entries, 0 invalid entries');
    const newReading = { ...manifest, chapters: [{ id: 'one', title: 'One', drills: [drill('valid', { outlinePath: 'outlines/demo/valid.json' })] }] };
    const rejected = run(['--stdin'], JSON.stringify([{ id: 'demo', type: 'course', manifest_json: JSON.stringify(newReading) }]));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/contentType: "map".*mindmaps\/<course-id>\/<drill-id>\.md/);
    expect(run(['--stdin'], '[]').status).toBe(1);
    expect(run(['--db', join(dir, 'missing.db')]).status).toBe(1);
    expect(execFileSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(path)},{readOnly:true});console.log(d.prepare('SELECT count(*) n FROM course').get().n);d.close()`], { encoding: 'utf8' }).trim()).toBe('3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
