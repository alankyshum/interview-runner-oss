import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 8 || args[0] !== '--live' || args[2] !== '--replacement' || args[4] !== '--expect-live-sha256' || args[6] !== '--expect-replacement-sha256' || !/^[a-f0-9]{64}$/.test(args[5]) || !/^[a-f0-9]{64}$/.test(args[7])) throw new Error('Usage: content-install-fts --live <database> --replacement <database> --expect-live-sha256 <hash> --expect-replacement-sha256 <hash>');
const live = resolve(args[1]); const replacement = resolve(args[3]);
if (live === replacement || realpathSync(dirname(live)) !== realpathSync(dirname(replacement))) throw new Error('Live and replacement databases must be distinct files in the same directory');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function checkedFile(path, expected) {
  const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`Not a singly linked regular database file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd); if (!same(before, opened)) throw new Error(`Database changed before hashing: ${path}`);
    const digest = createHash('sha256'); const chunk = Buffer.allocUnsafe(1024 * 1024); let count;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) !== 0) digest.update(chunk.subarray(0, count));
    if (digest.digest('hex') !== expected || !same(opened, fstatSync(fd)) || !same(opened, lstatSync(path))) throw new Error(`Database hash or identity changed: ${path}`);
    return opened;
  } finally { closeSync(fd); }
}
const old = checkedFile(live, args[5]); const next = checkedFile(replacement, args[7]);
if (old.uid !== next.uid || old.gid !== next.gid || (old.mode & 0o777) !== (next.mode & 0o777)) throw new Error('Replacement database owner or mode differs from the live database');
if (!same(old, lstatSync(live)) || !same(next, lstatSync(replacement))) throw new Error('Database changed before installation');
renameSync(replacement, live);
const directory = openSync(dirname(live), 'r');
try { fsyncSync(directory); } catch (error) { throw new Error('Replacement was installed but directory sync failed', { cause: error }); } finally { closeSync(directory); }
console.log('Verified replacement installed atomically');
