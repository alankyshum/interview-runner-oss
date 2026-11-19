import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type DatabaseLike = { prepare(sql: string): any; exec(sql: string): void };
export type ApiScope = 'content:read' | 'content:write';
export type ApiKey = { id: string; name: string; scopes: ApiScope[]; namespaces: string[] };
type Row = { id: string; name: string; key_hash: string; scopes_json: string; namespaces_json: string; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null };

export function ensureApiKeySchema(db: DatabaseLike): void {
  db.exec(`CREATE TABLE IF NOT EXISTS api_key (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scopes_json TEXT NOT NULL, namespaces_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT)`);
}

export function issueApiKey(db: DatabaseLike, options: { name: string; scopes: ApiScope[]; namespaces: string[]; expiresAt?: string }): string {
  if (!options.name.trim() || !options.scopes.length || options.scopes.some((scope) => scope !== 'content:read' && scope !== 'content:write') || !options.namespaces.length || options.namespaces.some((ns) => !ns.trim() || ns !== ns.trim())) throw new Error('Name, valid scopes and namespaces are required');
  if (options.expiresAt !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(options.expiresAt) || !Number.isFinite(Date.parse(options.expiresAt)) || Date.parse(options.expiresAt) <= Date.now())) throw new Error('Expiry must be a future ISO timestamp');
  const id = randomBytes(12).toString('hex'); const secret = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(secret).digest('hex');
  db.prepare('INSERT INTO api_key(id,name,key_hash,scopes_json,namespaces_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, options.name, hash, JSON.stringify([...new Set(options.scopes)]), JSON.stringify([...new Set(options.namespaces)]), new Date().toISOString(), options.expiresAt ? new Date(options.expiresAt).toISOString() : null);
  return `irk_${id}_${secret}`;
}

export function verifyApiKey(db: DatabaseLike, header: string | undefined, now = new Date()): ApiKey | undefined {
  const match = /^Bearer irk_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/.exec(header ?? '');
  if (!match) return undefined;
  const row = db.prepare('SELECT * FROM api_key WHERE id=?').get(match[1]) as Row | undefined;
  const actual = createHash('sha256').update(match[2]!).digest();
  const expected = row && /^[a-f0-9]{64}$/.test(row.key_hash) ? Buffer.from(row.key_hash, 'hex') : Buffer.alloc(32);
  if (!timingSafeEqual(actual, expected) || !row || row.revoked_at || (row.expires_at && (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now.getTime()))) return undefined;
  const scopes: unknown = JSON.parse(row.scopes_json); const namespaces: unknown = JSON.parse(row.namespaces_json);
  if (!Array.isArray(scopes) || scopes.some((s) => s !== 'content:read' && s !== 'content:write') || !Array.isArray(namespaces) || namespaces.some((n) => typeof n !== 'string')) return undefined;
  const stamp = now.toISOString(); const cutoff = new Date(now.getTime() - 60_000).toISOString();
  db.prepare('UPDATE api_key SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)').run(stamp, row.id, cutoff);
  return { id: row.id, name: row.name, scopes, namespaces };
}

export function revokeApiKey(db: DatabaseLike, id: string): boolean {
  return Number(db.prepare('UPDATE api_key SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes) > 0;
}
export function listApiKeys(db: DatabaseLike): Array<Omit<Row, 'key_hash' | 'scopes_json' | 'namespaces_json'> & { scopes: ApiScope[]; namespaces: string[] }> {
  const rows = db.prepare('SELECT id,name,scopes_json,namespaces_json,created_at,expires_at,last_used_at,revoked_at FROM api_key ORDER BY created_at,id').all() as Array<Omit<Row, 'key_hash'>>;
  return rows.map(({ scopes_json, namespaces_json, ...row }) => ({ ...row, scopes: JSON.parse(scopes_json) as ApiScope[], namespaces: JSON.parse(namespaces_json) as string[] }));
}
