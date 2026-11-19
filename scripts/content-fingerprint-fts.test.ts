// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { openContentDb } from '../server/content/contentDb';

const exec = promisify(execFile);

it('fingerprints all content including unrevisioned blobs and FTS rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fts-fingerprint-'));
  try {
    const path = join(root, 'content.db'); const db = await openContentDb(path);
    try { db.prepare('INSERT INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run('a'.repeat(64), Buffer.from('one'), 3, 'now'); } finally { db.close(); }
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
    const run = async (target = path) => JSON.parse((await exec(process.execPath, [resolve('scripts/content-fingerprint-fts.mjs'), '--db', target], { env })).stdout) as { sha256: string; contentRevision: string; integrity: string };
    const initial = await run(); expect(initial).toMatchObject({ contentRevision: '0', integrity: 'ok' }); expect(await run()).toEqual(initial);
    const changed = await openContentDb(path);
    try { changed.prepare('UPDATE blob SET bytes=? WHERE sha256=?').run(Buffer.from('two'), 'a'.repeat(64)); } finally { changed.close(); }
    const modifiedBlob = await run(); expect(modifiedBlob.contentRevision).toBe('0'); expect(modifiedBlob.sha256).not.toBe(initial.sha256);
    const index = await openContentDb(path);
    try { index.prepare('INSERT INTO asset_fts(course_id,path,text) VALUES(?,?,?)').run('c', 'p', 'text'); } finally { index.close(); }
    expect((await run()).sha256).not.toBe(modifiedBlob.sha256);
    const alias = join(root, 'alias.db'); await symlink(path, alias); await expect(run(alias)).rejects.toThrow('not a symlink');
  } finally { await rm(root, { recursive: true, force: true }); }
});
