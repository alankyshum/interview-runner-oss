import { readFile } from 'node:fs/promises';
import { createSandboxd, PodmanDriver, sandboxInstance, type SandboxAllowlist } from './sandboxd';
import { openUserDb } from './userData';

const token = process.env.SANDBOXD_TOKEN ?? ''; const allowlistPath = process.env.SANDBOX_ALLOWLIST ?? '/app/course-repos.sandbox.json';
// Sandbox ownership is derived from the instance, so an unset value must fail closed rather than share a default with another stack.
if (!process.env.RUNNER_INSTANCE) throw new Error('RUNNER_INSTANCE is required');
const instance = sandboxInstance(process.env.RUNNER_INSTANCE);
const allowlist = JSON.parse(await readFile(allowlistPath, 'utf8')) as SandboxAllowlist;
// With RUNNER_DB_PATH, workspaces and UI state are saved into the single user database shared with the runner.
const dbPath = process.env.RUNNER_DB_PATH; const store = dbPath ? await openUserDb(dbPath) : undefined;
const driver = new PodmanDriver(undefined, undefined, undefined, undefined, undefined, instance, store, dbPath);
const server = createSandboxd({ token, allowlist, driver }).listen(7070, '0.0.0.0');
if (store) {
  let saving: Promise<void> | undefined;
  const save = () => (saving ??= driver.persistAll().catch((error) => { console.error(`Sandbox autosave failed: ${error instanceof Error ? error.message : String(error)}`); }).finally(() => { saving = undefined; }));
  const autosaveSeconds = Number(process.env.SANDBOX_AUTOSAVE_SECONDS ?? 60);
  if (Number.isFinite(autosaveSeconds) && autosaveSeconds > 0) setInterval(() => { void save(); }, autosaveSeconds * 1000).unref();
  // Sandbox containers outlive sandboxd, so shutdown saves their current state instead of stopping them.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { server.close(); void Promise.resolve(saving).then(() => driver.persistAll()).catch((error) => { console.error(`Sandbox shutdown save failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }).finally(() => { store.close?.(); process.exit(); }); });
}
