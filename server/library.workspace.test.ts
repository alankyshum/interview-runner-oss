// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureLibrarySchema } from './db';

it('preserves legacy rows and routes an unassigned non-default item to its owner', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE library_categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, fixed INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE library_items(kind TEXT NOT NULL, item_id TEXT NOT NULL, category_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, status_explicit INTEGER NOT NULL, title_override TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(kind,item_id));
      INSERT INTO library_categories VALUES ('uncategorized','Uncategorized',0,1,'t'),('old','Old',1,0,'t');
      INSERT INTO library_items VALUES ('course','one','old',3,'done',1,'Custom','t'),('cheatsheet','orphan','uncategorized',7,'archived',1,NULL,'u');`);
    const categories = db.prepare('SELECT * FROM library_categories ORDER BY id').all(); const items = db.prepare('SELECT * FROM library_items ORDER BY item_id').all();
    expect(ensureLibrarySchema(db, new Map([['cheatsheet:orphan', 'pat']]))).toBe(true);
    expect(db.prepare('SELECT id,name,position,fixed,updated_at FROM library_categories ORDER BY id').all()).toEqual(categories);
    expect(db.prepare('SELECT kind,item_id,category_id,position,status,status_explicit,title_override,updated_at FROM library_items ORDER BY item_id').all()).toEqual(items);
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_categories WHERE workspace_id='me'").get()).toMatchObject({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE workspace_id='me'").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE workspace_id='pat'").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_categories WHERE workspace_id='pat'").get()).toMatchObject({ n: 0 });
    expect(ensureLibrarySchema(db)).toBe(false);
    expect(db.prepare('SELECT id,name,position,fixed,updated_at FROM library_categories ORDER BY id').all()).toEqual(categories);
    expect(db.prepare('SELECT kind,item_id,category_id,position,status,status_explicit,title_override,updated_at FROM library_items ORDER BY item_id').all()).toEqual(items);
  } finally { db.close(); }
});

it('rolls back rather than guessing ownership of a shared-category assignment', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE library_categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, fixed INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE library_items(kind TEXT NOT NULL, item_id TEXT NOT NULL, category_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, status_explicit INTEGER NOT NULL, title_override TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(kind,item_id));
      INSERT INTO library_categories VALUES ('shared','Shared',0,0,'t'); INSERT INTO library_items VALUES ('course','foreign','shared',0,'done',1,NULL,'t');`);
    expect(() => ensureLibrarySchema(db, new Map([['course:foreign', 'pat']]))).toThrow('migration requires review');
    expect(db.prepare('PRAGMA table_info(library_items)').all().map((column: any) => column.name)).not.toContain('workspace_id');
    expect(db.prepare('SELECT category_id,status FROM library_items WHERE item_id=?').get('foreign')).toMatchObject({ category_id: 'shared', status: 'done' });
  } finally { db.close(); }
});

it('refuses an incomplete legacy schema without changing either table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE library_categories(id TEXT PRIMARY KEY, workspace_id TEXT); CREATE TABLE library_items(item_id TEXT PRIMARY KEY); INSERT INTO library_categories VALUES ('keep','me'); INSERT INTO library_items VALUES ('keep')");
    expect(() => ensureLibrarySchema(db)).toThrow('Incomplete workspace migration');
    expect(db.prepare('SELECT * FROM library_categories').all()).toMatchObject([{ id: 'keep', workspace_id: 'me' }]);
    expect(db.prepare('SELECT * FROM library_items').all()).toMatchObject([{ item_id: 'keep' }]);
  } finally { db.close(); }
});

