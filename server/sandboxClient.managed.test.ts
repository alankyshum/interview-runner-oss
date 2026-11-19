// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SandboxManager } from './sandboxClient';

it('opens a managed coding workspace and a revision-pinned AI template without a linked course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-managed-')); const state = join(root, 'state');
  const fake = join(root, 'code-server'); await writeFile(fake, `#!${process.execPath}\nconst net = require('node:net'); const port = Number(process.argv[process.argv.indexOf('--bind-addr') + 1].split(':').pop()); net.createServer(s => s.end()).listen(port, '127.0.0.1');\n`); await chmod(fake, 0o755);
  const old = { ...process.env }; process.env.XDG_STATE_HOME = state; process.env.SANDBOX_UI_STATE_DIR = join(root, 'ui'); process.env.RUNNER_SANDBOX_DRIVER = 'local'; process.env.CODE_SERVER_BIN = fake;
  const managed = join(state, 'interview-runner/managed'); const material = join(managed, 'materialized/course/1/drills/course'); const workspace = join(managed, 'workspaces/course/coding');
  await mkdir(join(material, 'coding'), { recursive: true }); await mkdir(join(material, 'ai/workspace'), { recursive: true }); await mkdir(workspace, { recursive: true });
  await writeFile(join(material, 'coding/source.test.ts'), 'test'); await writeFile(join(workspace, 'source.ts'), 'learner'); await writeFile(join(material, 'ai/workspace/index.ts'), 'template'); await chmod(join(material, 'ai/workspace/index.ts'), 0o444);
  const manager = SandboxManager.fromEnvironment();
  try {
    await manager.start();
    const coding = await manager.create({ id: 'coding-one', repoId: 'managed', courseId: 'course', drillId: 'coding', kind: 'coding', workspacePath: 'drills/course/coding', sourcePath: 'drills/course/coding/source.ts', testPath: 'drills/course/coding/source.test.ts', contentRevision: 1 });
    expect(await readFile(join(coding.workspace, 'source.ts'), 'utf8')).toBe('learner');
    const ai = await manager.create({ id: 'attempt-one', repoId: 'managed', courseId: 'course', drillId: 'ai', kind: 'ai-coding', workspacePath: 'drills/course/ai/workspace', sourcePath: 'drills/course/ai/workspace/index.ts', attemptNumber: 1, contentRevision: 1 });
    expect(await readFile(join(ai.workspace, 'index.ts'), 'utf8')).toBe('template'); await writeFile(join(ai.workspace, 'index.ts'), 'changed');
    await manager.remove(ai.id, false); await manager.remove(coding.id);
  } finally { manager.close(); for (const key of ['XDG_STATE_HOME', 'SANDBOX_UI_STATE_DIR', 'RUNNER_SANDBOX_DRIVER', 'CODE_SERVER_BIN']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.env.RUNNER_SANDBOX_IT !== '1')('managed local driver runs a real coding test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-managed-real-')); const previous = { ...process.env };
  process.env.XDG_STATE_HOME = join(root, 'state'); process.env.SANDBOX_UI_STATE_DIR = join(root, 'ui'); process.env.RUNNER_SANDBOX_DRIVER = 'local'; delete process.env.CODE_SERVER_BIN;
  const state = join(root, 'state/interview-runner/managed'); const material = join(state, 'materialized/course/1/drills/course/drill'); const workspace = join(state, 'workspaces/course/drill');
  await mkdir(material, { recursive: true }); await mkdir(workspace, { recursive: true });
  const source = 'export function add(a: number, b: number) { return a + b; }\n'; const test = "import { expect, it } from 'vitest'; import { add } from './source'; it('adds', () => expect(add(1, 2)).toBe(3));\n";
  await writeFile(join(material, 'source.test.ts'), test); await writeFile(join(workspace, 'source.ts'), source); await writeFile(join(workspace, 'source.test.ts'), test);
  const manager = SandboxManager.fromEnvironment();
  try {
    await manager.start(); const record = await manager.create({ id: 'real-managed-1', repoId: 'managed', courseId: 'course', drillId: 'drill', kind: 'coding', workspacePath: 'drills/course/drill', sourcePath: 'drills/course/drill/source.ts', testPath: 'drills/course/drill/source.test.ts', contentRevision: 1 });
    const execution = await manager.exec(record.id, { action: 'capture-run', runs: [['--mode', 'file', '--runner', 'vitest', '--source', 'source.ts', '--test', 'source.test.ts']] });
    expect(execution.exitCode, execution.output).toBe(0); expect(execution.output).toContain('"status":"passed"'); await manager.remove(record.id);
  } finally { manager.close(); for (const key of ['XDG_STATE_HOME', 'SANDBOX_UI_STATE_DIR', 'RUNNER_SANDBOX_DRIVER', 'CODE_SERVER_BIN']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } await rm(root, { recursive: true, force: true }); }
}, 30_000);
