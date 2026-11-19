import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const cli = resolve(import.meta.dirname, 'ir-cli.ts');
const fixture = resolve(import.meta.dirname, 'fixtures/course-schema/v1-example-course.json');
let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
function setup(): void {
  root = mkdtempSync(join(tmpdir(), 'ir-cli-test-'));
  mkdirSync(join(root, 'courses'));
  writeFileSync(join(root, 'interview-courses.json'), JSON.stringify({ kind: 'interview-runner-courses', runner: 'example/runner', schema: 1 }));
  writeFileSync(join(root, 'courses/example-course.json'), readFileSync(fixture));
  writeFileSync(join(root, 'courses/example-course.hints.json'), 'not a manifest');
}
function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: join(root, 'state') } });
}
describe('self-hosted course CLI', () => {
  it('preflights all manifests and dry-runs or migrates only the marker', () => {
    setup(); const marker = join(root, 'interview-courses.json'); const manifest = join(root, 'courses/example-course.json');
    writeFileSync(marker, '{"kind":"interview-runner-courses","runner":"example/runner","schema":1,"metadata":123456789012345678901234567890}\n');
    chmodSync(marker, 0o640);
    const before = readFileSync(marker, 'utf8'); const source = readFileSync(manifest, 'utf8');
    const preview = run('course', 'migrate', join(root, 'courses'), '--dry-run');
    expect(preview.status, preview.stderr).toBe(0); expect(preview.stdout).toContain('schema v1 -> v2');
    expect(readFileSync(marker, 'utf8')).toBe(before); expect(readFileSync(manifest, 'utf8')).toBe(source);
    const migrated = run('course', 'migrate', root);
    expect(migrated.status, migrated.stderr).toBe(0); expect(JSON.parse(readFileSync(marker, 'utf8')).schema).toBe(2);
    expect(readFileSync(marker, 'utf8')).toBe(before.replace('"schema":1', '"schema":2'));
    expect(statSync(marker).mode & 0o777).toBe(0o640);
    expect(readFileSync(manifest, 'utf8')).toBe(source);
  });
  it('reports fields and refuses unsupported UI without mutating any files', () => {
    setup(); const path = join(root, 'courses/example-course.json'); const marker = join(root, 'interview-courses.json');
    const value = JSON.parse(readFileSync(path, 'utf8')); value.chapters[0].drills[0].kind = 'ui';
    const source = JSON.stringify(value); writeFileSync(path, source); const before = readFileSync(marker, 'utf8');
    const result = run('course', 'migrate', root);
    expect(result.status).toBe(1); expect(result.stderr).toContain('example-course.json: hello-logic.kind');
    expect(readFileSync(path, 'utf8')).toBe(source); expect(readFileSync(marker, 'utf8')).toBe(before);
  });
  it('refuses newer versions and symlink manifests', () => {
    setup(); const marker = join(root, 'interview-courses.json');
    writeFileSync(marker, JSON.stringify({ kind: 'interview-runner-courses', runner: 'example/runner', schema: 99 }));
    expect(run('course', 'validate', root).stderr).toContain('course schema v99 is newer than this runner supports');
    writeFileSync(marker, JSON.stringify({ kind: 'interview-runner-courses', runner: 'example/runner', schema: 2 }));
    symlinkSync('example-course.json', join(root, 'courses/alias.json'));
    expect(run('course', 'migrate', root).stderr).toContain('expected a regular file, not a symlink');
  });
  it('refuses to migrate a marker with duplicate schema keys', () => {
    setup(); const marker = join(root, 'interview-courses.json');
    const before = '{"kind":"interview-runner-courses","runner":"example/runner","schema":1,"schema":1}';
    writeFileSync(marker, before);
    const result = run('course', 'migrate', root);
    expect(result.status).toBe(1); expect(result.stderr).toContain('ambiguous schema field');
    expect(readFileSync(marker, 'utf8')).toBe(before);
  });
  it('validates without links, runtime state, credentials or hints', () => {
    setup();
    writeFileSync(join(root, 'courses/example-course.json'), JSON.stringify({ id: 'example-course', title: 'Example', chapters: [] }));
    const result = run('course', 'validate', root);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('Validated 1 manifests');
    const bad = run('course', 'invalid', root);
    expect(bad.status).toBe(1); expect(bad.stderr.trim()).toMatch(/^Usage: ir course validate/);
    expect(run('course', 'validate', '--dry-run').stderr.trim()).toMatch(/^Usage: ir course validate/);
  });
  it('reports missing assets at the manifest and field', () => {
    setup(); const result = run('course', 'validate', root);
    expect(result.status).toBe(1); expect(result.stderr).toContain('example-course.json: hello-logic.sourcePath: missing');
  });
  it('accepts a repository checkout whose directory is itself named courses', () => {
    setup(); const checkout = join(root, 'nested', 'courses');
    mkdirSync(join(checkout, 'courses'), { recursive: true });
    writeFileSync(join(checkout, 'interview-courses.json'), readFileSync(join(root, 'interview-courses.json')));
    writeFileSync(join(checkout, 'courses/example-course.json'), readFileSync(fixture));
    const result = run('course', 'migrate', checkout, '--dry-run');
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('schema v1 -> v2');
  });
  it('distinguishes a courses directory containing an interview-courses manifest from a repository marker', () => {
    setup();
    writeFileSync(join(root, 'courses/interview-courses.json'), JSON.stringify({ id: 'interview-courses', title: 'Interview courses', chapters: [] }));
    const result = run('course', 'migrate', join(root, 'courses'), '--dry-run');
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('schema v1 -> v2');
  });
  it('validates a namespaces/<name> directory under the repository marker', () => {
    setup(); const namespace = join(root, 'namespaces/other'); mkdirSync(join(namespace, 'courses'), { recursive: true });
    const result = run('course', 'validate', namespace);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('Validated 0 manifests (schema v1)');
    const stray = join(root, 'elsewhere/other'); mkdirSync(join(stray, 'courses'), { recursive: true });
    expect(run('course', 'validate', stray).status).toBe(1);
  });
});
