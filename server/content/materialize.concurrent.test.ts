// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { sha256 } from './bundle';

const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href;
const materializer = `
import { openContentDb } from ${JSON.stringify(moduleUrl('server/content/contentDb.ts'))};
import { materializeCourse } from ${JSON.stringify(moduleUrl('server/content/materialize.ts'))};
import { sha256 } from ${JSON.stringify(moduleUrl('server/content/bundle.ts'))};
const [root, value] = process.argv.slice(1);
const db = await openContentDb(':memory:');
db.prepare("INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES('course','ns','course','Course','now','now',1,'{}')").run();
const bytes = Buffer.from(value); const hash = sha256(bytes);
db.prepare('INSERT INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now');
const files = Object.fromEntries(['drills/course/drill/a.txt','drills/course/drill/b.txt'].map(path => [path, {sha256:hash,size:bytes.length,mode:420}]));
db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run('course',1,JSON.stringify({manifest:{},files}),'now');
process.send('ready'); process.once('message', async () => { try { await materializeCourse(db,'course',1,root); process.send('done'); db.close(); process.disconnect(); } catch (error) { console.error(error); process.exitCode=1; db.close(); process.disconnect(); } });`;
const seeder = `
import { seedLinkedCodingWorkspace } from ${JSON.stringify(moduleUrl('server/content/materialize.ts'))};
const [root, source] = process.argv.slice(1);
process.send('ready'); process.once('message', async () => { try { const result=await seedLinkedCodingWorkspace('course','drill',source,root); process.send(result); process.disconnect(); } catch (error) { console.error(error); process.exitCode=1; process.disconnect(); } });`;

async function children(root: string, script: string, values: string[], started?: () => void): Promise<string[]> {
  const state = join(root, 'xdg'); await mkdir(join(state, 'interview-runner'), { recursive: true });
  await writeFile(join(state, 'interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: {} }));
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_STATE_HOME: state, INTERVIEW_RUNNER_CONTENT_SOURCE: 'db', VITEST: '1' };
  const processes: ChildProcess[] = []; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const runs = values.map((value) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, value], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      processes.push(child); let errors = ''; let result = '';
      child.stderr!.on('data', (chunk) => { errors += chunk.toString(); });
      const ready = new Promise<void>((done, reject) => { child.once('error', reject); child.on('message', (message) => { if (message === 'ready') done(); else result = String(message); }); });
      const done = new Promise<string>((done, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 && result ? done(result) : reject(new Error(`child exited ${code}: ${errors}`))); });
      return { child, ready, done };
    });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Child lock test timed out')), 45_000); });
    return await Promise.race([(async () => { await Promise.all(runs.map((run) => run.ready)); for (const run of runs) run.child.send!('go'); started?.(); return Promise.all(runs.map((run) => run.done)); })(), timeout]);
  } finally { if (timer) clearTimeout(timer); for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL'); }
}

it('serializes competing processes publishing different bundles without a mixed final revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'materialize-process-'));
  try {
    for (let i = 0; i < 3; i++) {
      expect(await children(root, materializer, ['first', 'second'])).toEqual(['done', 'done']);
      const revision = join(root, 'materialized/course/1'); const a = await readFile(join(revision, 'drills/course/drill/a.txt'), 'utf8');
      expect(['first', 'second']).toContain(a); expect(await readFile(join(revision, 'drills/course/drill/b.txt'), 'utf8')).toBe(a);
      const hash = sha256(Buffer.from(a));
      expect(await readFile(join(revision, '.bundle-sha256'), 'utf8')).toBe(sha256(Buffer.from(JSON.stringify([['drills/course/drill/a.txt', hash, 0o644], ['drills/course/drill/b.txt', hash, 0o644]]))));
      expect(await readdir(join(root, 'materialized/course'))).toEqual(['1']);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it('breaks a five-minute-old lock owned by a dead process on this host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'materialize-stale-')); const parent = join(root, 'materialized/course'); const lock = join(parent, '1.lock');
  try {
    await mkdir(parent, { recursive: true }); const old = Date.now() - 301_000;
    await writeFile(lock, JSON.stringify({ pid: 2147483647, hostname: hostname(), timestamp: old })); await utimes(lock, old / 1000, old / 1000);
    expect(await children(root, materializer, ['current', 'other'])).toEqual(['done', 'done']);
    expect(await readdir(parent)).toEqual(['1']);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.each([{ pid: process.pid, hostname: hostname() }, { pid: 2147483647, hostname: 'another-host' }])('does not break an old lock when its owner might be alive: $hostname', async (owner) => {
  const root = await mkdtemp(join(tmpdir(), 'materialize-held-')); const parent = join(root, 'materialized/course'); const lock = join(parent, '1.lock');
  try {
    await mkdir(parent, { recursive: true }); const old = Date.now() - 301_000;
    await writeFile(lock, JSON.stringify({ ...owner, timestamp: old })); await utimes(lock, old / 1000, old / 1000);
    let markStarted!: () => void; const started = new Promise<void>((done) => { markStarted = done; });
    const running = children(root, materializer, ['current'], markStarted); await Promise.race([started, running.then(() => { throw new Error('Child did not wait for the lock'); })]);
    await new Promise<void>((done) => setTimeout(done, 350));
    const held = await readFile(lock, 'utf8').then((value) => JSON.parse(value) as { pid: number }, () => undefined);
    if (held?.pid === owner.pid) await unlink(lock);
    await running; expect(held?.pid).toBe(owner.pid);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it('serializes workspace seeding across processes without mixing or overwriting learner files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seed-process-'));
  try {
    for (const value of ['first', 'second']) { const source = join(root, value); await mkdir(source); for (const file of ['a.txt', 'b.txt']) await writeFile(join(source, file), value); }
    const results = await children(root, seeder, [join(root, 'first'), join(root, 'second')]);
    expect(results.sort()).toEqual(['seeded', 'skipped-existing']);
    const workspace = join(root, 'workspaces/course/drill'); const a = await readFile(join(workspace, 'a.txt'), 'utf8');
    expect(['first', 'second']).toContain(a); expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe(a);
    expect(await readdir(join(root, 'workspaces/course'))).toEqual(['drill']);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
