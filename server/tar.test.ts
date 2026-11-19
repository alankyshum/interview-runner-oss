// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildTar, parseTar } from './tar';
import { readTree, treeSignature, writeTree, type TreeEntry } from './userData';

const long = `${'deep-directory-name/'.repeat(7)}a-file-name-that-is-long-enough-to-need-an-extended-header.txt`;
function sample(root: string): void {
  mkdirSync(join(root, 'src/empty'), { recursive: true }); mkdirSync(join(root, long, '..'), { recursive: true }); writeFileSync(join(root, long), 'long path'); writeFileSync(join(root, 'src/index.ts'), 'export {};\n'); writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'binary.bin'), Buffer.from(Array.from({ length: 1500 }, (_, index) => index % 256))); writeFileSync(join(root, 'empty.txt'), ''); symlinkSync('/opt/ir/node_modules', join(root, 'node_modules')); symlinkSync(`../${'x'.repeat(120)}`, join(root, 'long-link'));
}
const shape = (entries: TreeEntry[]) => entries.map((entry) => ({ path: entry.path, type: entry.type, mode: entry.type === 'symlink' ? 0 : entry.mode, content: entry.content.toString('base64') }));

it('round-trips a tree through its own archives and through the system tar in both directions', () => {
  const root = mkdtempSync(join(tmpdir(), 'tar-'));
  try {
    const source = join(root, 'source'); mkdirSync(source); sample(source); const entries = readTree(source); expect(Buffer.byteLength(long)).toBeGreaterThan(100);
    const archive = buildTar(entries, { uid: 1000, gid: 1000 }); expect(archive.length % 512).toBe(0); expect(treeSignature(parseTar(archive))).toBe(treeSignature(entries)); expect(shape(parseTar(archive))).toEqual(shape(entries));
    // Our archive extracts correctly with the system tar.
    const extracted = join(root, 'extracted'); mkdirSync(extracted); writeFileSync(join(root, 'ours.tar'), archive); execFileSync('tar', ['-xf', join(root, 'ours.tar'), '-C', extracted]); execFileSync('diff', ['-r', '--no-dereference', source, extracted]);
    // A system archive with a leading directory (as Podman returns) parses to the same tree once that component is stripped.
    execFileSync('tar', ['-cf', join(root, 'system.tar'), '-C', root, 'source'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }); const parsed = parseTar(execFileSync('cat', [join(root, 'system.tar')], { maxBuffer: 64 * 1024 * 1024 }), 1); expect(shape(parsed)).toEqual(shape(entries));
    const restored = join(root, 'restored'); writeTree(restored, parsed); execFileSync('diff', ['-r', '--no-dereference', source, restored]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('rejects a truncated archive and ignores trailing padding', () => {
  const archive = buildTar([{ path: 'a.txt', type: 'file', mode: 0o644, mtimeMs: 1_700_000_000_000, content: Buffer.from('hello') }], { uid: 0, gid: 0 });
  expect(parseTar(Buffer.concat([archive, Buffer.alloc(4096)]))).toMatchObject([{ path: 'a.txt', mtimeMs: 1_700_000_000_000 }]); expect(parseTar(archive)[0]!.content.toString()).toBe('hello');
  expect(() => parseTar(archive.subarray(0, 514))).toThrow('Truncated');
});