it('isolates category operations, item placement and status by workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-workspaces-')); const previous = { ...process.env };
  process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'db'; process.env.XDG_STATE_HOME = root; process.env.VITEST = '1';
  await mkdir(join(root, 'interview-runner')); await writeFile(join(root, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
  vi.resetModules(); let plugin: any;
  try {
    const [{ default: apiPlugin }, { contentDatabase }] = await Promise.all([import('./apiPlugin'), import('./content/reader')]);
    const content = await contentDatabase();
    for (const [id, namespace] of [['alice-course', 'me'], ['pat-course', 'pat']]) {
      const manifest = { id, title: id, chapters: [{ id: 'one', title: 'One', drills: [{ id: 'read', title: 'Read', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: `mindmaps/${id}/read.md`, instructions: 'Read.' }] }] };
      content.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run(id, namespace, 'course', id, 'now', 'now', 1, JSON.stringify(manifest));
    }
    content.prepare('INSERT INTO content_meta(key,value) VALUES (?,?)').run('workspace:pat', 'pat');
    let handler: any; plugin = apiPlugin({ enableDeterministicWatchers: false }); plugin.configureServer({ middlewares: { use: (fn: any) => { handler = fn; } } } as any);
    const request = async (path: string, method = 'GET', body?: unknown) => { let text = ''; const response = { statusCode: 0, setHeader() {}, end(value = '') { text = value; } }; await handler({ url: path, method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } }, response, () => {}); return { status: response.statusCode, data: text ? JSON.parse(text) : undefined }; };
    const a = '?workspace=me', e = '?workspace=pat';
    expect((await request(`/api/library${e}`)).data).toMatchObject({ categories: [], items: [{ id: 'pat-course', categoryId: 'uncategorized' }] });
    const state = (await import('./db')).stateDb();
    state.prepare("UPDATE library_items SET position=13,updated_at='original' WHERE item_id='pat-course'").run();
    const empty = (await request(`/api/library/categories${e}`, 'POST', { name: 'Temporary' })).data.categories[0];
    expect((await request(`/api/library/categories/${empty.id}${e}`, 'DELETE')).status).toBe(200);
    expect(state.prepare("SELECT position,updated_at FROM library_items WHERE item_id='pat-course'").get()).toMatchObject({ position: 13, updated_at: 'original' });
    const ac = (await request(`/api/library/categories${a}`, 'POST', { name: 'Mine' })).data.categories[0];
    const ec = (await request(`/api/library/categories${e}`, 'POST', { name: 'Pat' })).data.categories[0];
    const ec2 = (await request(`/api/library/categories${e}`, 'POST', { name: 'Second' })).data.categories.find((category: any) => category.name === 'Second');
    expect((await request(`/api/library/categories/${ec.id}${a}`, 'PUT', { name: 'Wrong' })).status).toBe(404);
    expect((await request(`/api/library/categories/${ec.id}${e}`, 'PUT', { name: 'Renamed' })).status).toBe(200);
    expect((await request(`/api/library/categories/${ec2.id}/move${e}`, 'PUT', { position: 0 })).data.categories.map((x: any) => x.name)).toEqual(['Second', 'Renamed']);
    expect((await request(`/api/library/items/course/pat-course/move${e}`, 'PUT', { categoryId: ec.id, position: 0 })).status).toBe(200);
    expect((await request(`/api/library/items/course/pat-course/status${e}`, 'PUT', { status: 'done' })).status).toBe(200);
    expect((await request(`/api/library/items/course/alice-course/status${e}`, 'PUT', { status: 'archived' })).status).toBe(404);
    expect((await request(`/api/library/items/course/alice-course/move${e}`, 'PUT', { categoryId: ec.id, position: 0 })).status).toBe(404);
    expect((await request(`/api/library/items/course/pat-course/move${e}`, 'PUT', { categoryId: ac.id, position: 0 })).status).toBe(404);
    expect((await request(`/api/library${a}`)).data).toMatchObject({ categories: [{ id: ac.id, name: 'Mine' }], items: [{ id: 'alice-course', categoryId: 'uncategorized', status: 'active' }] });
    expect((await request(`/api/library/categories/${ec.id}${e}`, 'DELETE')).data.items).toMatchObject([{ id: 'pat-course', categoryId: 'uncategorized', status: 'done' }]);
    expect((await request(`/api/library${a}`)).data.categories).toMatchObject([{ id: ac.id, name: 'Mine' }]);
  } finally { plugin?.closeBundle?.(); for (const key of ['INTERVIEW_RUNNER_CONTENT_SOURCE', 'XDG_STATE_HOME', 'VITEST']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } vi.resetModules(); await rm(root, { recursive: true, force: true }); }
});
