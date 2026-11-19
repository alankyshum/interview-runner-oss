// mounted from apiPlugin.ts before the generic /api router; requires `stateDb()` from db.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ensureApiKeySchema, verifyApiKey, type DatabaseLike } from './apiKeys';
import { checkBundlePath, type CourseBundle } from './bundle';
import { openContentDb, type ContentDb } from './contentDb';
import { blobsMissing, ContentConflictError, ContentValidationError, deleteCourse, getCourseBundle, listCourses, putBlob, putCourseBundle, validationIssue } from './writer';
import { parseCourse } from '../../shared/courseSchema';

type CourseRow = { id: string; namespace_id: string; type: string; title: string; revision: number; updated_at: string; deleted_at: string | null };
const hashPattern = /^[a-f0-9]{64}$/;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function send(res: ServerResponse, status: number, value: unknown): void { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
async function bytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) { const chunk = Buffer.from(raw); size += chunk.length; if (size <= limit) chunks.push(chunk); }
  if (size > limit) throw new HttpError(413, 'Request body is too large');
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<unknown> {
  const body = await bytes(req, 8 * 1024 * 1024);
  try { return JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Request body must be valid JSON'); }
}
function revision(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'Invalid revision');
  return Number(value);
}
function bundleInput(value: unknown, id: string): { bundle: CourseBundle; namespace: string; message?: string } {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.namespace !== 'string' || !raw.namespace.trim() || raw.namespace !== raw.namespace.trim() || !raw.manifest || typeof raw.manifest !== 'object' || Array.isArray(raw.manifest) || (raw.manifest as { id?: unknown }).id !== id || !raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) throw new ContentValidationError([{ field: 'bundle', message: 'Invalid bundle, namespace or course ID' }]);
  if (raw.message !== undefined && (typeof raw.message !== 'string' || [...raw.message].length > 500)) throw new ContentValidationError([{ field: 'message', message: 'Message must be a string of at most 500 characters' }]);
  return { namespace: raw.namespace, ...(raw.message === undefined ? {} : { message: raw.message as string }), bundle: { manifest: raw.manifest, ...(raw.hints === undefined ? {} : { hints: raw.hints }), files: raw.files as CourseBundle['files'] } };
}
function hashes(bundle: CourseBundle): string[] {
  const errors: Array<{ field: string; message: string }> = []; const result: string[] = [];
  for (const [path, file] of Object.entries(bundle.files)) {
    try { checkBundlePath(path); } catch { errors.push({ field: path, message: 'Invalid bundle path' }); continue; }
    if (!file || typeof file !== 'object' || typeof file.sha256 !== 'string' || !hashPattern.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777))) errors.push({ field: path, message: 'Invalid file metadata' });
    else result.push(file.sha256);
  }
  if (errors.length) throw new ContentValidationError(errors);
  return [...new Set(result)];
}
function octal(header: Buffer, offset: number, length: number, value: number): void { header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii'); }
function tarEntry(path: string, data: Uint8Array, mode: number, type = '0'): Buffer[] {
  const header = Buffer.alloc(512); header.write(path, 0, 100, 'utf8'); octal(header, 100, 8, mode); octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, data.length); octal(header, 136, 12, 0); header.fill(32, 148, 156); header.write(type, 156, 1, 'ascii'); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
  return [header, Buffer.from(data), Buffer.alloc((512 - data.length % 512) % 512)];
}
function tar(db: ContentDb, bundle: CourseBundle): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, file] of Object.entries(bundle.files)) {
    checkBundlePath(path);
    const row = db.prepare('SELECT bytes FROM blob WHERE sha256=?').get(file.sha256) as { bytes: Uint8Array } | undefined;
    if (!row) throw new Error('Stored blob missing');
    let name = path;
    if (Buffer.byteLength(path) > 100) {
      const payload = `path=${path}\n`; let length = Buffer.byteLength(payload) + 2;
      while (Buffer.byteLength(`${length} ${payload}`) !== length) length = Buffer.byteLength(`${length} ${payload}`);
      chunks.push(...tarEntry('PaxHeader', Buffer.from(`${length} ${payload}`), 0o644, 'x')); name = 'PaxFile';
    }
    chunks.push(...tarEntry(name, row.bytes, file.mode ?? 0o644));
  }
  chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks);
}

