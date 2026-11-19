import { ensureApiKeySchema, issueApiKey, listApiKeys, revokeApiKey, type ApiScope } from '../server/content/apiKeys';
import { statePath } from '../server/statePath';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2); return value;
}
try {
  const path = option('--db') ?? statePath(); const name = option('--name'); const namespace = option('--namespace'); const scope = option('--scope'); const expiresAt = option('--expires');
  const command = args.shift();
  if (args.some((arg) => arg.startsWith('--')) || (command === 'issue' && (args.length || !name || !namespace || !scope)) || (command === 'list' && (args.length || name || namespace || scope || expiresAt)) || (command === 'revoke' && (args.length !== 1 || name || namespace || scope || expiresAt)) || !['issue', 'list', 'revoke'].includes(command ?? '')) throw new Error('Usage: auth:keys [--db path] issue --name name --namespace ns[,ns] --scope content:write[,content:read] [--expires ISO] | list | revoke id');
  let sqlite: typeof import('node:sqlite') | undefined;
  try { sqlite = await import('node:sqlite'); } catch { /* Older Node requires the fallback. */ }
  const db = sqlite ? new sqlite.DatabaseSync(path) : new (await import('better-sqlite3')).default(path);
  try {
    ensureApiKeySchema(db);
    if (command === 'issue') {
      const key = issueApiKey(db, { name: name!, namespaces: namespace!.split(','), scopes: scope!.split(',') as ApiScope[], expiresAt });
      process.stdout.write(`${key}\n`); process.stderr.write('Save this key now; it will not be shown again.\n');
    } else if (command === 'list') process.stdout.write(`${JSON.stringify(listApiKeys(db), null, 2)}\n`);
    else if (!revokeApiKey(db, args[0]!)) throw new Error('Key not found or already revoked');
  } finally { db.close(); }
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
