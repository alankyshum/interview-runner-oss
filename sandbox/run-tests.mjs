import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { COURSE_TEST_TIMEOUT_MS, courseTestTimeoutMessage } from './test-timeout.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, item, index, values) => item.startsWith('--') ? [...all, [item.slice(2), values[index + 1]?.startsWith('--') ? true : values[index + 1]]] : all, []));
const workspace = process.env.IR_WORKSPACE ?? process.cwd();
const nodeModules = process.env.IR_NODE_MODULES ?? '/opt/ir/node_modules';
const tools = process.env.IR_TOOLS ?? '/opt/ir/tools';
const cap = 4 * 1024 * 1024;
const run = (command, commandArgs, env = process.env, timeoutMs) => new Promise((done, reject) => {
  const child = spawn(command, commandArgs, { cwd: workspace, env, detached: timeoutMs !== undefined, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let timedOut = false;
  const kill = () => { if (timeoutMs !== undefined && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); return; } catch {} } child.kill('SIGKILL'); };
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const append = (name, chunk) => { const next = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length; if (next > cap) { clearTimeout(timer); kill(); reject(new Error('Test output limit exceeded')); return; } if (name === 'stdout') stdout += chunk; else stderr += chunk; };
  child.stdout.on('data', (chunk) => append('stdout', chunk)); child.stderr.on('data', (chunk) => append('stderr', chunk)); child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('close', (code) => { clearTimeout(timer); if (timedOut) reject(Object.assign(new Error('Course test timeout'), { code: 'COURSE_TEST_TIMEOUT' })); else done({ code, stdout, stderr }); });
});
const source = args.source && resolve(workspace, String(args.source)); const test = args.test && resolve(workspace, String(args.test));
const acceptanceRoot = args.acceptance ? resolve(String(args.acceptance)) : undefined;
const acceptanceDir = join(workspace, '.ir-acceptance');
const maxStage = Number(args['max-stage'] ?? 0);
let acceptanceFiles = [];
if (acceptanceRoot && Number.isSafeInteger(maxStage) && maxStage > 0) {
  await mkdir(acceptanceDir, { recursive: true });
  for (const entry of await readdir(acceptanceRoot, { withFileTypes: true })) {
    const match = /^stage-(\d+)\.(?:test\.(?:ts|tsx)|py)$/.exec(entry.name);
    if (entry.isFile() && match && Number(match[1]) <= maxStage) { await cp(join(acceptanceRoot, entry.name), join(acceptanceDir, entry.name)); acceptanceFiles.push(join(acceptanceDir, entry.name)); }
  }
}
let result;
try {
if (args.runner === 'pytest') {
  if (args.mode === 'file' && source && test) {
    const checked = await run(`${nodeModules}/.bin/basedpyright`, ['--outputjson', source, test]);
    try { const report = JSON.parse(checked.stdout); const diagnostics = (report.generalDiagnostics ?? []).filter((item) => item.severity === 'error').slice(0, 500).map((item) => ({ file: item.file, line: Number(item.range?.start?.line ?? 0) + 1, col: Number(item.range?.start?.character ?? 0) + 1, message: item.message })); if (diagnostics.length) result = { status: 'type-errors', diagnostics, tests: [] }; } catch { if (checked.code !== 0) throw new Error(checked.stderr || 'basedpyright returned invalid JSON'); }
  }
  if (!result) {
  const directory = await mkdtemp(join(tmpdir(), 'ir-pytest-')); const output = join(directory, 'result.json');
  try {
    const targets = args.mode === 'file' && test ? [test] : args.mode === 'acceptance' ? acceptanceFiles : [workspace];
    const execution = await run(process.env.IR_PYTEST ?? '/opt/uv-tools/pytest/bin/pytest', [...targets, '-p', 'pytest_report'], { ...process.env, IR_PYTEST_RESULT: output, PYTHONPATH: `${tools}:${process.env.PYTHONPATH ?? ''}` }, COURSE_TEST_TIMEOUT_MS);
    const report = JSON.parse(await readFile(output, 'utf8')); const tests = report.tests;
    const entries = report.output.entries.length ? report.output.entries : execution.stdout ? [{ stream: 'stdout', text: execution.stdout }] : [];
    if (execution.stderr) entries.push({ stream: 'stderr', text: execution.stderr });
    result = { status: tests.some((item) => item.status === 'failed') ? 'tests-failed' : tests.length && tests.every((item) => item.status === 'passed') ? 'passed' : 'incomplete', diagnostics: [], tests, output: { entries, ...(report.output.truncated ? { truncated: true } : {}) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
  }
} else {
  if (args.mode === 'file' && source && test) {
    const directory = await mkdtemp(join(tmpdir(), 'ir-tsconfig-'));
    try {
      const config = join(directory, 'tsconfig.json');
      await symlink(nodeModules, join(directory, 'node_modules'));
      await writeFile(config, JSON.stringify({ extends: join(tools, 'tsconfig.json'), files: [`${tools}/setupTests.ts`, source, test] }));
      const checked = await run(`${nodeModules}/.bin/tsc`, ['--project', config, '--pretty', 'false']);
      if (checked.code !== 0) result = { status: 'type-errors', diagnostics: (checked.stdout || checked.stderr).split(/\r?\n/).filter(Boolean).slice(0, 500).map((message) => ({ message })), tests: [] };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (!result) {
    const directory = await mkdtemp(join(tmpdir(), 'ir-vitest-')); const output = join(directory, 'result.json');
    try {
      // Vitest canonicalizes its root; relative filters also work when the workspace path contains a symlink.
      const targets = (args.mode === 'file' && test ? [test] : args.mode === 'acceptance' ? acceptanceFiles : []).map((target) => relative(workspace, target));
      const execution = await run(process.execPath, [`${nodeModules}/vitest/vitest.mjs`, 'run', ...targets, '--config', `${tools}/vitest.drills.config.mts`, '--configLoader', 'runner', '--reporter=json', `--reporter=${tools}/consoleReporter.ts`, `--outputFile.json=${output}`], { ...process.env, IR_VITE_CACHE: join(directory, 'vite-cache') }, COURSE_TEST_TIMEOUT_MS);
      const report = JSON.parse(await readFile(output, 'utf8').catch(() => '{"testResults":[]}')); const tests = (report.testResults ?? []).flatMap((entry) => (entry.assertionResults ?? []).map((item) => ({ name: args.mode === 'workspace' ? `${entry.name} › ${item.fullName ?? item.title}` : item.fullName ?? item.title, status: item.status === 'todo' ? 'pending' : item.status, ...(item.failureMessages?.[0] ? { message: item.failureMessages[0] } : {}) })));
      const entries = execution.stdout.split(/\r?\n/).flatMap((line) => {
        const prefix = '__INTERVIEW_RUNNER_CONSOLE__'; const at = line.indexOf(prefix);
        if (at < 0) { const notice = `JSON report written to ${output}`; const text = line.endsWith(notice) ? line.slice(0, -notice.length) : line ? `${line}\n` : ''; return text ? [{ stream: 'stdout', text }] : []; }
        const outside = at ? [{ stream: 'stdout', text: line.slice(0, at) }] : [];
        try { return [...outside, JSON.parse(line.slice(at + prefix.length))]; } catch { return [...outside, { stream: 'stdout', text: `${line.slice(at)}\n` }]; }
      }); if (execution.stderr) entries.push({ stream: 'stderr', text: execution.stderr });
      result = { status: tests.some((item) => item.status === 'failed') ? 'tests-failed' : tests.length && tests.every((item) => item.status === 'passed') ? 'passed' : 'incomplete', diagnostics: [], tests, output: { entries } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
} catch (error) { if (error?.code !== 'COURSE_TEST_TIMEOUT') throw error; result = { status: 'error', diagnostics: [], tests: [{ name: 'Test execution error', status: 'failed', message: courseTestTimeoutMessage() }] }; }
finally { await rm(acceptanceDir, { recursive: true, force: true }); }
if (result.output) {
  let bytes = 0; const entries = []; let truncated = Boolean(result.output.truncated);
  for (const entry of result.output.entries) {
    const value = Buffer.from(entry.text); const room = 64 * 1024 - bytes;
    if (entries.length >= 256 || room <= 0) { truncated = true; break; }
    const text = new StringDecoder('utf8').write(value.subarray(0, room)); if (text) entries.push({ ...entry, text }); bytes += Buffer.byteLength(text);
    if (value.length > room) { truncated = true; break; }
  }
  result.output = { entries, ...(truncated ? { truncated: true } : {}) };
}
process.stdout.write(`IR_RESULT ${JSON.stringify(result)}\n`);
