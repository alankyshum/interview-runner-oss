import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('sandbox dependency contract', () => {
  it('copies immutable AI templates with owner-write while preserving executable bits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-seed-mode-')); const template = join(root, 'template'); const workspace = join(root, 'workspace');
    try {
      await mkdir(join(template, 'src'), { recursive: true }); await mkdir(workspace); const source = join(template, 'src/run.sh');
      await writeFile(source, 'original'); await chmod(source, 0o555);
      const outside = join(root, 'outside'); await writeFile(outside, 'outside'); await chmod(outside, 0o444); await symlink(outside, join(template, 'src/link'));
      const script = await readFile('sandbox/entrypoint.sh', 'utf8');
      const copy = script.split('\n').find((line) => line.trim() === 'cp -a /opt/ir/template/. "$workspace/"');
      const restore = script.split('\n').find((line) => line.trim() === 'chmod -R u+w "$workspace"');
      expect(copy).toBeDefined(); expect(restore).toBeDefined();
      await run('sh', ['-c', `${copy!.replace('/opt/ir/template/.', '"$template"/.')}\n${restore!}`], { env: { PATH: process.env.PATH, template, workspace } });
      expect((await stat(source)).mode & 0o777).toBe(0o555); expect((await stat(join(workspace, 'src/run.sh'))).mode & 0o777).toBe(0o755);
      expect((await stat(outside)).mode & 0o777).toBe(0o444);
      await writeFile(join(workspace, 'src/run.sh'), 'learner'); expect(await readFile(source, 'utf8')).toBe('original');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('pins sandbox packages to its lockfile versions', async () => {
    const sandbox = JSON.parse(await readFile('sandbox/package.json', 'utf8')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(await readFile('sandbox/package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> };
    for (const [name, version] of Object.entries(sandbox.dependencies)) expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
  });
  it('loads the Vitest drill config natively without the CommonJS ESM warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-vite-config-')); const workspace = join(root, 'workspace'); const tools = resolve('sandbox'); const nodeModules = join(tools, 'node_modules');
    try {
      await cp('server/fixtures/sandbox-course/drills/sandbox-integration-fixture/lifecycle/workspace', workspace, { recursive: true }); await symlink(nodeModules, join(workspace, 'node_modules'));
      const { stdout, stderr } = await run(process.execPath, [join(tools, 'run-tests.mjs'), '--mode', 'workspace', '--runner', 'vitest'], { env: { ...process.env, IR_WORKSPACE: workspace, IR_NODE_MODULES: nodeModules, IR_TOOLS: tools }, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
      const envelope = JSON.parse(stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}'); expect(envelope.tests).toHaveLength(1); expect(`${stderr}\n${JSON.stringify(envelope)}`).not.toMatch(/configLoader native|loaded as CommonJS|\.vitest\.drills\.config\.ts/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 35_000);
  it('attributes Vitest console chunks to full test names without guessing concurrent or module output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-vite-output-')); const workspace = join(root, 'workspace'); const tools = resolve('sandbox'); const nodeModules = join(tools, 'node_modules');
    try {
      await mkdir(workspace); await symlink(nodeModules, join(workspace, 'node_modules'));
      await writeFile(join(workspace, 'logs.test.ts'), `console.log('module output');
describe('alpha', () => { test('same', () => { console.log('alpha output'); expect(1).toBe(1); }); });
describe('beta', () => { test('same', () => { console.log('beta output'); expect(1).toBe(2); }); });
describe('parallel', () => { test.concurrent('first', async () => { await new Promise(r => setTimeout(r, 10)); console.log('parallel first'); await new Promise(r => setTimeout(r, 40)); }); test.concurrent('second', async () => { await new Promise(r => setTimeout(r, 30)); console.log('parallel second'); }); });
test('direct write', () => process.stdout.write('direct raw output')); test('silent', () => expect(true).toBe(true));`);
      const { stdout } = await run(process.execPath, [join(tools, 'run-tests.mjs'), '--mode', 'workspace', '--runner', 'vitest'], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, IR_WORKSPACE: workspace, IR_NODE_MODULES: nodeModules, IR_TOOLS: tools }, timeout: 30_000 });
      const result = JSON.parse(stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}'); const entries = result.output.entries as Array<{ text: string; testName?: string }>;
      expect(result.status).toBe('tests-failed'); expect(entries.find((entry) => entry.text.includes('module output'))?.testName).toBeUndefined();
      expect(entries.find((entry) => entry.text.includes('alpha output'))?.testName).toContain('alpha > same');
      expect(entries.find((entry) => entry.text.includes('beta output'))?.testName).toContain('beta > same');
      expect(entries.find((entry) => entry.text.includes('direct raw output'))).toEqual({ stream: 'stdout', text: 'direct raw output' });
      const concurrent = entries.filter((entry) => entry.text.includes('parallel')); expect(concurrent).toHaveLength(2); expect(concurrent.every((entry) => !entry.testName)).toBe(true);
      expect(entries.some((entry) => entry.testName?.includes('silent'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 35_000);
  it('attributes pytest call output and keeps collection and fixture output outside tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-pytest-output-')); const workspace = join(root, 'workspace'); const tools = resolve('sandbox');
    try {
      await mkdir(workspace); await writeFile(join(workspace, 'test_logs.py'), `import pytest\nprint('module output')\n@pytest.fixture(autouse=True)\ndef setup():\n    print('fixture output')\ndef test_first():\n    print('first output')\ndef test_failed():\n    print('failed output')\n    assert False\ndef test_silent():\n    pass\n`);
      const { stdout } = await run(process.execPath, [join(tools, 'run-tests.mjs'), '--mode', 'workspace', '--runner', 'pytest'], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, IR_WORKSPACE: workspace, IR_TOOLS: tools, IR_PYTEST: 'pytest' }, timeout: 30_000 });
      const result = JSON.parse(stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}'); const entries = result.output.entries as Array<{ text: string; testName?: string }>;
      expect(result.status).toBe('tests-failed'); expect(entries.find((entry) => entry.text.includes('module output'))?.testName).toBeUndefined(); expect(entries.find((entry) => entry.text.includes('fixture output'))?.testName).toBeUndefined();
      expect(entries.find((entry) => entry.text.includes('first output'))?.testName).toContain('test_logs.py::test_first'); expect(entries.find((entry) => entry.text.includes('failed output'))?.testName).toContain('test_logs.py::test_failed'); expect(entries.some((entry) => entry.testName?.includes('test_silent'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 35_000);
  it('runs a file-mode Vitest drill through a symlinked workspace path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-vite-file-')); const workspace = join(root, 'workspace-link'); const tools = resolve('sandbox'); const nodeModules = join(tools, 'node_modules');
    try {
      await cp('server/fixtures/sandbox-course/drills/sandbox-integration-fixture/lifecycle/workspace', join(root, 'workspace'), { recursive: true }); await symlink(join(root, 'workspace'), workspace); await symlink(nodeModules, join(workspace, 'node_modules')); await writeFile(join(workspace, 'src/value.ts'), 'export const value = 2;\n');
      const { stdout } = await run(process.execPath, [join(tools, 'run-tests.mjs'), '--mode', 'file', '--runner', 'vitest', '--source', 'src/value.ts', '--test', 'tests/value.test.ts'], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, IR_WORKSPACE: workspace, IR_NODE_MODULES: nodeModules, IR_TOOLS: tools }, timeout: 30_000 });
      const envelope = JSON.parse(stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}'); expect(envelope.status).toBe('passed'); expect(envelope.tests).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 35_000);
  it('checks and executes non-erasable TypeScript syntax with the shipped config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-vite-ts7-')); const workspace = join(root, 'workspace'); const tools = resolve('sandbox'); const nodeModules = join(tools, 'node_modules');
    try {
      await cp('server/fixtures/sandbox-course/drills/sandbox-integration-fixture/lifecycle/workspace', workspace, { recursive: true }); await symlink(nodeModules, join(workspace, 'node_modules'));
      await writeFile(join(workspace, 'src/value.ts'), `export enum Choice { One = 1 }
export namespace Util { export const amount = 2 }
export class Value { accessor extra = 1; constructor(private x: number) {} read() { return this.x + this.extra + Choice.One + Util.amount } }
export const identity = <const T>(value: T) => value;
export function disposeValue() { let disposed = false; { using resource = { [Symbol.dispose]() { disposed = true } }; void resource; } return disposed; }
function addOne(original: (value: number) => number) { return function(value: number) { return original(value) + 1; }; }
export class Decorated { @addOne read(value: number) { return value; } }
`);
      await writeFile(join(workspace, 'tests/value.test.ts'), `import { Value, identity, disposeValue, Decorated } from '../src/value';
test('TypeScript features', () => { expect(identity(new Value(3)).read()).toBe(7); expect(disposeValue()).toBe(true); expect(new Decorated().read(1)).toBe(2); });
`);
      const args = [join(tools, 'run-tests.mjs'), '--mode', 'file', '--runner', 'vitest', '--source', 'src/value.ts', '--test', 'tests/value.test.ts'];
      const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, IR_WORKSPACE: workspace, IR_NODE_MODULES: nodeModules, IR_TOOLS: tools };
      const passed = await run(process.execPath, args, { env, timeout: 30_000 });
      expect(JSON.parse(passed.stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}')).toMatchObject({ status: 'passed', tests: [{ status: 'passed' }] });
      await writeFile(join(workspace, 'src/value.ts'), `${await readFile(join(workspace, 'src/value.ts'), 'utf8')}\nexport const wrong: number = "not a number";\n`);
      const failed = await run(process.execPath, args, { env, timeout: 30_000 });
      expect(JSON.parse(failed.stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}')).toMatchObject({ status: 'type-errors', diagnostics: [{ message: expect.stringContaining('error TS') }] });
      await writeFile(join(workspace, 'src/value.ts'), Array.from({ length: 510 }, (_, index) => `const value${index}: number = "bad";`).join('\n'));
      const capped = await run(process.execPath, args, { env, timeout: 30_000 });
      const cappedResult = JSON.parse(capped.stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}');
      expect(cappedResult.status).toBe('type-errors'); expect(cappedResult.diagnostics).toHaveLength(500); expect(cappedResult.diagnostics[0]).toEqual({ message: expect.stringContaining('error TS') });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 35_000);
  it('renders TSX with the automatic JSX runtime without importing React', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-vite-tsx-')); const workspace = join(root, 'workspace'); const tools = resolve('sandbox'); const nodeModules = join(tools, 'node_modules');
    try {
      await cp('server/fixtures/sandbox-course/drills/sandbox-integration-fixture/lifecycle/workspace', workspace, { recursive: true }); await symlink(nodeModules, join(workspace, 'node_modules'));
      await writeFile(join(workspace, 'src/view.tsx'), 'export function View() { return <h1>Automatic JSX</h1>; }\n');
      await writeFile(join(workspace, 'tests/view.test.tsx'), `import { render, screen } from '@testing-library/react';
import { View } from '../src/view';
test('renders', () => { render(<View />); expect(screen.getByRole('heading', { name: 'Automatic JSX' })).toBeInTheDocument(); });
`);
      const { stdout } = await run(process.execPath, [join(tools, 'run-tests.mjs'), '--mode', 'file', '--runner', 'vitest', '--source', 'src/view.tsx', '--test', 'tests/view.test.tsx'], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, IR_WORKSPACE: workspace, IR_NODE_MODULES: nodeModules, IR_TOOLS: tools }, timeout: 30_000 });
      expect(JSON.parse(stdout.match(/^IR_RESULT (.+)$/m)?.[1] ?? '{}')).toMatchObject({ status: 'passed', tests: [{ status: 'passed' }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 35_000);
});
