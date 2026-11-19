import type { TreeEntry } from './userData';

// Minimal tar reader and writer for Podman's container archive API, which is the only way sandboxd can
// read or fill a workspace volume. Supports regular files, directories and symbolic links, with long
// names through pax ('x') and GNU ('L'/'K') extensions. Other entry types are ignored.
const block = 512;
const text = (buffer: Buffer, start: number, length: number): string => { const slice = buffer.subarray(start, start + length); const end = slice.indexOf(0); return slice.subarray(0, end < 0 ? length : end).toString('utf8'); };
function numeric(buffer: Buffer, start: number, length: number): number {
  // GNU base-256 for values that do not fit the octal field.
  if (buffer[start]! & 0x80) { let value = 0; for (let index = start + 1; index < start + length; index++) value = value * 256 + buffer[index]!; return value; }
  const value = text(buffer, start, length).trim(); return value ? parseInt(value, 8) : 0;
}
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}; let offset = 0;
  while (offset < data.length) { const space = data.indexOf(0x20, offset); if (space < 0) break; const length = Number(data.subarray(offset, space).toString()); if (!Number.isSafeInteger(length) || length <= 0) break; const record = data.subarray(space + 1, offset + length - 1).toString('utf8'); const equals = record.indexOf('='); if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1); offset += length; }
  return records;
}

/** Parses a tar archive. `strip` removes that many leading path components; entries left without a path are dropped. */
export function parseTar(archive: Buffer, strip = 0): TreeEntry[] {
  const entries = new Map<string, TreeEntry>(); let offset = 0; let pax: Record<string, string> = {}; let longName: string | undefined; let longLink: string | undefined;
  while (offset + block <= archive.length) {
    const header = archive.subarray(offset, offset + block); offset += block;
    if (header.every((byte) => byte === 0)) break;
    const size = numeric(header, 124, 12); const type = String.fromCharCode(header[156] || 0x30); const data = archive.subarray(offset, offset + size); if (data.length !== size) throw new Error('Truncated tar archive'); offset += Math.ceil(size / block) * block;
    if (type === 'x') { pax = paxRecords(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(data, 0, data.length); continue; }
    if (type === 'K') { longLink = text(data, 0, data.length); continue; }
    const prefix = text(header, 345, 155); const name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100)); const link = pax.linkpath ?? longLink ?? text(header, 157, 100);
    const mtimeMs = pax.mtime ? Math.round(Number(pax.mtime) * 1000) : numeric(header, 136, 12) * 1000; const mode = numeric(header, 100, 8) & 0o7777; pax = {}; longName = undefined; longLink = undefined;
    const path = name.split('/').filter((part) => part && part !== '.').slice(strip).join('/'); if (!path) continue;
    if (type === '0' || type === '7') entries.set(path, { path, type: 'file', mode, mtimeMs, content: Buffer.from(data) });
    else if (type === '5') entries.set(path, { path, type: 'dir', mode, mtimeMs, content: Buffer.alloc(0) });
    else if (type === '2') entries.set(path, { path, type: 'symlink', mode, mtimeMs, content: Buffer.from(link) });
    else if (type === '1') { const target = entries.get(link.split('/').filter((part) => part && part !== '.').slice(strip).join('/')); if (target?.type === 'file') entries.set(path, { ...target, path }); }
  }
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function field(header: Buffer, value: string, start: number, length: number): void { header.write(value, start, length, 'utf8'); }
function octal(header: Buffer, value: number, start: number, length: number): void { field(header, Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0'), start, length - 1); }
function headerBlock(name: string, type: string, size: number, mode: number, mtimeSeconds: number, link: string, owner: { uid: number; gid: number }): Buffer {
  const header = Buffer.alloc(block); field(header, name, 0, 100); octal(header, mode, 100, 8); octal(header, owner.uid, 108, 8); octal(header, owner.gid, 116, 8); octal(header, size, 124, 12); octal(header, mtimeSeconds, 136, 12);
  header.fill(0x20, 148, 156); header.write(type, 156, 1, 'latin1'); field(header, link, 157, 100); field(header, 'ustar', 257, 6); field(header, '00', 263, 2);
  let sum = 0; for (const byte of header) sum += byte; field(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8); return header;
}
function padded(data: Buffer): Buffer[] { const remainder = data.length % block; return remainder ? [data, Buffer.alloc(block - remainder)] : [data]; }
function paxRecord(key: string, value: string): string { const body = ` ${key}=${value}\n`; let length = Buffer.byteLength(body) + 1; while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`); return `${length}${body}`; }

/** Builds a tar archive whose entries are relative to the extraction directory. */
export function buildTar(entries: readonly TreeEntry[], owner: { uid: number; gid: number }): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const name = entry.type === 'dir' ? `${entry.path}/` : entry.path; const link = entry.type === 'symlink' ? entry.content.toString('utf8') : ''; const data = entry.type === 'file' ? entry.content : Buffer.alloc(0);
    const records = `${Buffer.byteLength(name) > 100 ? paxRecord('path', name) : ''}${Buffer.byteLength(link) > 100 ? paxRecord('linkpath', link) : ''}`;
    if (records) { const extended = Buffer.from(records); parts.push(headerBlock('PaxHeader', 'x', extended.length, 0o644, 0, '', owner), ...padded(extended)); }
    const short = (value: string) => Buffer.from(value).subarray(0, 100).toString('latin1');
    const header = headerBlock('', entry.type === 'dir' ? '5' : entry.type === 'symlink' ? '2' : '0', data.length, entry.mode, entry.mtimeMs / 1000, '', owner);
    // Write the possibly truncated raw bytes, then recompute the checksum over the final header.
    header.write(short(name), 0, 100, 'latin1'); header.write(short(link), 157, 100, 'latin1'); header.fill(0x20, 148, 156); let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    parts.push(header, ...padded(data));
  }
  parts.push(Buffer.alloc(block * 2)); return Buffer.concat(parts);
}
