import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pathInRepo, requireRepoForCourse } from './courseRepos';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('Vite did not expose a test port');
const origin = `http://127.0.0.1:${address.port}`;
const json = async (path: string, init?: RequestInit) => { const response = await fetch(`${origin}${path}`, init); return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }; };
try {
  const library = await json('/api/library'); const courses = await json('/api/courses');
  const save = await json('/api/drills/fixture-second/save/source', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'export const owner = "second";\n' }) });
  const second = requireRepoForCourse('fixture-second'); const saved = await readFile(pathInRepo(second, 'drills/fixture-second/save/save.ts'), 'utf8');
  let escape = ''; try { pathInRepo(second, '../escaped.ts'); } catch (error) { escape = error instanceof Error ? error.message : String(error); }
  const image = await (await fetch(`${origin}/images/collision.txt`)).text();
  const firstOutline = await json('/api/outlines/fixture-first/read'); const secondOutline = await json('/api/outlines/fixture-second/read'); const books = await json('/api/books');
  const sheets = (await json('/api/cheatsheets')).body;
  const sheetManifest = await json('/api/cheatsheets/sheet-second');
  const sheetHtml = await (await fetch(`${origin}/cheatsheets/sheet-second/sections/one.html`)).text();
  const sheetAsset = await (await fetch(`${origin}/cheatsheets/sheet-second/assets/sample.png`)).text();
  const sectionPath = join(second.root, 'cheatsheets/sheet-second/sections/one.html');
  const manifestPath = join(second.root, 'courses/sheet-second.json');
  const coursePath = join(second.root, 'courses/fixture-second.json');
  const originalSection = await readFile(sectionPath); const originalManifest = await readFile(manifestPath); const originalCourse = await readFile(coursePath);
  let live: Record<string, unknown>;
  try {
    const before = await json('/api/cheatsheets/sheet-second/content');
    await writeFile(sectionPath, '<h2>sheet-second</h2><p>LIVE EDIT</p>');
    const after = await json('/api/cheatsheets/sheet-second/content');
    await writeFile(sectionPath, originalSection);
    const reverted = await json('/api/cheatsheets/sheet-second/content');
    const editedCourse = JSON.parse(originalCourse.toString()); editedCourse.title = 'Live course title'; await writeFile(coursePath, JSON.stringify(editedCourse));
    const changedCourse = await json('/api/courses/fixture-second'); await writeFile(coursePath, originalCourse);
    const revertedCourse = await json('/api/courses/fixture-second');
    await writeFile(manifestPath, '{invalid');
    const invalidSheet = await json('/api/cheatsheets/sheet-second');
    const coursesWhileInvalid = await json('/api/courses'); const libraryWhileInvalid = await json('/api/library'); const otherSheet = await json('/api/cheatsheets/sheet-first');
    await writeFile(manifestPath, JSON.stringify({ type: 'cheatsheet', id: 'sheet-second', title: 'Broken', chapters: [] }));
    const invalidSchema = await json('/api/cheatsheets/sheet-second'); const libraryWithInvalidSchema = await json('/api/library');
    const wrongIdentity = JSON.parse(originalManifest.toString()); wrongIdentity.id = 'fixture-first'; await writeFile(manifestPath, JSON.stringify(wrongIdentity));
    const invalidIdentity = await json('/api/cheatsheets/sheet-second'); const libraryWithInvalidIdentity = await json('/api/library');
    await writeFile(manifestPath, originalManifest); await rm(sectionPath);
    const missingSection = await json('/api/cheatsheets/sheet-second/content'); const otherWithMissingSection = await json('/api/cheatsheets/sheet-first/content');
    live = { before, after, reverted, changedCourse, revertedCourse, invalidSheet, coursesWhileInvalid, libraryWhileInvalid, otherSheet, invalidSchema, libraryWithInvalidSchema, invalidIdentity, libraryWithInvalidIdentity, missingSection, otherWithMissingSection };
  } finally { await writeFile(sectionPath, originalSection); await writeFile(manifestPath, originalManifest); await writeFile(coursePath, originalCourse); }
  console.log(`MULTI_REPO_RESULT=${JSON.stringify({ library, courses, save, saved, escape, image, firstOutline, secondOutline, books, sheets, sheetManifest, sheetHtml, sheetAsset, live })}`);
} finally { await server.close(); }
