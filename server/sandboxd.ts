import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import type { SandboxCreateSpec, SandboxExecRequest, SandboxHealth, SandboxRecord } from './sandboxTypes';
import { cgroupHealth, extensionHostCrashes } from './sandboxHealth';
import { SandboxSettingsSync } from './sandboxSettings';
import { editableSandboxPaths, SandboxUiStateSync } from './sandboxUiState';
import { preparePodmanWorkspaceGit, removeWorkspaceGitPointer, workspaceGitDirectory } from './sandboxGit';
import { alignDbOwnership, deleteTree, loadTree, packTree, saveTree, unpackTree, workspaceExcluded, type UserDb } from './userData';
import { buildTar, parseTar } from './tar';

export const sandboxLabel = 'io.interview-runner.sandbox';
export const instanceLabel = 'io.interview-runner.instance';
// Every container, volume and network a sandboxd owns is named and labelled for its RUNNER_INSTANCE.
// Items without this instance's label (other stacks, or legacy unlabelled ir-sbx-*/ir-ws-* items) are never listed, reused or removed.
export function sandboxInstance(value = process.env.RUNNER_INSTANCE ?? 'default'): string { if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw new Error('RUNNER_INSTANCE must match [a-z0-9][a-z0-9-]{0,31}'); return value; }
export const sandboxContainerPrefix = (instance: string) => `ir-${instance}-sbx-`;
export const sandboxVolumeName = (instance: string, courseId: string, drillId: string, attemptNumber: number | string) => `ir-${instance}-ws-${courseId}--${drillId}--${attemptNumber}`;
export const sandboxNetworkName = (instance: string) => `ir-${instance}-sandbox`;
const drillLabel = 'io.interview-runner.drill';
const hostWorkspaceLabel = 'io.interview-runner.host-workspace';
// Set on sandboxes whose workspace is saved into the user database (managed content with RUNNER_DB_PATH).
const persistLabel = 'io.interview-runner.persist';
const containerGitDirectory = '/opt/ir/workspace-git';
const maxBody = 1024 * 1024;
const maxPodmanResponse = 5 * 1024 * 1024;
const maxWorkspaceFilesResponse = 100 * 1024 * 1024;
const maxWorkspaceArchive = 512 * 1024 * 1024;
const helperLabel = 'io.interview-runner.helper';
// A random value set on a volume by the call that creates it: the only proof that this call, not an earlier one or another party, made the volume.
const createTokenLabel = 'io.interview-runner.create-token';
type RepoMount = { containerRoot: string; hostRoot: string };
export type SandboxAllowlist = Record<string, RepoMount>;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > maxBody) throw Object.assign(new Error('Request body is too large'), { status: 413 }); chunks.push(chunk); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}
function safeRelative(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes('\0')) return undefined;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith('../') ? normalized : undefined;
}
function under(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`)); }
async function canonicalWithoutSymlinks(path: string, boundary = path): Promise<string> {
  const absolute = resolve(path); const root = resolve(boundary); if (!under(root, absolute)) throw Object.assign(new Error('Mount source is outside the allowlist'), { status: 403 });
  let current = root; if ((await lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Mount source contains a symbolic link'), { status: 403 });
  const rel = relative(root, absolute); for (const part of rel ? rel.split(sep) : []) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Mount source contains a symbolic link'), { status: 403 }); }
  return realpath(absolute);
}
async function authorizeMounts(spec: SandboxCreateSpec, allowlist: SandboxAllowlist, retried = false): Promise<{ root: string; workspace: string; source: string; test?: string; acceptance?: string }> {
  const configured = allowlist[spec.repoId]; if (!configured) throw Object.assign(new Error('Unknown course repository'), { status: 403 });
  if (spec.repoId === 'managed') {
    if (!Number.isSafeInteger(spec.contentRevision) || Number(spec.contentRevision) < 1) throw Object.assign(new Error('Invalid content revision'), { status: 400 });
    try {
      const root = await canonicalWithoutSymlinks(configured.hostRoot);
      const revision = await canonicalWithoutSymlinks(join(root, 'materialized', spec.courseId, String(spec.contentRevision)), root);
      const drill = await canonicalWithoutSymlinks(join(revision, 'drills', spec.courseId, spec.drillId), root);
      const template = await canonicalWithoutSymlinks(join(revision, spec.workspacePath), root);
      if (!under(drill, template)) throw Object.assign(new Error('Template is outside the drill'), { status: 403 });
      const workspace = spec.kind === 'coding' ? await canonicalWithoutSymlinks(join(root, 'workspaces', spec.courseId, spec.drillId), root) : template;
      const source = await canonicalWithoutSymlinks(join(workspace, spec.sourcePath.slice(spec.workspacePath.length + 1)), root);
      const test = spec.testPath ? await canonicalWithoutSymlinks(join(revision, spec.testPath), root) : undefined;
      const acceptance = spec.acceptancePath ? await canonicalWithoutSymlinks(join(revision, spec.acceptancePath), root) : undefined;
      if (!under(workspace, source) || (test && !under(drill, test)) || (acceptance && !under(drill, acceptance))) throw Object.assign(new Error('Mount source is outside the drill'), { status: 403 });
      return { root, workspace, source, ...(test ? { test } : {}), ...(acceptance ? { acceptance } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (retried) throw Object.assign(new Error('Unknown content revision or workspace path'), { status: 403 });
      await new Promise<void>((done) => setTimeout(done, 25));
      return authorizeMounts(spec, allowlist, true);
    }
  }
  const root = await canonicalWithoutSymlinks(configured.hostRoot); const drills = await canonicalWithoutSymlinks(join(root, 'drills'), root);
  const mount = async (path: string) => { const canonical = await canonicalWithoutSymlinks(join(root, path), root); if (!under(drills, canonical)) throw Object.assign(new Error('Mount source is outside the allowlist'), { status: 403 }); return canonical; };
  return { root, workspace: await mount(spec.workspacePath), source: await mount(spec.sourcePath), ...(spec.testPath ? { test: await mount(spec.testPath) } : {}), ...(spec.acceptancePath ? { acceptance: await mount(spec.acceptancePath) } : {}) };
}
export async function validateSandboxSpec(value: unknown, allowlist: SandboxAllowlist): Promise<SandboxCreateSpec> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Sandbox spec must be an object'), { status: 400 });
  const input = value as Record<string, unknown>;
  const allowed = ['acceptancePath', 'attemptNumber', 'contentRevision', 'courseId', 'drillId', 'id', 'kind', 'repoId', 'review', 'sourcePath', 'testPath', 'workspacePath'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw Object.assign(new Error('Sandbox spec has unknown fields'), { status: 400 });
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(input.id)) throw Object.assign(new Error('Invalid sandbox id'), { status: 400 });
  if (typeof input.repoId !== 'string' || !allowlist[input.repoId]) throw Object.assign(new Error('Unknown course repository'), { status: 403 });
  if (typeof input.courseId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.courseId) || typeof input.drillId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.drillId)) throw Object.assign(new Error('Invalid course or drill id'), { status: 400 });
  if (input.kind !== 'coding' && input.kind !== 'ai-coding') throw Object.assign(new Error('Invalid sandbox kind'), { status: 400 });
  const workspacePath = safeRelative(input.workspacePath); const sourcePath = safeRelative(input.sourcePath); const testPath = input.testPath === undefined ? undefined : safeRelative(input.testPath); const acceptancePath = input.acceptancePath === undefined ? undefined : safeRelative(input.acceptancePath);
  if (!workspacePath || !sourcePath || (input.testPath !== undefined && !testPath) || (input.acceptancePath !== undefined && !acceptancePath)) throw Object.assign(new Error('Invalid sandbox path'), { status: 400 });
  const expected = input.kind === 'coding' ? `drills/${input.courseId}/${input.drillId}` : `drills/${input.courseId}/${input.drillId}/workspace`;
  if (workspacePath !== expected || !sourcePath.startsWith(`${workspacePath}/`) || (testPath && !testPath.startsWith(`${workspacePath}/`)) || (acceptancePath && acceptancePath !== `${dirname(workspacePath)}/acceptance`)) throw Object.assign(new Error('Sandbox path escapes the drill'), { status: 403 });
  if (input.attemptNumber !== undefined && (!Number.isSafeInteger(input.attemptNumber) || Number(input.attemptNumber) < 1)) throw Object.assign(new Error('Invalid attempt number'), { status: 400 });
  if (input.review !== undefined && (input.review !== true || input.kind !== 'ai-coding' || input.attemptNumber === undefined)) throw Object.assign(new Error('Invalid review workspace'), { status: 400 });
  if (input.repoId === 'managed' ? !Number.isSafeInteger(input.contentRevision) || Number(input.contentRevision) < 1 : input.contentRevision !== undefined) throw Object.assign(new Error('Invalid content revision'), { status: 400 });
  if (input.repoId === 'managed' && input.kind === 'ai-coding' && input.attemptNumber === undefined) throw Object.assign(new Error('Invalid attempt number'), { status: 400 });
  const spec = { id: input.id, repoId: input.repoId, courseId: input.courseId, drillId: input.drillId, kind: input.kind, workspacePath, sourcePath, ...(testPath ? { testPath } : {}), ...(acceptancePath ? { acceptancePath } : {}), ...(input.attemptNumber === undefined ? {} : { attemptNumber: Number(input.attemptNumber) }), ...(input.review === true ? { review: true } : {}), ...(input.contentRevision === undefined ? {} : { contentRevision: Number(input.contentRevision) }) } as SandboxCreateSpec;
  await authorizeMounts(spec, allowlist); return spec;
}

export function tokenAllowed(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

type PodmanResponse = { status: number; body: Buffer };
export class PodmanDriver {
  private readonly settings: SandboxSettingsSync;
  private readonly ui: SandboxUiStateSync;
  private readonly instance: string;
  constructor(private readonly socketPath = process.env.PODMAN_SOCKET ?? '/run/podman.sock', private readonly image = process.env.SANDBOX_IMAGE ?? '', private readonly settingsDirectory = process.env.SANDBOX_SETTINGS_DIR ?? resolve('sandbox'), private readonly settingsHostDirectory = process.env.SANDBOX_SETTINGS_HOST_DIR ?? settingsDirectory, fallbackDirectory = resolve('sandbox'), instance?: string, private readonly store?: UserDb, private readonly storePath = ':memory:') {
    if (!this.image) throw new Error('SANDBOX_IMAGE is required');
    this.instance = sandboxInstance(instance);
    // A host's own keybindings.json and settings.json (config.json's `private` directory) take precedence over the image defaults.
    this.settings = new SandboxSettingsSync(process.env.RUNNER_PRIVATE_DIR ?? settingsDirectory, fallbackDirectory);
    this.ui = new SandboxUiStateSync();
    // The UI-state directory is scratch: an empty one is refilled from the user database.
    if (this.store && !(existsSync(this.ui.stateDirectory) && readdirSync(this.ui.stateDirectory).length)) this.saved('restore UI state', () => unpackTree(this.store!, 'ui-state', '', this.ui.stateDirectory));
  }
  // Saves of one workspace may overlap (periodic autosave, final save on removal, deletion). Every save takes an increasing sequence number when it
  // starts reading. It commits only if no save that started later has already committed and the workspace was not deleted meanwhile. A save that
  // fails or is dropped changes nothing, so a later failed autosave cannot discard an earlier successful final save.
  private saveSequence = 0;
  private readonly committedSequence = new Map<string, number>();
  private readonly deletionEpoch = new Map<string, number>();
  private markDeletion(key: string): void { this.deletionEpoch.set(key, (this.deletionEpoch.get(key) ?? 0) + 1); }
  private readonly locks = new Map<string, Promise<unknown>>();
  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> { const next = (this.locks.get(key) ?? Promise.resolve()).then(operation, operation); const settled = next.then(() => undefined, () => undefined); this.locks.set(key, settled); void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key); }); return next; }
  // Persistence never fails a sandbox operation: the scratch copy stays authoritative until the next save succeeds.
  private saved(what: string, operation: () => unknown): void { try { operation(); alignDbOwnership(this.storePath); } catch (error) { console.error(`Sandbox persistence failed (${what}): ${error instanceof Error ? error.message : String(error)}`); } }
  private persistUiState(): void { if (this.store) this.saved('UI state', () => packTree(this.store!, 'ui-state', '', this.ui.stateDirectory)); }
  private persistCoding(labels: Record<string, string> | undefined): void {
    const [courseId, drillId] = String(labels?.[drillLabel] ?? '').split('/'); const workspace = labels?.[hostWorkspaceLabel];
    if (!this.store || labels?.[persistLabel] !== '1' || labels?.[instanceLabel] !== this.instance || !workspace || !courseId || !drillId) return;
    this.saved(`workspace ${courseId}/${drillId}`, () => { packTree(this.store!, 'workspace', `${courseId}/${drillId}`, workspace, workspaceExcluded); packTree(this.store!, 'workspace-git', `${courseId}/${drillId}`, workspaceGitDirectory(courseId, drillId, join(this.settingsDirectory, '.workspace-git'))); });
  }
  // AI workspaces live in a named volume that only Podman can read, so they travel as container archives.
  private async persistAi(row: Record<string, any>): Promise<void> {
    const labels = row.Labels as Record<string, string> | undefined; const [courseId, drillId, attempt] = String(labels?.[drillLabel] ?? '').split('/'); const workspace = labels?.['io.interview-runner.workspace'];
    if (!this.store || labels?.[persistLabel] !== '1' || labels?.[instanceLabel] !== this.instance || labels?.['io.interview-runner.kind'] !== 'ai-coding' || labels?.['io.interview-runner.review'] === '1' || !workspace || !courseId || !drillId || !attempt) return;
    const key = `${courseId}/${drillId}/${attempt}`; const sequence = ++this.saveSequence; const epoch = this.deletionEpoch.get(key) ?? 0;
    try {
      const response = await this.call('GET', `/containers/${encodeURIComponent(String(row.Id))}/archive?path=${encodeURIComponent(workspace)}`, undefined, maxWorkspaceArchive); if (response.status < 200 || response.status >= 300) throw new Error(`Podman archive failed (${response.status})`);
      const entries = parseTar(response.body, 1);
      // An unseeded volume is not a workspace yet; saving it could replace a stored copy with nothing.
      if (!entries.some((entry) => entry.path === '.ir-seeded')) return;
      // A save that started later has already committed, or the workspace was deleted while this archive was in flight: this copy is stale.
      if (sequence <= (this.committedSequence.get(key) ?? 0) || (this.deletionEpoch.get(key) ?? 0) !== epoch) return;
      this.saved(`AI workspace ${key}`, () => { saveTree(this.store!, 'ai-workspace', key, entries); this.committedSequence.set(key, sequence); });
    } catch (error) { console.error(`Sandbox persistence failed (AI workspace ${courseId}/${drillId}/${attempt}): ${error instanceof Error ? error.message : String(error)}`); }
  }
  private async inspectVolume(volume: string): Promise<{ Labels?: Record<string, string>; NeedsChown?: boolean } | undefined> {
    const inspected = await this.call('GET', `/volumes/${encodeURIComponent(volume)}`); if (inspected.status === 404) return undefined;
    if (inspected.status < 200 || inspected.status >= 300) throw Object.assign(new Error(`Podman GET /volumes/${encodeURIComponent(volume)} failed (${inspected.status}): ${inspected.body.toString('utf8').slice(0, 1000)}`), { status: 502 });
    return JSON.parse(inspected.body.toString('utf8')) as { Labels?: Record<string, string>; NeedsChown?: boolean };
  }
  // Runs serialized per volume name. Nothing mounts, fills or deletes the volume until an inspect has shown this instance's labels,
  // and only a volume carrying this call's create token is treated as created (and so restorable or removable) by this call.
  private async prepareAiVolume(volume: string, spec: SandboxCreateSpec): Promise<void> {
    const treeKey = `${spec.courseId}/${spec.drillId}/${spec.attemptNumber ?? 1}`; const token = randomUUID();
    const owned = (value: { Labels?: Record<string, string> } | undefined) => value?.Labels?.[sandboxLabel] === '1' && value.Labels?.[instanceLabel] === this.instance && value.Labels?.[drillLabel] === treeKey;
    let existing = await this.inspectVolume(volume);
    if (!existing) {
      const stored = Boolean(this.store) && Boolean(this.store!.prepare("SELECT 1 FROM stored_tree WHERE kind = 'ai-workspace' AND key = ?").get(treeKey));
      // A review never creates an empty volume; it only refills one whose work is stored.
      if (!spec.review || stored) { const created = await this.call('POST', '/volumes/create', { Name: volume, Labels: { [sandboxLabel]: '1', [instanceLabel]: this.instance, [drillLabel]: treeKey, [createTokenLabel]: token } }); if (created.status !== 409 && (created.status < 200 || created.status >= 300)) throw Object.assign(new Error(`Podman volume create failed (${created.status})`), { status: 502 }); }
      // Neither a success nor a conflict proves who made the volume: only what an inspect now shows counts.
      existing = await this.inspectVolume(volume); if (!existing) throw Object.assign(new Error(`Podman GET /volumes/${encodeURIComponent(volume)} failed (404)`), { status: 502 });
    }
    if (!owned(existing)) throw Object.assign(new Error('Workspace volume is not owned by interview-runner'), { status: 409 });
    const createdHere = existing.Labels?.[createTokenLabel] === token;
    if (createdHere && this.store && loadTree(this.store, 'ai-workspace', treeKey)) {
      // The scratch volume was lost but the work is stored: refill it. A failed refill must not leave a half-filled volume that a later start
      // would take for the learner's work, so the volume this call created is removed again, after re-checking it is still that volume.
      try { await this.restoreAiVolume(volume, treeKey); } catch (error) { const current = await this.inspectVolume(volume).catch(() => undefined); if (owned(current) && current?.Labels?.[createTokenLabel] === token) await this.call('DELETE', `/volumes/${encodeURIComponent(volume)}?force=true`); throw error; }
      existing = await this.inspectVolume(volume); if (!owned(existing)) throw Object.assign(new Error('Workspace volume is not owned by interview-runner'), { status: 409 });
    }
    if (spec.review && existing?.NeedsChown) throw Object.assign(new Error('Review volume requires ownership changes and cannot be mounted safely'), { status: 409 });
  }
  // Fills a just-created, empty volume from the stored copy through a short-lived helper container, which also lets Podman settle the volume's ownership.
  private async restoreAiVolume(volume: string, key: string): Promise<void> {
    const entries = loadTree(this.store!, 'ai-workspace', key)!; const name = `ir-${this.instance}-restore-${volume.slice(`ir-${this.instance}-ws-`.length)}`.slice(0, 200);
    const stale = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`); if (stale.status !== 404) { const labels = (JSON.parse(stale.body.toString('utf8')) as { Config?: { Labels?: Record<string, string> } }).Config?.Labels; if (labels?.[helperLabel] !== '1' || labels?.[instanceLabel] !== this.instance) throw Object.assign(new Error('Restore helper name is taken by a container this instance does not own'), { status: 409 }); await this.ok('DELETE', `/containers/${encodeURIComponent(name)}?force=true`); }
    const created = JSON.parse((await this.ok('POST', `/containers/create?name=${encodeURIComponent(name)}`, { Image: this.image, Labels: { [helperLabel]: '1', [instanceLabel]: this.instance }, User: '1000', Entrypoint: ['sleep', '300'], Cmd: [], HostConfig: { Binds: [`${volume}:/restore:rw,U`], NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 256 * 1024 * 1024, PidsLimit: 16 } })).toString('utf8')) as { Id: string };
    try { await this.ok('POST', `/containers/${encodeURIComponent(created.Id)}/start`); await this.ok('PUT', `/containers/${encodeURIComponent(created.Id)}/archive?path=${encodeURIComponent('/restore')}`, buildTar(entries, { uid: 1000, gid: 1000 })); }
    finally { const removed = await this.call('DELETE', `/containers/${encodeURIComponent(created.Id)}?force=true`); if (removed.status !== 204 && removed.status !== 200 && removed.status !== 404) console.error(`Restore helper cleanup failed (${removed.status})`); }
  }
  private async ownedRows(): Promise<Array<Record<string, any>>> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${sandboxLabel}=1`, `${instanceLabel}=${this.instance}`] })); const prefix = sandboxContainerPrefix(this.instance);
    const rows = JSON.parse((await this.ok('GET', `/containers/json?all=true&filters=${filters}`)).toString('utf8')) as Array<Record<string, any>>;
    // The daemon-side filter is not trusted alone: ownership is re-checked on every row.
    return rows.filter((row) => row.Labels?.[sandboxLabel] === '1' && row.Labels?.[instanceLabel] === this.instance && String(row.Names?.[0] ?? '').replace(/^\//, '').startsWith(prefix));
  }
  /** Saves every open workspace and the UI state. Runs periodically and on shutdown; unchanged trees are skipped. */
  async persistAll(): Promise<void> { if (!this.store) return; for (const row of await this.ownedRows()) { this.persistCoding(row.Labels); await this.persistAi(row); } this.persistUiState(); }
  private call(method: string, path: string, body?: unknown, limit = maxPodmanResponse): Promise<PodmanResponse> {
    return new Promise((resolveCall, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      let settled = false;
      const request = httpRequest({ socketPath: this.socketPath, path: `/v1.41${path}`, method, headers: payload ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json', 'Content-Length': payload.length } : {} }, (response) => { const chunks: Buffer[] = []; let size = 0; response.on('data', (raw) => { const chunk = Buffer.from(raw); size += chunk.length; if (size > limit) { response.destroy(); request.destroy(); if (!settled) { settled = true; reject(Object.assign(new Error('Podman response exceeded its byte limit'), { status: 502 })); } return; } chunks.push(chunk); }); response.on('end', () => { if (!settled) { settled = true; resolveCall({ status: response.statusCode ?? 500, body: Buffer.concat(chunks) }); } }); });
      request.once('error', reject); if (payload) request.end(payload); else request.end();
    });
  }
  private async ok(method: string, path: string, body?: unknown): Promise<Buffer> { const response = await this.call(method, path, body); if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Podman ${method} ${path} failed (${response.status}): ${response.body.toString('utf8').slice(0, 1000)}`), { status: 502 }); return response.body; }
  private async cleanupHostGit(id: string, containerId: string): Promise<void> {
    const inspected = JSON.parse((await this.ok('GET', `/containers/${encodeURIComponent(containerId)}/json`)).toString('utf8')) as { Config?: { Labels?: Record<string, string> } };
    const workspace = inspected.Config?.Labels?.[hostWorkspaceLabel]; if (!workspace) return;
    const [courseId, drillId] = (inspected.Config?.Labels?.[drillLabel] ?? '').split('/');
    if (courseId && drillId) { const directory = workspaceGitDirectory(courseId, drillId, join(this.settingsDirectory, '.workspace-git')); try { if ((await readFile(join(directory, 'interview-runner-sandbox'), 'utf8')).trim() === id) await removeWorkspaceGitPointer(workspace, directory, containerGitDirectory); } catch { /* never remove an unowned pointer */ } }
    try { if ((await readFile(join(workspace, '.git/interview-runner-sandbox'), 'utf8')).trim() === id) await rm(join(workspace, '.git'), { recursive: true, force: true }); } catch { /* never remove Git metadata without the exact sandbox marker */ }
  }
  // Removes only runner-marked Git metadata whose sandbox container no longer exists, e.g. after a crash mid-teardown.
  private async clearOrphanedHostGit(workspace: string, directory: string): Promise<void> {
    let owner: string; let pointer = false; try { pointer = (await lstat(join(workspace, '.git'))).isFile() && (await readFile(join(workspace, '.git'), 'utf8')).trim() === `gitdir: ${containerGitDirectory}`; owner = (await readFile(join(pointer ? directory : join(workspace, '.git'), 'interview-runner-sandbox'), 'utf8')).trim(); } catch { return; }
    if (!owner || (await this.call('GET', `/containers/${encodeURIComponent(`${sandboxContainerPrefix(this.instance)}${owner}`)}/json`)).status !== 404) return;
    if (pointer) await removeWorkspaceGitPointer(workspace, directory, containerGitDirectory); else await rm(join(workspace, '.git'), { recursive: true, force: true });
  }
  async list(watch = true): Promise<SandboxRecord[]> {
    const prefix = sandboxContainerPrefix(this.instance); const owned = await this.ownedRows();
    const records = owned.map((row) => { const name = String(row.Names?.[0] ?? '').replace(/^\//, ''); const id = name.slice(prefix.length); const state = String(row.State); const drill = String(row.Labels?.[drillLabel] ?? '').split('/'); const kind = String(row.Labels?.['io.interview-runner.kind']) === 'ai-coding' ? 'ai-coding' : 'coding'; const revision = String(row.Labels?.['io.interview-runner.content-revision'] ?? ''); return { id, courseId: drill[0] ?? '', drillId: drill[1] ?? '', kind, status: state === 'running' ? 'running' : 'stopped', target: `http://${name}:8080`, workspace: String(row.Labels?.['io.interview-runner.workspace'] ?? ''), lastSeen: Number(row.Labels?.['io.interview-runner.last-seen'] ?? Date.now()), containerId: String(row.Id), ...(kind === 'ai-coding' ? { volume: sandboxVolumeName(this.instance, drill[0], drill[1], drill[2] ?? 1), attemptNumber: Number(drill[2] ?? 1) } : {}), ...(row.Labels?.['io.interview-runner.review'] === '1' ? { review: true } : {}), ...(/^[1-9]\d*$/.test(revision) && Number.isSafeInteger(Number(revision)) ? { contentRevision: Number(revision) } : {}) } as SandboxRecord; });
    if (watch) await Promise.all(records.flatMap((record) => { const userData = join(this.settingsDirectory, '.user-data', record.id); const drill = { courseId: record.courseId, drillId: record.drillId }; return [this.settings.watch(record.id, userData).catch(() => {}), this.ui.watch(record.id, userData, drill, record.workspace).catch(() => {})]; }));
    return records;
  }
  async create(spec: SandboxCreateSpec, allowlist: SandboxAllowlist): Promise<SandboxRecord> {
    if (spec.review && (spec.kind !== 'ai-coding' || !Number.isSafeInteger(spec.attemptNumber) || Number(spec.attemptNumber) < 1)) throw Object.assign(new Error('Invalid review workspace'), { status: 400 });
    const mounts = await authorizeMounts(spec, allowlist); const name = `${sandboxContainerPrefix(this.instance)}${spec.id}`; const hostWorkspace = mounts.workspace; const containerWorkspace = spec.kind === 'coding' ? `/workspace/${spec.workspacePath}` : `/workspace/${spec.drillId}-${spec.attemptNumber ?? 1}`; const volume = spec.kind === 'ai-coding' ? sandboxVolumeName(this.instance, spec.courseId, spec.drillId, spec.attemptNumber ?? 1) : undefined;
    const userData = join(this.settingsDirectory, '.user-data', spec.id); const hostUserData = join(this.settingsHostDirectory, '.user-data', spec.id); await this.settings.prepare(userData, spec.kind); const restored = await this.ui.prepare(userData, spec, containerWorkspace);
    const gitDirectory = spec.kind === 'coding' ? workspaceGitDirectory(spec.courseId, spec.drillId, join(this.settingsDirectory, '.workspace-git')) : undefined;
    const hostGitDirectory = spec.kind === 'coding' ? workspaceGitDirectory(spec.courseId, spec.drillId, join(this.settingsHostDirectory, '.workspace-git')) : undefined;
    const persist = Boolean(this.store) && (spec.kind === 'ai-coding' ? !spec.review : spec.repoId === 'managed');
    if (gitDirectory && persist && !existsSync(gitDirectory)) this.saved(`restore Git history ${spec.courseId}/${spec.drillId}`, () => unpackTree(this.store!, 'workspace-git', `${spec.courseId}/${spec.drillId}`, gitDirectory));
    if (gitDirectory) { await this.clearOrphanedHostGit(hostWorkspace, gitDirectory); try { await lstat(join(hostWorkspace, '.git')); throw new Error('Drill workspace already contains Git metadata'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await preparePodmanWorkspaceGit(hostWorkspace, gitDirectory, containerGitDirectory); const marker = join(gitDirectory, `.runner-marker-${randomUUID()}`); try { await writeFile(marker, `${spec.id}\n`, { flag: 'wx' }); await rename(marker, join(gitDirectory, 'interview-runner-sandbox')); } finally { await rm(marker, { force: true }); } }
    if (volume) await this.exclusive(`volume:${volume}`, () => this.prepareAiVolume(volume, spec));
    const binds = spec.kind === 'coding' ? [`${hostWorkspace}:${containerWorkspace}:rw`, `${hostGitDirectory}:${containerGitDirectory}:rw,U`] : [`${mounts.workspace}:/opt/ir/template:ro`, `${volume}:${containerWorkspace}:${spec.review ? 'ro,nocopy' : 'rw,U'}`]; binds.push(`${hostUserData}:/opt/ir/user-data:rw`);
    if (spec.testPath) binds.push(`${mounts.test}:/workspace/${spec.testPath}:ro`);
    if (spec.acceptancePath) binds.push(`${mounts.acceptance}:/opt/ir/acceptance:ro`);
    if (spec.kind === 'coding') {
      const seedRoot = spec.repoId === 'managed' ? join(mounts.root, 'materialized', spec.courseId, String(spec.contentRevision), spec.workspacePath) : hostWorkspace;
      for (const file of await findSeeds(seedRoot)) { const canonical = await canonicalWithoutSymlinks(file, mounts.root); if (!under(await realpath(seedRoot), canonical)) throw Object.assign(new Error('Seed mount source is outside the allowlist'), { status: 403 }); const destination = spec.repoId === 'managed' ? `${spec.workspacePath}/${relative(seedRoot, canonical).replaceAll('\\', '/')}` : relative(mounts.root, canonical).replaceAll('\\', '/'); binds.push(`${canonical}:/workspace/${destination}:ro`); }
    }
    const labels = { [sandboxLabel]: '1', [instanceLabel]: this.instance, [drillLabel]: `${spec.courseId}/${spec.drillId}${spec.attemptNumber ? `/${spec.attemptNumber}` : ''}`, 'io.interview-runner.kind': spec.kind, 'io.interview-runner.workspace': containerWorkspace, 'io.interview-runner.last-seen': String(Date.now()), ...(spec.kind === 'coding' ? { [hostWorkspaceLabel]: hostWorkspace } : {}), ...(persist ? { [persistLabel]: '1' } : {}), ...(spec.review ? { 'io.interview-runner.review': '1' } : {}), ...(spec.contentRevision ? { 'io.interview-runner.content-revision': String(spec.contentRevision) } : {}) };
    const body = { Image: this.image, Labels: labels, User: '1000', WorkingDir: containerWorkspace, Env: [`IR_SANDBOX_ID=${spec.id}`, `IR_WORKSPACE=${containerWorkspace}`, `IR_WORKSPACE_KIND=${spec.kind}`, ...(spec.review ? ['IR_REVIEW=1'] : []), 'IR_USER_DATA_DIR=/opt/ir/user-data', 'IR_UI_STATE_PATH=/opt/ir/user-data/ui-state.json', 'GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory', `GIT_CONFIG_VALUE_0=${containerWorkspace}`, `IR_EDITABLE_PATHS=${JSON.stringify(editableSandboxPaths(spec))}`, ...(restored.layout ? [`IR_SAVED_LAYOUT=${JSON.stringify(restored.layout)}`] : []), ...(restored.editors ? [`IR_SAVED_EDITORS=${JSON.stringify(restored.editors)}`] : [])], HostConfig: { Binds: binds, Init: true, ReadonlyRootfs: true, Memory: 2560 * 1024 * 1024, NanoCpus: 2_000_000_000, PidsLimit: 512, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: sandboxNetworkName(this.instance), Tmpfs: { '/tmp': 'rw,size=536870912,mode=1777', '/home/coder': 'rw,size=536870912,mode=1777' } } };
    const created = JSON.parse((await this.ok('POST', `/containers/create?name=${encodeURIComponent(name)}`, body)).toString('utf8')) as { Id: string };
    try { await this.ok('POST', `/containers/${encodeURIComponent(created.Id)}/start`); await this.settings.watch(spec.id, userData); await this.ui.watch(spec.id, userData, spec, containerWorkspace); } catch (error) { await this.ui.stop(spec.id); await this.settings.stop(spec.id); if (gitDirectory) await removeWorkspaceGitPointer(hostWorkspace, gitDirectory, containerGitDirectory); await this.call('DELETE', `/containers/${encodeURIComponent(created.Id)}?force=true`); await rm(userData, { recursive: true, force: true }); throw error; }
    return { id: spec.id, courseId: spec.courseId, drillId: spec.drillId, kind: spec.kind, status: 'running', target: `http://${name}:8080`, workspace: containerWorkspace, lastSeen: Date.now(), containerId: created.Id, ...(volume ? { volume, attemptNumber: spec.attemptNumber ?? 1 } : {}), ...(spec.review ? { review: true } : {}), ...(spec.acceptancePath ? { acceptance: '/opt/ir/acceptance' } : {}), ...(spec.contentRevision ? { contentRevision: spec.contentRevision } : {}) };
  }
  // Deletes a workspace volume only after inspecting it and finding this instance's labels.
  private deleteOwnedVolume(volume: string, drill: string): Promise<void> { return this.exclusive(`volume:${volume}`, () => this.deleteOwnedVolumeUnlocked(volume, drill)); }
  private async deleteOwnedVolumeUnlocked(volume: string, drill: string): Promise<void> {
    const forget = () => { this.markDeletion(drill); if (this.store) this.saved(`forget AI workspace ${drill}`, () => deleteTree(this.store!, 'ai-workspace', drill)); };
    // In-flight saves of this workspace must not commit once its deletion has begun.
    this.markDeletion(drill);
    const inspected = await this.call('GET', `/volumes/${encodeURIComponent(volume)}`); if (inspected.status === 404) { forget(); return; } if (inspected.status < 200 || inspected.status >= 300) throw new Error(`Podman volume inspect failed (${inspected.status})`);
    const value = JSON.parse(inspected.body.toString('utf8')) as { Labels?: Record<string, string> };
    if (value.Labels?.[sandboxLabel] !== '1' || value.Labels?.[instanceLabel] !== this.instance || value.Labels?.[drillLabel] !== drill) throw new Error('Workspace volume is not owned by this interview-runner instance');
    const deleted = await this.call('DELETE', `/volumes/${encodeURIComponent(volume)}?force=true`); if (deleted.status !== 204 && deleted.status !== 404) throw new Error(`Podman volume delete failed (${deleted.status})`);
    forget();
  }
  async remove(id: string, deleteVolume = false): Promise<void> {
    const record = (await this.list(false)).find((item) => item.id === id); if (record?.review && deleteVolume) throw Object.assign(new Error('Review workspaces cannot delete their volume'), { status: 409 });
    await this.ui.stop(id); await this.settings.stop(id);
    if (record?.containerId) {
      const row = this.store ? (await this.ownedRows()).find((item) => String(item.Id) === record.containerId) : undefined;
      // An AI workspace is archived while its container still runs (Podman does not expose a stopped container's volume), unless the volume is being deleted with it.
      if (row && record.volume && !deleteVolume) await this.persistAi(row);
      else if (record.volume && deleteVolume) this.markDeletion(`${record.courseId}/${record.drillId}/${record.attemptNumber ?? 1}`);
      await this.cleanupHostGit(id, record.containerId); const response = await this.call('DELETE', `/containers/${encodeURIComponent(record.containerId)}?force=true`); if (response.status !== 204 && response.status !== 404) throw new Error(`Podman delete failed (${response.status})`);
      this.persistCoding(row?.Labels); this.persistUiState();
    }
    if (deleteVolume && record?.volume) await this.deleteOwnedVolume(record.volume, `${record.courseId}/${record.drillId}/${record.attemptNumber ?? 1}`);
    await rm(join(this.settingsDirectory, '.user-data', id), { recursive: true, force: true });
  }
  async removeWorkspace(courseId: string, drillId: string, attemptNumber: number): Promise<void> { await this.deleteOwnedVolume(sandboxVolumeName(this.instance, courseId, drillId, attemptNumber), `${courseId}/${drillId}/${attemptNumber}`); }
  async exec(id: string, input: SandboxExecRequest): Promise<{ output: string; exitCode: number }> {
    const record = (await this.list(false)).find((item) => item.id === id); if (!record?.containerId) throw Object.assign(new Error('Unknown sandbox'), { status: 404 });
    if (record.review && ['run', 'capture-run', 'commit-files', 'stage-commit'].includes(input.action)) throw Object.assign(new Error('Review workspaces are read-only'), { status: 409 });
    const command = commandFor(input);
    const created = JSON.parse((await this.ok('POST', `/containers/${encodeURIComponent(record.containerId)}/exec`, { AttachStdout: true, AttachStderr: true, Tty: true, User: '1000', Cmd: command, Env: [`IR_WORKSPACE=${record.workspace}`, 'IR_USER_DATA_DIR=/opt/ir/user-data'], WorkingDir: record.workspace })).toString('utf8')) as { Id: string };
    const output = await this.call('POST', `/exec/${encodeURIComponent(created.Id)}/start`, { Detach: false, Tty: true }, input.action === 'workspace-files' || input.action === 'capture-run' || input.action === 'commit-files' ? maxWorkspaceFilesResponse : maxPodmanResponse).then((response) => { if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Podman exec start failed (${response.status})`), { status: 502 }); return response.body; });
    const inspected = JSON.parse((await this.ok('GET', `/exec/${encodeURIComponent(created.Id)}/json`)).toString('utf8')) as { ExitCode?: number };
    return { output: output.toString('utf8'), exitCode: inspected.ExitCode ?? 1 };
  }
  async health(id: string): Promise<SandboxHealth> {
    const record = (await this.list(false)).find((item) => item.id === id); if (!record) throw Object.assign(new Error('Unknown sandbox'), { status: 404 });
    const extHostCrashes = await extensionHostCrashes(join(this.settingsDirectory, '.user-data', id));
    try { const result = await this.exec(id, { action: 'health' }); return { ...(result.exitCode === 0 ? cgroupHealth(result.output) : cgroupHealth('')), extHostCrashes }; }
    catch (error) { console.warn(`Sandbox health exec failed for ${id}`, error); return { ...cgroupHealth(''), extHostCrashes }; }
  }
}

async function findSeeds(root: string): Promise<string[]> { const output: string[] = []; async function walk(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const next = join(path, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) await walk(next); else if (entry.isFile() && entry.name.includes('.seed.')) output.push(next); } } await walk(root); return output; }
export function commandFor(input: SandboxExecRequest): string[] {
  if (!input || typeof input !== 'object' || !['run', 'capture-run', 'workspace-files', 'commit-files', 'settings', 'stage-commit', 'health'].includes(input.action)) throw Object.assign(new Error('Invalid exec action'), { status: 400 });
  if (input.commitTimestamp !== undefined && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(input.commitTimestamp)) throw Object.assign(new Error('Invalid commit timestamp'), { status: 400 });
  if (input.action === 'health') { if (Object.keys(input).length !== 1) throw Object.assign(new Error('Invalid health arguments'), { status: 400 }); return ['cat', '/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory.max']; }
  if (input.action === 'run') { if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string' || arg.length > 200 || /[\0\r\n]/.test(arg))) throw Object.assign(new Error('Invalid run arguments'), { status: 400 }); return ['timeout', '60', 'node', '/opt/ir/tools/run-tests.mjs', ...input.args]; }
  if (input.action === 'capture-run') { if (!Array.isArray(input.runs) || !input.runs.length || input.runs.length > 2 || input.runs.some((args) => !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 200 || /[\0\r\n]/.test(arg)))) throw Object.assign(new Error('Invalid captured run arguments'), { status: 400 }); return ['timeout', '120', 'node', '/opt/ir/tools/capture-run.mjs', JSON.stringify(input.runs), input.commitTimestamp ?? '']; }
  if (input.action === 'workspace-files') return ['timeout', '30', 'node', '/opt/ir/tools/workspace-files.mjs'];
  if (input.action === 'commit-files') return ['timeout', '30', 'node', '/opt/ir/tools/workspace-git.mjs', 'commit-files', input.commitTimestamp ?? ''];
  if (input.action === 'settings') { if (typeof input.enabled !== 'boolean') throw Object.assign(new Error('enabled must be boolean'), { status: 400 }); return ['node', '/opt/ir/tools/settings.mjs', String(input.enabled)]; }
  if (!Number.isSafeInteger(input.stage) || Number(input.stage) < 1) throw Object.assign(new Error('stage must be a positive integer'), { status: 400 });
  return ['timeout', '30', 'node', '/opt/ir/tools/workspace-git.mjs', 'commit', input.commitTimestamp ?? ''];
}

export function createSandboxd(options: { token: string; allowlist: SandboxAllowlist; driver: Pick<PodmanDriver, 'list' | 'create' | 'remove' | 'removeWorkspace' | 'exec' | 'health'> }) {
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error('SANDBOXD_TOKEN must be 64 lowercase hex characters');
  return createServer(async (request, response) => {
    try {
      if (!tokenAllowed(request.headers.authorization, options.token)) return json(response, 401, { error: 'Unauthorized' });
      const url = new URL(request.url ?? '/', 'http://sandboxd'); const match = /^\/sandboxes\/([a-z0-9][a-z0-9-]{7,63})(?:\/(exec|health))?$/.exec(url.pathname);
      if (request.method === 'GET' && url.pathname === '/sandboxes') return json(response, 200, { sandboxes: await options.driver.list() });
       if (request.method === 'POST' && url.pathname === '/sandboxes') { const spec = await validateSandboxSpec(await requestBody(request), options.allowlist); return json(response, 201, await options.driver.create(spec, options.allowlist)); }
      const volumeMatch = /^\/workspace-volumes\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\d+)$/.exec(url.pathname); if (request.method === 'DELETE' && volumeMatch) { await options.driver.removeWorkspace(volumeMatch[1], volumeMatch[2], Number(volumeMatch[3])); return json(response, 200, { deleted: true }); }
      if (match && request.method === 'DELETE' && !match[2]) { await options.driver.remove(match[1], url.searchParams.get('volume') === '1'); return json(response, 200, { deleted: true }); }
      if (match && request.method === 'POST' && match[2] === 'exec') return json(response, 200, await options.driver.exec(match[1], await requestBody(request) as SandboxExecRequest));
      if (match && request.method === 'GET' && match[2] === 'health') return json(response, 200, await options.driver.health(match[1]));
      return json(response, 404, { error: 'Not found' });
    } catch (error) { return json(response, Number((error as { status?: number }).status ?? 500), { error: error instanceof Error ? error.message : 'Sandbox operation failed' }); }
  });
}
