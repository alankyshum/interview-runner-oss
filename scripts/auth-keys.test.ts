// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('issues once, lists without secrets, and revokes in an explicit disposable database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-keys-test-')); const db = join(dir, 'state.db');
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/auth-keys.ts', '--db', db, ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const key = run('issue', '--name', 'author', '--namespace', 'sam', '--scope', 'content:write').trim(); expect(key).toMatch(/^irk_/);
    const list = run('list'); expect(list).not.toContain(key); expect(list).not.toContain('key_hash'); expect(JSON.parse(list)[0].namespaces).toEqual(['sam']);
    run('revoke', key.split('_')[1]!); expect(JSON.parse(run('list'))[0].revoked_at).toBeTruthy();
    const invalid = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/auth-keys.ts', '--db', db, 'issue', '--name', 'bad', '--namespace', 'n', '--scope', 'admin'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: dir } }); expect(invalid.status).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
