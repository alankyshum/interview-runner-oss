import { exportTrees, importLegacy } from '../server/importLegacy';

const usage = `Usage:
  import-legacy --progress-db OLD.db --out NEW.sqlite [--ui-state DIR] [--managed DIR] [--workspace-git DIR] [--ai-volumes DIR] [--force]
  import-legacy export --db NEW.sqlite --out DIR

Builds the single user database (RUNNER_DB_PATH) from the old layout. Inputs are only read; pass copies or read-only mounts.
  --progress-db    old progress.db
  --ui-state       old SANDBOX_UI_STATE_DIR (e.g. /data/sandbox-ui-state)
  --managed        old managed state directory holding workspaces/<course>/<drill>
  --workspace-git  old SANDBOX_SETTINGS_DIR/.workspace-git holding <course>/<drill>.git
  --ai-volumes     directory with one sub-directory per exported AI volume, named ir-ws-<course>--<drill>--<attempt>
  --force          rebuild NEW.sqlite when it already exists (re-run from a fresh copy of the old data at cutover)
export writes every stored file tree to DIR/<kind>/<key> for inspection or a round-trip check.`;

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`); args.splice(index, 2); return value;
}
function flag(name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; }
try {
  if (flag('--help') || flag('-h')) { console.log(usage); process.exit(0); }
  if (args[0] === 'export') {
    args.shift(); const db = option('--db'); const out = option('--out'); if (!db || !out || args.length) throw new Error(usage);
    console.log(JSON.stringify(await exportTrees(db, out), null, 2));
  } else {
    const progressDb = option('--progress-db'); const out = option('--out'); const uiState = option('--ui-state'); const managed = option('--managed'); const workspaceGit = option('--workspace-git'); const aiVolumes = option('--ai-volumes'); const force = flag('--force');
    if (!progressDb || !out || args.length) throw new Error(usage);
    console.log(JSON.stringify(await importLegacy({ progressDb, out, uiState, managed, workspaceGit, aiVolumes, force }), null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
