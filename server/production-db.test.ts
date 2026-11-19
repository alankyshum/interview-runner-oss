import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { test } from 'node:test';

test('production serves database content behind its access gate', async () => {
  const { contentDatabase } = await import('./content/reader');
  const db = await contentDatabase();
  const manifest = { id: 'database-course', title: 'Database course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'read', title: 'Read', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/database-course/read.md', instructions: 'Read.' }] }] };
  db.prepare("INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)").run('database-course', 'test', 'course', 'Database course', 'now', 'now', 1, JSON.stringify(manifest));
  const salt = Buffer.from('0123456789abcdef0123456789abcdef'); const password = 'isolated-test-password';
  const { createProductionServer } = await import('./production');
  const app = createProductionServer({ public: true, basicAuth: { username: 'test', salt, hash: scryptSync(password, salt, 32) }, watchers: false });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const address = app.server.address(); assert(address && typeof address !== 'string');
  try {
    const url = `http://127.0.0.1:${address.port}/api/courses`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`test:${password}`).toString('base64')}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as Array<{ id: string }>)[0]?.id, 'database-course');
  } finally { await app.close(); db.close(); }
});
