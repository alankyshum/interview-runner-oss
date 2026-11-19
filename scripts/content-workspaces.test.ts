// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openContentDb } from '../server/content/contentDb';
import { ensureApiKeySchema, issueApiKey } from '../server/content/apiKeys';

it('lists, idempotently ensures, and guards deletion of courses and active keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspaces-test-')); const path = join(dir, 'content.db'); const statePath = join(dir, 'state.db');
  const content = await openContentDb(path); const state = new DatabaseSync(statePath); ensureApiKeySchema(state);
  state.exec('CREATE TABLE library_categories(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL); CREATE TABLE library_items(item_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)');
  const key = issueApiKey(state, { name: 'test', namespaces: ['other', 'pat'], scopes: ['content:write'] });
  const args = ['--import', 'tsx', 'scripts/content-workspaces.ts', '--db', path, '--state-db', statePath];
  const env = { PATH: process.env.PATH, XDG_STATE_HOME: dir, INTERVIEW_RUNNER_URL: 'https://runner.example' };
  const run = (...rest: string[]) => execFileSync(process.execPath, [...args, ...rest], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run('ensure', 'pat'); run('ensure', 'pat');
    expect(state.prepare("SELECT COUNT(*) AS n FROM library_categories WHERE workspace_id='pat'").get()).toMatchObject({ n: 0 });
    expect(JSON.parse(run('list'))).toContainEqual({ workspace: 'pat', courses: 0, url: 'https://runner.example/?workspace=pat' });
    run('ensure', 'category-only'); state.exec("INSERT INTO library_categories VALUES ('only','category-only')");
    const categoryOnly = spawnSync(process.execPath, [...args, 'delete', 'category-only'], { encoding: 'utf8', env }); expect(categoryOnly.status).not.toBe(0); expect(categoryOnly.stderr).toContain('1 categories');
    expect(state.prepare("SELECT id FROM library_categories WHERE workspace_id='category-only'").get()).toMatchObject({ id: 'only' });
    run('delete', 'category-only', '--force'); expect(state.prepare("SELECT id FROM library_categories WHERE workspace_id='category-only'").get()).toBeUndefined();
    content.prepare("INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES('sample','pat','course','Sample','now','now',1,'{}')").run();
    content.prepare("INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES('sheet','pat','cheatsheet','Sheet','now','now',1,'{}')").run();
    expect(JSON.parse(run('list'))).toContainEqual({ workspace: 'pat', courses: 1, url: 'https://runner.example/?workspace=pat' });
    state.exec("INSERT INTO library_categories VALUES ('e-category','pat'),('a-category','me'); INSERT INTO library_items VALUES ('e-item','pat'),('a-item','me')");
    const refused = spawnSync(process.execPath, [...args, 'delete', 'pat'], { encoding: 'utf8', env }); expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('2 courses, 1 active keys, 1 categories and 1 library items');
    expect(content.prepare("SELECT deleted_at FROM course WHERE id='sample'").get()).toMatchObject({ deleted_at: null });
    run('delete', 'pat', '--force');
    expect(state.prepare('SELECT * FROM library_categories').all()).toMatchObject([{ id: 'a-category', workspace_id: 'me' }]);
    expect(state.prepare('SELECT * FROM library_items').all()).toMatchObject([{ item_id: 'a-item', workspace_id: 'me' }]);
    expect(content.prepare("SELECT deleted_at FROM course WHERE id='sample'").get()).not.toMatchObject({ deleted_at: null });
    expect(state.prepare('SELECT namespaces_json,revoked_at FROM api_key WHERE id=?').get(key.split('_')[1]!)).toMatchObject({ namespaces_json: '["other"]', revoked_at: null });
    expect(JSON.parse(run('list')).map((row: { workspace: string }) => row.workspace)).not.toContain('pat');
  } finally { content.close(); state.close(); rmSync(dir, { recursive: true, force: true }); }
});
