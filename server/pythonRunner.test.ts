import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { COURSE_TEST_TIMEOUT_MS, runPytest } from './pythonRunner';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(source: string, test: string) {
  const root = await mkdtemp(join(tmpdir(), 'python-drill-')); roots.push(root);
  const sourcePath = join(root, 'solve.py'); const testPath = join(root, 'test_solve.py'); const report = join(root, 'report.json');
  await Promise.all([writeFile(sourcePath, source), writeFile(testPath, test)]); return { root, sourcePath, testPath, report };
}

describe('Python drill runner', () => {
  it('returns captured pytest output with call attribution and outside-test phases', async () => {
    const item = await fixture('', `import pytest\nprint('module output')\n@pytest.fixture(autouse=True)\ndef setup():\n    print('setup output')\ndef test_first():\n    print('first output')\ndef test_failed():\n    print('failed output')\n    assert False\ndef test_silent():\n    pass\n`);
    const output = await runPytest(item.testPath, item.report, item.root);
    expect(output.entries.find((entry) => entry.text.includes('module output'))?.testName).toBeUndefined(); expect(output.entries.find((entry) => entry.text.includes('setup output'))?.testName).toBeUndefined();
    expect(output.entries.find((entry) => entry.text.includes('first output'))?.testName).toContain('test_solve.py::test_first'); expect(output.entries.find((entry) => entry.text.includes('failed output'))?.testName).toContain('test_solve.py::test_failed'); expect(output.entries.some((entry) => entry.testName?.includes('test_silent'))).toBe(false);
  });
  it('reports passing and failing pytest cases', async () => {
    const pass = await fixture('def solve(value: int) -> int:\n    return value + 1\n', 'from solve import solve\n\ndef test_solve():\n    assert solve(1) == 2\n');
    await runPytest(pass.testPath, pass.report, pass.root); expect(JSON.parse(await readFile(pass.report, 'utf8')).testResults[0]).toMatchObject({ status: 'passed' });
    const fail = await fixture('def solve(value: int) -> int:\n    return value\n', 'from solve import solve\n\ndef test_solve():\n    assert solve(1) == 2\n');
    await runPytest(fail.testPath, fail.report, fail.root); expect(JSON.parse(await readFile(fail.report, 'utf8')).testResults[0]).toMatchObject({ status: 'failed' });
  });

  it('terminates timed out tests', async () => {
    expect(COURSE_TEST_TIMEOUT_MS).toBe(15_000);
    const item = await fixture('def solve() -> None:\n    pass\n', 'def test_forever():\n    while True:\n        pass\n');
    await expect(runPytest(item.testPath, item.report, item.root, 50)).rejects.toThrow('Tests stopped after 0.05s. Your code may have an infinite loop.');
  });

  it('reports teardown and collection errors as failed', async () => {
    const teardown = await fixture('def solve() -> None:\n    pass\n', 'import pytest\n\n@pytest.fixture\ndef broken():\n    yield\n    assert False, "teardown failed"\n\ndef test_ok(broken):\n    assert True\n');
    await runPytest(teardown.testPath, teardown.report, teardown.root); const teardownReport = JSON.parse(await readFile(teardown.report, 'utf8')); expect(teardownReport.testResults[0]).toMatchObject({ status: 'failed' }); expect(JSON.stringify(teardownReport)).toContain('teardown failed');
    const collection = await fixture('def solve() -> None:\n    pass\n', 'def test_broken(:\n    pass\n');
    await runPytest(collection.testPath, collection.report, collection.root); expect(JSON.parse(await readFile(collection.report, 'utf8')).testResults[0]).toMatchObject({ status: 'failed' });
  });

  it('bounds process output and truncates huge failure representations', async () => {
    const noisy = await fixture('def solve() -> None:\n    pass\n', 'def test_noisy():\n    print("x" * (5 * 1024 * 1024))\n    assert False\n');
    await expect(runPytest(noisy.testPath, noisy.report, noisy.root)).rejects.toThrow(/output exceeded/);
    const huge = await fixture('def solve() -> None:\n    pass\n', 'def test_huge():\n    assert False, "z" * 100_000\n');
    await runPytest(huge.testPath, huge.report, huge.root); const report = await readFile(huge.report, 'utf8'); expect(report.length).toBeLessThan(30_000); expect(report).toContain('failure output truncated');
  });

  it('reports a bounded, ANSI-stripped stderr tail when pytest exits without a report', async () => {
    const item = await fixture('def solve() -> None:\n    pass\n', 'def test_ok():\n    assert True\n'); const bin = join(item.root, 'bin'); await (await import('node:fs/promises')).mkdir(bin); const pytest = join(bin, 'pytest'); await writeFile(pytest, `#!/bin/sh\nprintf '${'discarded '.repeat(3000)}\\033[31mcollection failed\\033[0m' >&2\nexit 1\n`); await chmod(pytest, 0o755); const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
    let message = ''; try { await runPytest(item.testPath, item.report, item.root); } catch (error) { message = error instanceof Error ? error.message : String(error); } finally { process.env.PATH = previous; }
    expect(message).toMatch(/pytest produced no report: .*collection failed/); expect(message).not.toContain('\u001b['); expect(Buffer.byteLength(message)).toBeLessThan(17 * 1024);
  });
});
