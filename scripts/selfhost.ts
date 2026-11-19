// Host-side helper for the self-host package. The Makefile runs it inside the
// runner image so the host needs only a container engine, git and make.
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SelfHostConfig = {
  stack: string; port: number; owner: string; db: string; private?: string;
  content: { git: string; ref: string } | { path: string };
};

// Paths and names are restricted to characters that need no quoting, so the
// derived KEY=VALUE lines are safe as a shell, make and Compose env file alike.
const safePath = /^\/[A-Za-z0-9._@+\-/]+$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** An absolute path, or `./…` relative to the directory holding config.json. */
function hostPath(field: string, value: unknown, base?: string): string {
  let path = value;
  if (typeof path === 'string' && path.startsWith('./')) {
    if (!base || !safePath.test(base)) throw new Error(`${field} is relative, but the directory of config.json is unknown or contains spaces or quotes; use an absolute path`);
    path = `${base.replace(/\/+$/, '')}/${path.slice(2)}`;
  }
  if (typeof path !== 'string' || !safePath.test(path) || path.endsWith('/') || path.split('/').some((part) => part === '.' || part === '..')) throw new Error(`${field} must be an absolute path, or ./… relative to config.json, without spaces, quotes or dot segments`);
  return path;
}
function onlyKeys(field: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${field} has unknown key(s): ${extra.join(', ')}`);
}

/** Mirrors config.schema.json; keep the two in step. */
export function parseConfig(raw: unknown, base?: string): SelfHostConfig {
  if (!isRecord(raw)) throw new Error('config must be a JSON object');
  onlyKeys('config', raw, ['$schema', 'stack', 'port', 'owner', 'content', 'db', 'private']);
  const { stack, port, content } = raw; const owner = raw.owner ?? 'me';
  if (typeof stack !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(stack)) throw new Error('stack must be a lowercase name (letters, digits, hyphens; at most 31 characters)');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535');
  if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(owner)) throw new Error('owner must be a lowercase namespace name');
  const db = hostPath('db', raw.db, base);
  const personal = raw.private === undefined ? {} : { private: hostPath('private', raw.private, base) };
  if (basename(db) === 'content.db') throw new Error('db must not be named content.db; that name is the rebuildable content cache stored next to it');
  if (!isRecord(content)) throw new Error('content must be {"git": url, "ref": ref} or {"path": directory}');
  if ('path' in content) {
    onlyKeys('content', content, ['path']);
    return { stack, port, owner, db, ...personal, content: { path: hostPath('content.path', content.path, base) } };
  }
  onlyKeys('content', content, ['git', 'ref']);
  const { git } = content; const ref = content.ref ?? 'main';
  if (typeof git !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@:/._~+\-]*$/.test(git)) throw new Error('content.git must be a git URL without credentials, spaces or quotes');
  if (/^[a-z+]+:\/\/[^/]*@/.test(git) && !/^[a-z+]+:\/\/git@/.test(git)) throw new Error('content.git must not embed credentials; the host\'s git credentials are used');
  if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/\-]*$/.test(ref)) throw new Error('content.ref must be a branch, tag or commit');
  return { stack, port, owner, db, ...personal, content: { git, ref } };
}

/** Everything the Makefile and compose.yaml derive from config.json. */
export function derive(config: SelfHostConfig): Record<string, string> {
  const dbDir = dirname(config.db); const git = 'git' in config.content ? config.content : undefined;
  if (dbDir === '/') throw new Error('db must live in a directory, not the filesystem root');
  return {
    STACK: config.stack, PORT: String(config.port), OWNER: config.owner,
    DB_DIR: dbDir, DB_FILE: basename(config.db),
    // The git checkout, scratch state and backups live next to the user database.
    CONTENT_MODE: git ? 'git' : 'path', CONTENT_DIR: git ? join(dbDir, 'content') : (config.content as { path: string }).path,
    CONTENT_GIT: git?.git ?? '', CONTENT_REF: git?.ref ?? '',
    // Scratch: refilled from the user database when missing.
    STATE_DIR: join(dbDir, 'scratch'), BACKUP_DIR: join(dbDir, 'backups'),
    // Personal overrides; an empty directory under scratch when none is configured.
    PRIVATE_DIR: config.private ?? join(dbDir, 'scratch', 'private'),
  };
}

async function backup(source: string, destination: string): Promise<void> {
  if (!statSync(source).isFile()) throw new Error(`${source} is not a file`);
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(source, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 5000'); await sqlite.backup(db, destination); } finally { db.close(); }
  const copy = new sqlite.DatabaseSync(destination, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error(`Backup failed its integrity check: ${destination}`);
  } finally { copy.close(); }
  console.log(`Backed up ${basename(source)} (${statSync(destination).size} bytes) to ${destination}`);
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'env') {
    const values = derive(parseConfig(JSON.parse(readFileSync(rest[0] ?? '/config.json', 'utf8')), process.env.CONFIG_DIR));
    console.log(Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'));
  } else if (command === 'token') {
    console.log(`SANDBOXD_TOKEN=${randomBytes(32).toString('hex')}`);
  } else if (command === 'allowlist') {
    // sandboxd binds host paths into sandboxes, so it needs the managed root as the host sees it.
    if (!rest[0]) throw new Error('allowlist requires the host managed-state directory');
    console.log(JSON.stringify({ managed: { containerRoot: '/app/state/interview-runner/managed', hostRoot: rest[0] } }, null, 2));
  } else if (command === 'backup') {
    if (!rest[0] || !rest[1]) throw new Error('backup requires a source and a destination');
    await backup(rest[0], rest[1]);
  } else throw new Error('Usage: selfhost env [config.json] | token | allowlist <host managed dir> | backup <source> <destination>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((error) => { console.error(`selfhost: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