export function createContentApi({ contentDb, stateDb, now = () => new Date(), readWhiteboards, whiteboardStateOrigin }: { contentDb: ContentDb; stateDb: DatabaseLike; now?: () => Date; readWhiteboards?: (courseId: string, drillId: string) => Promise<unknown | null>; whiteboardStateOrigin?: string }) {
  ensureApiKeySchema(stateDb);
  return { async handle(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<boolean> {
    if (parts[0] === 'api' && parts[1] === 'content') parts = parts.slice(2);
    else if (parts[0] === 'content') parts = parts.slice(1);
    else if (!req.url?.startsWith('/api/content/') && req.url !== '/api/content') return false;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const key = verifyApiKey(stateDb, req.headers.authorization, now());
      if (!key) throw new HttpError(401, 'Invalid or missing API key');
      const write = key.scopes.includes('content:write'); const read = write || key.scopes.includes('content:read');
      const requireWrite = () => { if (!write) throw new HttpError(403, 'Write scope required'); };
      const requireRead = () => { if (!read) throw new HttpError(403, 'Read scope required'); };
      const course = (id: string) => contentDb.prepare('SELECT * FROM course WHERE id=?').get(id) as CourseRow | undefined;
      const authorize = (row: CourseRow | undefined) => { if (!row) throw new HttpError(404, 'Course not found'); if (!key.namespaces.includes(row.namespace_id)) throw new HttpError(403, 'Namespace not allowed'); return row; };
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      if (parts.length === 1 && parts[0] === 'me' && method === 'GET') { send(res, 200, key); return true; }
      if (parts.length === 2 && parts[0] === 'workspaces' && method === 'PUT') {
        requireWrite(); const namespace = parts[1]!;
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(namespace)) throw new HttpError(400, 'Invalid workspace');
        if (!key.namespaces.includes(namespace)) throw new HttpError(403, 'Namespace not allowed');
        contentDb.prepare('INSERT OR IGNORE INTO content_meta(key,value) VALUES (?,?)').run(`workspace:${namespace}`, namespace);
        send(res, 200, { workspace: namespace }); return true;
      }
      if (parts[0] === 'courses' && parts.length === 1 && method === 'GET') {
        requireRead(); const ns = query.get('namespace'); if (ns !== null && !key.namespaces.includes(ns)) throw new HttpError(403, 'Namespace not allowed');
        const rows = listCourses(contentDb, ns === null ? {} : { namespace: ns }) as CourseRow[];
        send(res, 200, rows.filter((row) => key.namespaces.includes(row.namespace_id)).map((row) => ({ id: row.id, namespace: row.namespace_id, type: row.type, title: row.title, revision: row.revision, updated_at: row.updated_at }))); return true;
      }
      if (parts[0] === 'blobs') {
        if (parts.length === 2 && parts[1] === 'missing' && method === 'POST') {
          requireWrite(); const body = await json(req) as { sha256?: unknown } | null;
          if (!body || !Array.isArray(body.sha256) || body.sha256.some((h: unknown) => typeof h !== 'string' || !hashPattern.test(h))) throw new HttpError(400, 'Invalid hashes');
          send(res, 200, { missing: blobsMissing(contentDb, body.sha256) }); return true;
        }
        if (parts.length === 1 && method === 'POST') {
          requireWrite(); const hash = req.headers['x-blob-sha256'];
          if (typeof hash !== 'string' || !hashPattern.test(hash) || req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') throw new HttpError(400, 'Invalid blob headers');
          const data = await bytes(req, 16 * 1024 * 1024);
          try { putBlob(contentDb, data, hash); } catch (error) { if (error instanceof ContentValidationError) throw new HttpError(400, 'Blob hash does not match'); throw error; }
          send(res, 201, { sha256: hash }); return true;
        }
        if (parts.length === 2 && method === 'GET' && hashPattern.test(parts[1]!)) {
          requireRead(); const hash = parts[1]!;
          const rows = contentDb.prepare('SELECT c.namespace_id,r.bundle_json FROM course c JOIN course_revision r ON r.course_id=c.id').all() as Array<{ namespace_id: string; bundle_json: string }>;
          const allowed = rows.some((row) => key.namespaces.includes(row.namespace_id) && Object.values((JSON.parse(row.bundle_json) as CourseBundle).files).some((file) => file.sha256 === hash));
          const found = allowed && contentDb.prepare('SELECT bytes FROM blob WHERE sha256=?').get(hash) as { bytes: Uint8Array } | undefined;
          if (!found) throw new HttpError(404, 'Blob not found'); res.statusCode = 200; res.setHeader('Content-Type', 'application/octet-stream'); res.end(Buffer.from(found.bytes)); return true;
        }
      }
      if (parts[0] === 'courses' && parts[1] && /^[a-z0-9][a-z0-9-]*$/.test(parts[1])) {
        const id = parts[1]; const existing = course(id);
        if (parts.length === 4 && parts[2] === 'whiteboards' && method === 'GET') {
          requireRead(); authorize(existing && !existing.deleted_at ? existing : undefined);
          if (whiteboardStateOrigin) throw new HttpError(503, `Whiteboard state is authoritative at ${whiteboardStateOrigin}/api/content/courses/${encodeURIComponent(id)}/whiteboards/${encodeURIComponent(parts[3])}`);
          const result = await readWhiteboards?.(id, parts[3]);
          if (!result) throw new HttpError(404, 'Unknown recall lesson');
          send(res, 200, result); return true;
        }
        if (parts.length === 2 && method === 'PUT' || parts.length === 3 && parts[2] === 'validate' && method === 'POST') {
          requireWrite(); const validate = parts.length === 3; const { bundle, namespace, message } = bundleInput(await json(req), id);
          if (!key.namespaces.includes(namespace)) throw new HttpError(403, 'Namespace not allowed');
          if (existing && existing.namespace_id !== namespace) throw new HttpError(409, 'Course ID already belongs to another workspace');
          let expectedRevision: number | undefined;
          if (!validate) {
            const header = req.headers['if-match']; if (Array.isArray(header)) throw new HttpError(400, 'Invalid If-Match');
            if (existing && header === undefined) throw new HttpError(428, 'If-Match required');
            expectedRevision = header === undefined ? 0 : revision(header);
            if (expectedRevision !== (existing?.revision ?? 0)) throw new HttpError(412, 'Revision mismatch');
          }
          // Reject disallowed reading before asking authors to upload blobs.
          const manifest = bundle.manifest as Record<string, unknown>;
          if (manifest.type !== 'cheatsheet') {
            try { parseCourse('bundle', manifest); } catch (error) { throw new ContentValidationError([validationIssue(error)]); }
          }
          const all = hashes(bundle); const missing = blobsMissing(contentDb, all);
          if (missing.length) {
            send(res, 409, { missing }); return true;
          }
          const warnings: Array<{ field: string; message: string }> = [];
          if (validate) {
            const temp = await openContentDb(':memory:');
            try {
              const blobs = new Map<string, Uint8Array>(); for (const hash of all) { const row = contentDb.prepare('SELECT bytes FROM blob WHERE sha256=?').get(hash) as { bytes: Uint8Array }; blobs.set(hash, row.bytes); }
              await putCourseBundle(temp, bundle, blobs, { namespace, actorApiKeyId: key.id });
            } finally { temp.close(); }
            send(res, 200, { ok: true, warnings }); return true;
          }
          const rev = await putCourseBundle(contentDb, bundle, new Map(), { namespace, expectedRevision, actorApiKeyId: key.id, message });
          send(res, 200, { id, revision: rev, warnings }); return true;
        }
        if (parts.length === 2 && method === 'DELETE') { requireWrite(); const row = authorize(existing); if (row.deleted_at) throw new HttpError(404, 'Course not found'); deleteCourse(contentDb, id); res.statusCode = 204; res.end(); return true; }
        if (parts.length === 3 && parts[2] === 'revisions' && method === 'GET') {
          requireRead(); authorize(existing); send(res, 200, contentDb.prepare('SELECT revision,created_at,actor_api_key_id,message FROM course_revision WHERE course_id=? ORDER BY revision').all(id)); return true;
        }
        if (parts.length === 5 && parts[2] === 'revisions' && parts[4] === 'restore' && method === 'POST') {
          requireWrite(); const row = authorize(existing); const rev = revision(parts[3]!); const bundle = getCourseBundle(contentDb, id, rev); if (!bundle) throw new HttpError(404, 'Revision not found');
          const warnings: Array<{ field: string; message: string }> = []; const next = await putCourseBundle(contentDb, bundle, new Map(), { namespace: row.namespace_id, expectedRevision: row.revision, actorApiKeyId: key.id, message: `Restore revision ${rev}` }); send(res, 200, { id, revision: next, warnings }); return true;
        }
        if ((parts.length === 2 || parts.length === 3 && parts[2] === 'export') && method === 'GET') {
          requireRead(); const row = authorize(existing); const requested = revision(query.get('revision')); if (row.deleted_at && requested === undefined) throw new HttpError(404, 'Course not found');
          const bundle = getCourseBundle(contentDb, id, requested); if (!bundle) throw new HttpError(404, 'Revision not found');
          if (parts.length === 3) { res.statusCode = 200; res.setHeader('Content-Type', 'application/x-tar'); res.end(tar(contentDb, bundle)); }
          else send(res, 200, { ...bundle, revision: requested ?? row.revision, namespace: row.namespace_id }); return true;
        }
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof ContentValidationError) send(res, 422, { errors: error.errors });
      else if (error instanceof ContentConflictError) send(res, 412, { error: 'Revision mismatch' });
      else if (error instanceof HttpError) send(res, error.status, { error: error.message });
      else { console.error('Content API error', error); send(res, 500, { error: 'Internal server error' }); }
      return true;
    }
  } };
}
