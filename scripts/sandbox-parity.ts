import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import connect from 'connect';
import apiPlugin, { parseIrResult } from '../server/apiPlugin';
import { loadCourses } from '../server/courses';
import { courseRepos, pathInRepo, requireRepoForCourse } from '../server/courseRepos';
import { SandboxManager } from '../server/sandboxClient';
import { PodmanDriver, sandboxContainerPrefix, sandboxInstance, sandboxNetworkName } from '../server/sandboxd';

type Result = { status: string; tests: Array<{ name: string; status: string }> };
const socket = process.env.PODMAN_SOCKET;
if (!socket) throw new Error('PODMAN_SOCKET is required (for example, the rootless Podman machine socket).');
const image = process.env.SANDBOX_IMAGE ?? 'localhost/interview-runner-sandbox:1';
const run = promisify(execFile);
let createdNetwork = false;
const instance = sandboxInstance(process.env.RUNNER_INSTANCE ?? 'parity'); const network = sandboxNetworkName(instance);
try { await run('podman', ['network', 'exists', network]); }
catch { await run('podman', ['network', 'create', '--internal', '--label', 'io.interview-runner.sandbox=1', '--label', `io.interview-runner.instance=${instance}`, network]); createdNetwork = true; }
const driver = new PodmanDriver(socket, image, undefined, undefined, undefined, instance);
const allowlist = Object.fromEntries(courseRepos.map((repo, index) => [repo.id, { hostRoot: repo.root, containerRoot: `/app/course-repos/parity-${index}` }]));
// Reconcile and reap only sandboxes created by this invocation, never an
// unrelated runner's live editors sharing the Podman service.
const owned = new Set<string>();
const adapter = { list: async () => (await driver.list(false)).filter((record) => owned.has(record.id)), create: (value: any) => { owned.add(value.id); return driver.create(value, allowlist); }, remove: (id: string, volume?: boolean) => driver.remove(id, volume), exec: (id: string, input: any) => driver.exec(id, input) };
const manager = new SandboxManager(adapter as any);
const middleware = connect();
const server = createServer(middleware);
const plugin = apiPlugin({ sandboxManager: manager, allowCodingRequest: () => true, allowStreamRequest: () => true, allowUpgradeRequest: () => true, enableDeterministicWatchers: false });
plugin.configureServer({ httpServer: server, middlewares: middleware } as any);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
const courses = await loadCourses();
const drills = courses.flatMap((course) => course.chapters.flatMap((chapter) => chapter.drills.filter((drill) => drill.contentType === 'coding' && drill.testPath).map((drill) => ({ course, drill }))));
let matched = 0;
const mismatches: string[] = [];
const signature = (result: Result) => ({ status: result.status, tests: result.tests.map((test) => ({ name: test.name, status: test.status })) });
async function waitReady(id: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await run('podman', ['exec', `${sandboxContainerPrefix(instance)}${id}`, 'node', '-e', "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]); return; }
    catch (error) { lastError = error; await new Promise((done) => setTimeout(done, 100)); }
  }
  throw new Error(`Sandbox ${id} did not become ready`, { cause: lastError });
}

try {
  for (let index = 0; index < drills.length; index++) {
    const { course, drill } = drills[index];
    const label = `${course.id}/${drill.id}`;
    const repo = requireRepoForCourse(course.id);
    const workspacePath = `drills/${course.id}/${drill.id}`;
    const workspace = pathInRepo(repo, workspacePath);
    const source = pathInRepo(repo, drill.sourcePath);
    const test = pathInRepo(repo, drill.testPath!);
    const id = `parity-${randomUUID()}`;
    try {
      const record = await manager.create({ id, repoId: repo.id, courseId: course.id, drillId: drill.id, kind: 'coding', workspacePath, sourcePath: drill.sourcePath, testPath: drill.testPath });
      // Git setup completes before code-server listens; running sooner races its initialization.
      await waitReady(id);
      const aliasResponse = await fetch(`${origin}/api/drills/${encodeURIComponent(course.id)}/${encodeURIComponent(drill.id)}/run`, { method: 'POST' });
      const aliasResult = await aliasResponse.json() as Result & { error?: string };
      if (!aliasResponse.ok) throw new Error(`${label}: route alias failed (${aliasResponse.status}): ${aliasResult.error ?? 'unknown error'}`);
      const execution = await manager.exec(id, { action: 'run', args: ['--mode', 'file', '--runner', source.endsWith('.py') ? 'pytest' : 'vitest', '--source', relative(workspace, source).replaceAll('\\', '/'), '--test', relative(workspace, test).replaceAll('\\', '/')] });
      const sandboxResult = parseIrResult(execution.output, [record.workspace]);
      const before = JSON.stringify(signature(aliasResult)); const after = JSON.stringify(signature(sandboxResult));
      if (before === after) matched++;
      else mismatches.push(`${label}\n  alias: ${before}\n  sandbox: ${after}`);
      process.stdout.write(`[${index + 1}/${drills.length}] ${before === after ? 'MATCH' : 'MISMATCH'} ${label}\n`);
    } finally { await manager.remove(id).catch(() => {}); }
  }
} finally {
  if (typeof plugin.closeBundle === 'function') await plugin.closeBundle.call({} as never);
  manager.close(); server.close();
  if (createdNetwork) await run('podman', ['network', 'rm', network]).catch(() => {});
}

console.log(`PARITY SUMMARY drills=${drills.length} matched=${matched} mismatches=${mismatches.length}`);
if (mismatches.length) { console.error(mismatches.join('\n')); process.exitCode = 1; }
