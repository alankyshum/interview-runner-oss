// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

it('atomically installs only a matching, singly linked, same-owner replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fts-install-'));
  try {
    const live = join(root, 'content.db'); const replacement = join(root, 'candidate.db');
    await writeFile(live, 'original', { mode: 0o600 }); await writeFile(replacement, 'compacted', { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
    const run = (livePath = live, replacementPath = replacement, liveHash = hash('original'), replacementHash = hash('compacted')) => exec(process.execPath, [resolve('scripts/content-install-fts.mjs'), '--live', livePath, '--replacement', replacementPath, '--expect-live-sha256', liveHash, '--expect-replacement-sha256', replacementHash], { env });
    await expect(run(live, replacement, hash('wrong'))).rejects.toThrow('hash or identity changed');
    await expect(run(live, replacement, hash('original'), hash('wrong'))).rejects.toThrow('hash or identity changed');
    expect(await readFile(live, 'utf8')).toBe('original'); expect(await readFile(replacement, 'utf8')).toBe('compacted');
    const alias = join(root, 'alias.db'); await symlink(replacement, alias); await expect(run(live, alias)).rejects.toThrow('singly linked regular');
    const hardlink = join(root, 'hardlink.db'); await link(replacement, hardlink); await expect(run()).rejects.toThrow('singly linked regular'); await rm(hardlink);
    await chmod(replacement, 0o644); await expect(run()).rejects.toThrow('owner or mode differs'); await chmod(replacement, 0o600);
    expect((await run()).stdout).toContain('Verified replacement installed atomically');
    expect(await readFile(live, 'utf8')).toBe('compacted'); await expect(readFile(replacement)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
