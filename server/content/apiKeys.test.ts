// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ensureApiKeySchema, issueApiKey, listApiKeys, revokeApiKey, verifyApiKey } from './apiKeys';

it('issues hashed keys, verifies, throttles last use, expires and revokes', () => {
  const db = new DatabaseSync(':memory:'); ensureApiKeySchema(db); ensureApiKeySchema(db);
  try {
    const key = issueApiKey(db, { name: 'author', namespaces: ['sam'], scopes: ['content:write'], expiresAt: '2099-01-01T00:00:00Z' });
    const id = key.split('_')[1]!; const first = new Date('2026-01-01T00:00:00Z');
    expect(key).toMatch(/^irk_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM api_key').get())).not.toContain(key.slice(`irk_${id}_`.length));
    expect(verifyApiKey(db, `Bearer ${key}`, first)).toEqual({ id, name: 'author', scopes: ['content:write'], namespaces: ['sam'] });
    verifyApiKey(db, `Bearer ${key}`, new Date(first.getTime() + 59_999));
    expect(listApiKeys(db)[0]?.last_used_at).toBe(first.toISOString());
    verifyApiKey(db, `Bearer ${key}`, new Date(first.getTime() + 60_000));
    expect(listApiKeys(db)[0]?.last_used_at).toBe(new Date(first.getTime() + 60_000).toISOString());
    expect(JSON.stringify(listApiKeys(db))).not.toContain('key_hash');
    expect(verifyApiKey(db, key, first)).toBeUndefined();
    expect(verifyApiKey(db, `Bearer ${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`, first)).toBeUndefined();
    expect(verifyApiKey(db, `Bearer ${key}`, new Date('2099-01-01'))).toBeUndefined();
    expect(revokeApiKey(db, id)).toBe(true); expect(revokeApiKey(db, id)).toBe(false); expect(verifyApiKey(db, `Bearer ${key}`, first)).toBeUndefined();
  } finally { db.close(); }
});

it('rejects invalid key policies and expiry', () => {
  const db = new DatabaseSync(':memory:'); ensureApiKeySchema(db);
  try {
    expect(() => issueApiKey(db, { name: '', scopes: ['content:write'], namespaces: ['n'] })).toThrow();
    expect(() => issueApiKey(db, { name: 'n', scopes: ['content:read'], namespaces: [] })).toThrow();
    expect(() => issueApiKey(db, { name: 'n', scopes: ['content:read'], namespaces: ['n'], expiresAt: '2000-01-01' })).toThrow();
  } finally { db.close(); }
});
