// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PodmanDriver, validateSandboxSpec } from './sandboxd';
import { openContentDb } from './content/contentDb';
import { sha256 } from './content/bundle';
import { materializeCourse } from './content/materialize';

// Sandboxes join their instance's network; the default instance's is created here when this run is the first to need it.
let createdNetwork = false;
beforeAll(async () => { if (process.env.RUNNER_SANDBOX_IT !== '1') return; const run = promisify(execFile); try { await run('podman', ['network', 'exists', 'ir-default-sandbox']); } catch { await run('podman', ['network', 'create', '--internal', '--label', 'io.interview-runner.sandbox=1', '--label', 'io.interview-runner.instance=default', 'ir-default-sandbox']); createdNetwork = true; } });
afterAll(async () => { if (createdNetwork) await promisify(execFile)('podman', ['network', 'rm', 'ir-default-sandbox']).catch(() => {}); });

it.skipIf(process.env.RUNNER_SANDBOX_IT !== '1')('runs a managed workspace with real Podman mounts', async () => {
  const socket = process.env.PODMAN_SOCKET; if (!socket) throw new Error('PODMAN_SOCKET is required for RUNNER_SANDBOX_IT=1');
  const root = await mkdtemp(join(tmpdir(), 'managed-podman-it-')); const settings = join(root, 'settings'); const state = join(root, 'state'); const material = join(state, 'materialized/course/1/drills/course/drill'); const workspace = join(state, 'workspaces/course/drill');
  await mkdir(material, { recursive: true }); await mkdir(workspace, { recursive: true }); await mkdir(settings);
  const test = "import { expect, it } from 'vitest'; import { add } from './source'; it('adds', () => expect(add(1, 2)).toBe(3));\n";
  await writeFile(join(material, 'source.test.ts'), test); await writeFile(join(material, 'source.seed.ts'), 'export const original = 1;');
  await writeFile(join(workspace, 'source.ts'), 'export function add(a: number, b: number) { return a + b; }'); await writeFile(join(workspace, 'source.test.ts'), test); await writeFile(join(workspace, 'source.seed.ts'), 'export const original = 1;');
  const previous = process.env.SANDBOX_UI_STATE_DIR; process.env.SANDBOX_UI_STATE_DIR = join(root, 'ui');
  const driver = new PodmanDriver(socket, process.env.SANDBOX_IMAGE ?? 'localhost/interview-runner-sandbox:1', settings, settings);
  const id = `managed-it-${randomUUID()}`; const spec = { id, repoId: 'managed', courseId: 'course', drillId: 'drill', kind: 'coding' as const, workspacePath: 'drills/course/drill', sourcePath: 'drills/course/drill/source.ts', testPath: 'drills/course/drill/source.test.ts', contentRevision: 1 };
  try {
    const allowlist = { managed: { hostRoot: state, containerRoot: '/app/state/interview-runner/managed' } }; await validateSandboxSpec(spec, allowlist); await driver.create(spec, allowlist);
    let ready = false; for (let attempt = 0; attempt < 100; attempt++) { try { await promisify(execFile)('podman', ['exec', `ir-default-sbx-${id}`, 'git', '-C', '/workspace/drills/course/drill', 'rev-parse', '--verify', 'HEAD']); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
    if (!ready) throw new Error('Managed sandbox Git did not become ready');
    const result = await driver.exec(id, { action: 'capture-run', runs: [['--mode', 'file', '--runner', 'vitest', '--source', 'source.ts', '--test', 'source.test.ts']] });
    expect(result.exitCode, result.output).toBe(0); expect(result.output).toContain('"status":"passed"');
  } finally { await driver.remove(id).catch((error: unknown) => { throw error; }); (driver as any).settings.close(); (driver as any).ui.close(); if (previous === undefined) delete process.env.SANDBOX_UI_STATE_DIR; else process.env.SANDBOX_UI_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(process.env.RUNNER_SANDBOX_IT !== '1')('makes a materialized AI template writable to the sandbox learner', async () => {
  const socket = process.env.PODMAN_SOCKET; if (!socket) throw new Error('PODMAN_SOCKET is required for RUNNER_SANDBOX_IT=1');
  const root = await mkdtemp(join(tmpdir(), 'managed-ai-podman-it-')); const settings = join(root, 'settings'); const state = join(root, 'state'); await mkdir(settings);
  const courseId = `ai-${randomUUID()}`; const drillId = 'drill'; const templatePath = `drills/${courseId}/${drillId}/workspace`; const sourcePath = `${templatePath}/src/value.ts`;
  const db = await openContentDb(':memory:'); const bytes = Buffer.from('export const value = 1;\n'); const hash = sha256(bytes);
  db.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run(courseId, 'ns', 'course', 'Fixture', 'now', 'now', 1, '{}');
  db.prepare('INSERT INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now');
  db.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run(courseId, 1, JSON.stringify({ manifest: {}, files: { [sourcePath]: { sha256: hash, size: bytes.length, mode: 0o644 } } }), 'now');
  const material = await materializeCourse(db, courseId, 1, state); expect((await stat(join(material, sourcePath))).mode & 0o777).toBe(0o444);
  const previous = process.env.SANDBOX_UI_STATE_DIR; process.env.SANDBOX_UI_STATE_DIR = join(root, 'ui');
  const driver = new PodmanDriver(socket, process.env.SANDBOX_IMAGE ?? 'localhost/interview-runner-sandbox:1', settings, settings);
  const id = `managed-ai-${randomUUID()}`; const spec = { id, repoId: 'managed', courseId, drillId, kind: 'ai-coding' as const, workspacePath: templatePath, sourcePath, attemptNumber: 1, contentRevision: 1 };
  try {
    const allowlist = { managed: { hostRoot: state, containerRoot: '/app/state/interview-runner/managed' } }; await validateSandboxSpec(spec, allowlist); await driver.create(spec, allowlist);
    const run = promisify(execFile); let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) { try { await run('podman', ['exec', `ir-default-sbx-${id}`, 'test', '-f', '/workspace/drill-1/.ir-seeded']); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
    if (!ready) throw new Error('Managed AI sandbox did not finish seeding');
    await run('podman', ['exec', '--user', '1000', `ir-default-sbx-${id}`, 'sh', '-c', 'printf "learner edit\\n" > /workspace/drill-1/src/value.ts']);
    const { stdout } = await run('podman', ['exec', '--user', '1000', `ir-default-sbx-${id}`, 'cat', '/workspace/drill-1/src/value.ts']); expect(stdout).toBe('learner edit\n');
    expect((await stat(join(material, sourcePath))).mode & 0o777).toBe(0o444);
  } finally { try { await driver.remove(id, true); await driver.removeWorkspace(courseId, drillId, 1); } finally { (driver as any).settings.close(); (driver as any).ui.close(); db.close(); if (previous === undefined) delete process.env.SANDBOX_UI_STATE_DIR; else process.env.SANDBOX_UI_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); } }
}, 60_000);

// Saves an AI attempt volume into the user database through Podman archives, then proves the work survives losing the volume.
it.skipIf(process.env.RUNNER_SANDBOX_IT !== '1')('stores an AI workspace volume in the user database and refills a lost volume, also for review', async () => {
  const socket = process.env.PODMAN_SOCKET; if (!socket) throw new Error('PODMAN_SOCKET is required for RUNNER_SANDBOX_IT=1');
  const { openUserDb, listTrees, loadTree } = await import('./userData'); const { sandboxNetworkName, sandboxVolumeName } = await import('./sandboxd'); const run = promisify(execFile);
  const instance = `it-${randomUUID().slice(0, 8)}`; const network = sandboxNetworkName(instance); const root = await mkdtemp(join(tmpdir(), 'managed-ai-store-it-')); const settings = join(root, 'settings'); const state = join(root, 'state'); await mkdir(settings);
  const courseId = `ai-${randomUUID()}`; const drillId = 'drill'; const templatePath = `drills/${courseId}/${drillId}/workspace`; const sourcePath = `${templatePath}/src/value.ts`; const volume = sandboxVolumeName(instance, courseId, drillId, 1); const key = `${courseId}/${drillId}/1`;
  const content = await openContentDb(':memory:'); const bytes = Buffer.from('export const value = 1;\n'); const hash = sha256(bytes);
  content.prepare('INSERT INTO course(id,namespace_id,type,title,created_at,updated_at,revision,manifest_json) VALUES(?,?,?,?,?,?,?,?)').run(courseId, 'ns', 'course', 'Fixture', 'now', 'now', 1, '{}');
  content.prepare('INSERT INTO blob(sha256,bytes,size,created_at) VALUES(?,?,?,?)').run(hash, bytes, bytes.length, 'now');
  content.prepare('INSERT INTO course_revision(course_id,revision,bundle_json,created_at) VALUES(?,?,?,?)').run(courseId, 1, JSON.stringify({ manifest: {}, files: { [sourcePath]: { sha256: hash, size: bytes.length, mode: 0o644 } } }), 'now');
  await materializeCourse(content, courseId, 1, state);
  const previous = process.env.SANDBOX_UI_STATE_DIR; process.env.SANDBOX_UI_STATE_DIR = join(root, 'ui'); const store = await openUserDb(join(root, 'runner.sqlite'));
  await run('podman', ['network', 'create', '--internal', '--label', 'io.interview-runner.sandbox=1', '--label', `io.interview-runner.instance=${instance}`, network]);
  const driver = new PodmanDriver(socket, process.env.SANDBOX_IMAGE ?? 'localhost/interview-runner-sandbox:1', settings, settings, undefined, instance, store);
  const allowlist = { managed: { hostRoot: state, containerRoot: '/app/state/interview-runner/managed' } }; const spec = (id: string, review = false) => ({ id, repoId: 'managed', courseId, drillId, kind: 'ai-coding' as const, workspacePath: templatePath, sourcePath, attemptNumber: 1, contentRevision: 1, ...(review ? { review: true } : {}) });
  const name = (id: string) => `ir-${instance}-sbx-${id}`; const inside = (id: string, script: string) => run('podman', ['exec', '--user', '1000', name(id), 'sh', '-c', script]);
  const seeded = async (id: string) => { for (let attempt = 0; attempt < 150; attempt++) { try { await inside(id, 'test -f /workspace/drill-1/.ir-seeded && git -C /workspace/drill-1 rev-parse --verify HEAD'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } throw new Error('AI sandbox did not become ready'); };
  const file = (path: string) => loadTree(store, 'ai-workspace', key)?.find((entry) => entry.path === path)?.content.toString();
  const ids = [`ai-store-${randomUUID()}`, `ai-store-${randomUUID()}`, `ai-store-${randomUUID()}`]; const long = `${'nested-directory/'.repeat(8)}a-long-file-name-for-the-extended-header.txt`;
  try {
    await driver.create(spec(ids[0]!), allowlist); await seeded(ids[0]!);
    await inside(ids[0]!, `cd /workspace/drill-1 && printf 'learner edit\\n' > src/value.ts && mkdir -p "$(dirname '${long}')" && printf long > '${long}' && ln -s src/value.ts link && chmod 755 src/value.ts && git add -A && git commit -qm 'learner commit'`);
    await driver.persistAll(); expect(file('src/value.ts')).toBe('learner edit\n'); expect(file(long)).toBe('long'); expect(file('link')).toBe('src/value.ts'); expect(file('.git/HEAD')).toContain('ref: refs/heads/');
    // The final save happens when the sandbox is removed; then the scratch volume is lost outside the runner.
    await inside(ids[0]!, "printf 'final edit\\n' > /workspace/drill-1/src/value.ts"); await driver.remove(ids[0]!); expect(file('src/value.ts')).toBe('final edit\n');
    await run('podman', ['volume', 'rm', volume]);
    await driver.create(spec(ids[1]!), allowlist); await seeded(ids[1]!);
    expect((await inside(ids[1]!, 'cd /workspace/drill-1 && cat src/value.ts && git log -1 --format=%s && git status --porcelain && cat link && stat -c "%u %a" src/value.ts')).stdout).toBe('final edit\nlearner commit\n M src/value.ts\nfinal edit\n1000 755\n');
    expect((await inside(ids[1]!, `cat '/workspace/drill-1/${long}' && printf 'after restore\\n' > /workspace/drill-1/src/value.ts && cat /workspace/drill-1/src/value.ts`)).stdout).toBe('longafter restore\n');
    expect((await run('podman', ['ps', '-a', '--filter', `label=io.interview-runner.instance=${instance}`, '--format', '{{.Names}}'])).stdout.trim()).toBe(name(ids[1]!));
    // A completed attempt is reviewed read-only after its volume was lost as well.
    await driver.remove(ids[1]!); await run('podman', ['volume', 'rm', volume]);
    await driver.create(spec(ids[2]!, true), allowlist); let reviewed = '';
    for (let attempt = 0; attempt < 150 && !reviewed; attempt++) { try { reviewed = (await inside(ids[2]!, 'cat /workspace/drill-1/src/value.ts && git -C /workspace/drill-1 log -1 --format=%s')).stdout; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
    expect(reviewed).toBe('after restore\nlearner commit\n'); await expect(inside(ids[2]!, 'touch /workspace/drill-1/new-file')).rejects.toThrow(); await driver.remove(ids[2]!); expect(file('src/value.ts')).toBe('after restore\n');
    // Deleting the attempt workspace deletes both the volume and its stored copy.
    await driver.removeWorkspace(courseId, drillId, 1); expect(listTrees(store, 'ai-workspace')).toEqual([]); await expect(run('podman', ['volume', 'exists', volume])).rejects.toThrow();
  } finally {
    try { for (const id of ids) await driver.remove(id).catch(() => {}); await driver.removeWorkspace(courseId, drillId, 1).catch(() => {}); await run('podman', ['network', 'rm', network]).catch(() => {}); }
    finally { (driver as any).settings.close(); (driver as any).ui.close(); store.close?.(); content.close(); if (previous === undefined) delete process.env.SANDBOX_UI_STATE_DIR; else process.env.SANDBOX_UI_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); }
  }
}, 180_000);
