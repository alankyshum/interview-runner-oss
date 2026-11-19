// @vitest-environment node
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseCapturedRunOutput, parseIrResult } from './apiPlugin';
import { COURSE_TEST_TIMEOUT_MS, courseTestTimeoutMessage } from '../sandbox/test-timeout.mjs';
import { initializeWorkspaceGit } from './sandboxGit';

const exec = promisify(execFile);

describe('sandbox coding test timeout', () => {
  it.each(['vitest', 'pytest'])('kills a hanging %s process group and returns the timeout through capture-run', async (runner) => {
    const root = await mkdtemp(join(tmpdir(), 'ir-timeout-'));
    const workspace = join(root, 'workspace'); const modules = join(root, 'modules'); const marker = join(root, 'child-survived');
    try {
      await mkdir(workspace); await mkdir(join(modules, '.bin'), { recursive: true }); await mkdir(join(modules, 'vitest'));
      await writeFile(join(workspace, 'source.ts'), 'export const value = 1;'); await writeFile(join(workspace, 'source.test.ts'), 'test'); await initializeWorkspaceGit(workspace);
      const hanging = `import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(process.env.MARKER, 'alive'), ${COURSE_TEST_TIMEOUT_MS + 1000})`)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`;
      const pytest = join(root, 'pytest.mjs'); await writeFile(pytest, `#!${process.execPath}\n${hanging}`); await chmod(pytest, 0o755);
      await writeFile(join(modules, 'vitest/vitest.mjs'), hanging);
      const checker = join(modules, '.bin', runner === 'pytest' ? 'basedpyright' : 'tsc'); await writeFile(checker, runner === 'pytest' ? '#!/bin/sh\necho "{}"\n' : '#!/bin/sh\nexit 0\n'); await chmod(checker, 0o755);
      const args = runner === 'vitest' ? ['--mode', 'file', '--runner', runner, '--source', 'source.ts', '--test', 'source.test.ts'] : ['--mode', 'workspace', '--runner', runner];
      const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, IR_WORKSPACE: workspace, IR_NODE_MODULES: modules, IR_TOOLS: resolve('sandbox'), IR_RUN_TESTS: resolve('sandbox/run-tests.mjs'), IR_PYTEST: pytest, MARKER: marker };
      const { stdout } = await exec(process.execPath, [resolve('sandbox/capture-run.mjs'), JSON.stringify([args])], { env, timeout: COURSE_TEST_TIMEOUT_MS + 10_000 });
      const expected = { status: 'error', diagnostics: [], tests: [{ name: 'Test execution error', status: 'failed', message: courseTestTimeoutMessage() }] };
      expect(parseCapturedRunOutput(stdout).results).toEqual([expected]);
      expect(parseIrResult(`IR_RESULT ${JSON.stringify(expected)}\n`)).toEqual(expected);
      await new Promise((done) => setTimeout(done, 1500));
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, COURSE_TEST_TIMEOUT_MS + 12_000);
});
