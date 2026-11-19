import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripAnsi } from '../src/stripAnsi';
import { COURSE_TEST_TIMEOUT_MS, courseTestTimeoutMessage } from '../sandbox/test-timeout.mjs';

export type PythonOutput = { entries: Array<{ stream: 'stdout' | 'stderr'; text: string; testName?: string }>; truncated?: boolean };
export { COURSE_TEST_TIMEOUT_MS };
export const courseTestTimeoutError = (timeoutMs = COURSE_TEST_TIMEOUT_MS) => new Error(courseTestTimeoutMessage(timeoutMs));

const failure = (message: string, stderr: string) => { const tail = Buffer.from(stripAnsi(stderr.trim())).subarray(-16 * 1024).toString('utf8'); return new Error(tail ? `${message}: ${tail}` : message); };

function execute(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; timeoutError?: Error; children?: Set<ChildProcess> }): Promise<{ code: number; output: PythonOutput; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    options.children?.add(child);
    const output: PythonOutput = { entries: [] }; let bytes = 0; let stdout = ''; let stderr = ''; let capturedBytes = 0; let finished = false;
    const maxCaptureBytes = 4 * 1024 * 1024;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = stripAnsi(decoders[stream].write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      capturedBytes += Buffer.byteLength(text); if (capturedBytes > maxCaptureBytes) { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } finish(new Error('Process output exceeded 4 MiB')); return; }
      if (stream === 'stdout') stdout += text; else stderr += text;
      if (output.truncated || !text) return;
      const room = 64 * 1024 - bytes; const value = Buffer.from(text);
      if (room > 0 && output.entries.length < 256) { const kept = value.subarray(0, room).toString('utf8'); output.entries.push({ stream, text: kept }); bytes += Buffer.byteLength(kept); }
      if (value.length > room || output.entries.length >= 256) output.truncated = true;
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk)); child.stderr?.on('data', (chunk) => append('stderr', chunk));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } finish(options.timeoutError ?? new Error('Process timed out')); }, options.timeoutMs);
    const finish = (error?: Error, code = -1) => { if (finished) return; finished = true; clearTimeout(timer); options.children?.delete(child); for (const stream of ['stdout', 'stderr'] as const) { const tail = stripAnsi(decoders[stream].end()); if (tail) { if (stream === 'stdout') stdout += tail; else stderr += tail; } } error ? reject(error) : resolveRun({ code, output, stdout, stderr }); };
    child.once('error', (error) => finish(error)); child.once('close', (code, signal) => signal ? finish(new Error(`Test runner stopped (${signal})`)) : finish(undefined, code ?? -1));
  });
}

export async function runPytest(testPath: string, outputPath: string, root: string, timeoutMs = COURSE_TEST_TIMEOUT_MS, children?: Set<ChildProcess>): Promise<PythonOutput> {
  const drillDirectory = dirname(testPath);
  const pythonPath = [process.cwd(), drillDirectory, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
  const result = await execute('pytest', [testPath, '--rootdir', drillDirectory, '--import-mode=importlib', '-p', 'no:cacheprovider', '-p', 'scripts.pytest_report', '-q'], {
    cwd: drillDirectory, timeoutMs, timeoutError: courseTestTimeoutError(timeoutMs), children,
    env: { ...process.env, PYTHONPATH: pythonPath, INTERVIEW_RUNNER_PYTEST_REPORT: outputPath, INTERVIEW_RUNNER_PYTEST_PATH: testPath },
  });
  if (![0, 1, 2, 5].includes(result.code)) throw failure(`pytest exited with ${result.code}`, result.stderr);
  let report; try { report = await stat(outputPath); } catch { throw failure('pytest produced no report', result.stderr); } if (report.size > 4 * 1024 * 1024) throw new Error('pytest report exceeded 4 MiB');
  const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as { output?: PythonOutput };
  const captured = parsed.output;
  if (!captured || !Array.isArray(captured.entries)) throw new Error('pytest produced an invalid output report');
  if (!captured.entries.length) return result.output;
  const output: PythonOutput = { entries: [] }; let bytes = 0;
  for (const entry of [...captured.entries, ...result.output.entries.filter((item) => item.stream === 'stderr')]) {
    const raw = Buffer.from(stripAnsi(entry.text)); const remaining = 64 * 1024 - bytes;
    if (output.entries.length >= 256 || remaining <= 0) { output.truncated = true; break; }
    const text = new StringDecoder('utf8').write(raw.subarray(0, remaining));
    if (text) output.entries.push({ ...entry, text, ...(entry.testName ? { testName: stripAnsi(entry.testName) } : {}) });
    bytes += Buffer.byteLength(text); if (raw.length > remaining) { output.truncated = true; break; }
  }
  if (captured.truncated || result.output.truncated) output.truncated = true;
  return output;
}
