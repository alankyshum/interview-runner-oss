import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: { start: 'server/start.ts', sandboxd: 'server/sandboxd-entry.ts', 'content-compact-fts': 'scripts/content-compact-fts.ts', 'auth-keys': 'scripts/auth-keys.ts', 'content-workspaces': 'scripts/content-workspaces.ts', 'content-import': 'scripts/content-import.ts', selfhost: 'scripts/selfhost.ts', ir: 'scripts/ir-cli.ts', 'import-legacy': 'scripts/import-legacy.ts' },
  outdir: 'server-dist', outExtension: { '.js': '.mjs' }, bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external',
  external: [resolve('sandbox/*.mjs')],
});
