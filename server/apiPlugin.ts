import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, relative, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Plugin, ViteDevServer } from 'vite';
import sirv from 'sirv';
import { drillInCourse, loadCourse, loadCourseHints, loadCourseHintsAtRevision, loadCourses, loadCheatsheet, normalizeTags, onCourseCatalogInvalidated, type Course, type Drill } from './courses';
import { addGitSubmission, browserFacingAiResult, clearRecallChecks, completeDrillAttempt, createLibraryCategory, deleteLibraryCategory, deleteSubmission, getAllTestFiles, getAttemptStages, getCourseDrillAttempts, getDrillAttempts, getProgress, getRevealedHints, getSubmissions, getOutlineState, getBookStatuses, getChapterRanks, getCourseTagOverride, getCourseTagOverrides, getLibraryCategories, getLibraryItems, moveLibraryCategory, moveLibraryItem, openAttemptContentRevisions, pauseDrillAttempt, pinOpenAttemptContentRevision, recordAttemptStage, renameLibraryCategory, renameSubmission, resetProgress, revealHint, setBookStatus, setChapterRank, setCourseTagOverride, setLibraryItemStatus, setLibraryItemTitle, setOutlineNode, setOutlineNodesBulk, setProgress, staleAttemptWorkspaces, startDrillAttempt, syncLibraryItems, upsertTestFile, validateWorkspaceFiles, type LibraryKind, type LibraryStatus, type SubmissionResult, type WorkspaceFiles } from './db';
import { courseRepos, packageRoot, pathInRepo, repoForCourse, requireRepoForCourse } from './courseRepos';
import type { ProgressStatus } from './db';
import { loadOutline, nodeInOutline } from './outlines';
import { readMapRecall, type RecallLesson } from './mapRecall';
import { availableCheatsheets, readCheatsheetAsset, readCheatsheetDocument } from './cheatsheets';
import type { OutlineNode } from './outlines';
import { effectiveCourseTags, fetchAuthoritativeCourse, fetchAuthoritativeCourseMap, fetchAuthoritativeCourseTags, isStateRoute, proxyStateRequest } from './stateProxy';
import { isWhiteboardDrill, parseDeadline } from '../shared/courseSchema';
import { getCourseScheduleOverrides, setCourseScheduleOverride, type CourseScheduleOverride } from './db';
import { consoleFramePrefix } from './consoleReporter';
import { stripAnsi } from '../src/stripAnsi';
import { COURSE_TEST_TIMEOUT_MS, courseTestTimeoutError, runPytest } from './pythonRunner';
import { SandboxManager } from './sandboxClient';
import { attachSandboxProxy } from './sandboxProxy';
import type { SandboxExecRequest } from './sandboxTypes';
import { getMapFoldState, setMapFoldState } from './db';
import { addMapHighlight, getMapHighlights, removeMapHighlight } from './db';
import { MAP_HIGHLIGHT_ID, validMapHighlight } from '../shared/mapHighlights';
import { addCheatsheetCoverage, coverageBatch, getCheatsheetCoverage, resetCheatsheetCoverage } from './cheatsheetCoverage';
import { CHEATSHEET_COVERAGE_ENABLED } from '../shared/cheatsheetCoverage';
import { MAP_FOLD_KEY, MAP_FOLD_MAX_NODES, MAP_FOLD_WRITER } from '../shared/mapFoldState';
import { contentDatabase, contentReader, contentSource, courseAtRevision, fileImageRepository, readCourseFileAtRevision } from './content/reader';
import { codingWorkspace, currentContentRevision, gcMaterialized, managedStateRoot, materializeCourse, materializedRoot, prepareCodingWorkspace, retryMissingRevision, setCodingWorkspaceRestorer } from './content/materialize';
import { createContentApi } from './content/api';
import { stateDb } from './db';
import { defaultWorkspace } from './owner';
import { unpackTree } from './userData';
import { getRecallWhiteboard, getDrillWhiteboard, setDrillWhiteboard, type WhiteboardSnapshot } from './db';

// A missing coding workspace directory is restored from the user database before it would be re-seeded from the template.
setCodingWorkspaceRestorer((courseId, drillId, directory) => unpackTree(stateDb(), 'workspace', `${courseId}/${drillId}`, directory));
function collectNodeIds(nodes: OutlineNode[]): string[] { return nodes.flatMap((node) => [node.id, ...(node.children ? collectNodeIds(node.children) : [])]); }
function visibleState(outline: { nodes: OutlineNode[] }, state: Record<string, { folded?: boolean; checked?: boolean }>): Record<string, { folded?: boolean; checked?: boolean }> { const ids = new Set(collectNodeIds(outline.nodes)); return Object.fromEntries(Object.entries(state).filter(([id]) => ids.has(id))); }

async function body(request: import('node:http').IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 }); chunks.push(chunk); } try { const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : {}; } catch (error) { if ((error as { status?: number }).status) throw error; throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); } }
function send(response: import('node:http').ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); }
function contentNotModified(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, sha256: string): boolean {
  const etag = `"${sha256}"`; response.setHeader('ETag', etag);
  const header = request.headers?.['if-none-match'];
  return typeof header === 'string' && header.split(',').some((value) => { const tag = value.trim(); return tag === '*' || tag.replace(/^W\//, '') === etag; });
}
function whiteboardInput(value: unknown): WhiteboardSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'scene,svg,updatedAt') return;
  const { scene, svg, updatedAt } = value as Record<string, unknown>;
  if (!scene || typeof scene !== 'object' || Array.isArray(scene) || Object.keys(scene).sort().join(',') !== 'appState,elements,files') return;
  const data = scene as Record<string, unknown>;
  if (!Array.isArray(data.elements) || data.elements.length > 10000 || data.elements.some((element) => !element || typeof element !== 'object' || Array.isArray(element)) || !data.appState || typeof data.appState !== 'object' || Array.isArray(data.appState) || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) return;
  if (typeof svg !== 'string' || Buffer.byteLength(svg) > 4 * 1024 * 1024 || (svg !== '' && !/^<svg[\s>]/.test(svg))) return;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 1 || updatedAt > Date.now() + 300000) return;
  return value as WhiteboardSnapshot;
}
async function whiteboards(courseId: string, drillId: string): Promise<{ questions: Array<{ id: string; prompt: string }>; snapshot: WhiteboardSnapshot | null } | null> {
  const course = await loadCourse(courseId); const drill = course && drillInCourse(course, drillId);
  if (!course || !drill || !isWhiteboardDrill(drill)) return null;
  const lesson = await readMapRecall(course, drill) as RecallLesson;
  return { questions: lesson.questions.map(({ id, prompt }) => ({ id, prompt })), snapshot: getDrillWhiteboard(course.id, drill.id) };
}
function stageCount(instructions: string): number { return [...instructions.matchAll(/^## Milestone(?:\s|$)/gm)].length; }
export function unlockedInstructions(instructions: string, stage: number): string {
  const starts = [...instructions.matchAll(/^## Milestone(?:\s|$)/gm)].map((match) => match.index!);
  if (!starts.length || stage >= starts.length) return instructions;
  return instructions.slice(0, starts[Math.max(0, stage)]).trimEnd();
}
export function workspaceMarkdown(workspaceFiles: WorkspaceFiles): string {
  const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock']); let output = '';
  for (const file of workspaceFiles.files) {
    if (file.binary || lockfiles.has(file.path.split('/').at(-1)!)) continue;
    const fence = '`'.repeat(Math.max(3, Math.max(0, ...[...file.content!.matchAll(/`+/g)].map((match) => match[0].length)) + 1));
    const next = `## ${file.path}\n\n${fence}\n${file.content}${file.content!.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    if (Buffer.byteLength(output + next) > 256 * 1024) break;
    output += next;
  }
  return output;
}
function passedResult(result: SubmissionResult, requireTest = true): boolean {
  return result.status === 'passed' && (!requireTest || result.tests.length > 0) && result.tests.every((test) => test.status === 'passed');
}
function submissionResult(value: unknown): SubmissionResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (!['diagnostics,status,tests', 'diagnostics,output,status,tests'].includes(Object.keys(result).sort().join(',')) || !['passed', 'tests-failed', 'type-errors', 'incomplete', 'error'].includes(String(result.status)) || !Array.isArray(result.tests) || !Array.isArray(result.diagnostics) || result.tests.length > 500 || result.diagnostics.length > 500) return undefined;
  const tests = result.tests.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const test = item as Record<string, unknown>; const keys = Object.keys(test).sort().join(',');
    if ((keys !== 'name,status' && keys !== 'message,name,status') || typeof test.name !== 'string' || test.name.length > 2_000 || !['passed', 'failed', 'skipped', 'pending', 'todo'].includes(String(test.status)) || (test.message !== undefined && (typeof test.message !== 'string' || test.message.length > 20_000))) return undefined;
    return { name: test.name, status: String(test.status), ...(test.message === undefined ? {} : { message: test.message as string }) };
  });
  const diagnostics = result.diagnostics.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const diagnostic = item as Record<string, unknown>; const keys = Object.keys(diagnostic).sort();
    if (keys.some((key) => !['col', 'file', 'line', 'message'].includes(key)) || !keys.includes('message') || typeof diagnostic.message !== 'string' || diagnostic.message.length > 20_000 || (diagnostic.file !== undefined && (typeof diagnostic.file !== 'string' || diagnostic.file.length > 2_000)) || (diagnostic.line !== undefined && (!Number.isInteger(diagnostic.line) || Number(diagnostic.line) < 1)) || (diagnostic.col !== undefined && (!Number.isInteger(diagnostic.col) || Number(diagnostic.col) < 1))) return undefined;
    return { ...(diagnostic.file === undefined ? {} : { file: diagnostic.file as string }), ...(diagnostic.line === undefined ? {} : { line: diagnostic.line as number }), ...(diagnostic.col === undefined ? {} : { col: diagnostic.col as number }), message: diagnostic.message };
  });
  if (tests.some((item) => !item) || diagnostics.some((item) => !item)) return undefined;
  let output: ConsoleOutput | undefined;
  if (result.output !== undefined) {
    if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) return undefined;
    const raw = result.output as Record<string, unknown>;
    if (!['entries', 'entries,truncated'].includes(Object.keys(raw).sort().join(',')) || !Array.isArray(raw.entries) || raw.entries.length > 256 || (raw.truncated !== undefined && typeof raw.truncated !== 'boolean')) return undefined;
    const entries = raw.entries as Array<Record<string, unknown>>;
    if (entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || !['stream,text', 'stream,testName,text'].includes(Object.keys(entry).sort().join(',')) || (entry.stream !== 'stdout' && entry.stream !== 'stderr') || typeof entry.text !== 'string' || (entry.testName !== undefined && (typeof entry.testName !== 'string' || !entry.testName || entry.testName.length > 2000)))) return undefined;
    if (entries.reduce((size, entry) => size + Buffer.byteLength(entry.text as string), 0) > 64 * 1024) return undefined;
    output = { entries: entries as ConsoleEntry[], ...(raw.truncated === true ? { truncated: true } : {}) };
  }
  return { status: result.status as SubmissionResult['status'], tests: tests as SubmissionResult['tests'], diagnostics: diagnostics as SubmissionResult['diagnostics'], ...(output ? { output } : {}) };
}
function submissionName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('name must be a string or null');
  const normalized = value.normalize('NFC').trim();
  if (!normalized) return null;
  if (normalized.length > 60) throw new Error('name must be at most 60 characters');
  if (/\p{Cc}/u.test(normalized)) throw new Error('name must not contain control characters');
  return normalized;
}
export function parseWorkspaceFilesOutput(output: string, pathPrefix = ''): WorkspaceFiles {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith('IR_RESULT '));
  if (lines.length !== 1) throw new Error('Sandbox workspace files did not produce exactly one result');
  let parsed: unknown; try { parsed = JSON.parse(lines[0].slice('IR_RESULT '.length)); } catch { throw new Error('Sandbox workspace files result was invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Sandbox workspace files result was invalid');
  const value = parsed as { files?: unknown; totalBytes?: unknown };
  if (!Array.isArray(value.files)) throw new Error('Sandbox workspace files were invalid');
  const prefix = pathPrefix.replace(/\/$/, '');
  return validateWorkspaceFiles({ files: value.files.map((raw) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Sandbox workspace file was invalid'); const file = raw as Record<string, unknown>; return { ...file, path: prefix ? `${prefix}/${String(file.path ?? '')}` : String(file.path ?? '') } as any; }), totalBytes: value.totalBytes as number });
}
function workspaceCommitSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new Error('Invalid workspace commit');
  return value;
}
function parseCommitOutput(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith('IR_RESULT '));
  if (lines.length !== 1) throw new Error('Sandbox commit did not produce exactly one result');
  const value = JSON.parse(lines[0].slice('IR_RESULT '.length)) as { commitSha?: unknown };
  return workspaceCommitSha(value?.commitSha);
}
export function parseCapturedRunOutput(output: string, pathPrefix = '', sandboxRoots: string[] = []): { commitSha: string; workspaceFiles: WorkspaceFiles; results: SubmissionResult[] } {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith('IR_RESULT '));
  if (lines.length !== 1) throw new Error('Captured sandbox run did not produce exactly one result');
  let parsed: unknown; try { parsed = JSON.parse(lines[0].slice('IR_RESULT '.length)); } catch { throw new Error('Captured sandbox run returned invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Captured sandbox run returned an invalid result');
  const value = parsed as { commitSha?: unknown; workspaceFiles?: unknown; results?: unknown };
  const commitSha = workspaceCommitSha(value.commitSha);
  if (!Array.isArray(value.results) || !value.results.length || value.results.length > 2) throw new Error('Captured sandbox run returned invalid test results');
  const results = value.results.map(submissionResult); if (results.some((result) => !result)) throw new Error('Captured sandbox run returned an invalid test result');
  const envelope = value.workspaceFiles as { files?: unknown; totalBytes?: unknown } | undefined;
  if (!envelope || !Array.isArray(envelope.files)) throw new Error('Captured sandbox run returned invalid workspace files');
  const prefix = pathPrefix.replace(/\/$/, '');
  const workspaceFiles = validateWorkspaceFiles({ files: envelope.files.map((raw) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Captured sandbox workspace file was invalid'); const file = raw as Record<string, unknown>; return { ...file, path: prefix ? `${prefix}/${String(file.path ?? '')}` : String(file.path ?? '') } as any; }), totalBytes: envelope.totalBytes as number });
  return { commitSha, workspaceFiles, results: (results as SubmissionResult[]).map((result) => normaliseSandboxResult(result, sandboxRoots)) };
}
function libraryName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} must be 1–100 characters and contain no control characters`);
  return normalized;
}

type ReportTest = { fullName?: unknown; title?: unknown; status?: unknown; failureMessages?: unknown };
type ReportEntry = { name?: unknown; status?: unknown; assertionResults?: unknown; endTime?: unknown; startTime?: unknown };
type Report = { startTime?: unknown; testResults?: unknown };
type TestCounts = { total: number; passed: number; failed: number; skipped: number; pending: number };
type ConsoleEntry = { stream: 'stdout' | 'stderr'; text: string; testName?: string };
type ConsoleOutput = { entries: ConsoleEntry[]; truncated?: boolean };
type TestResult = { status: string; tests: Array<{ name: string; status: string; message?: string }>; counts?: TestCounts; output?: ConsoleOutput; updatedAt: string; stale?: boolean; staleReason?: 'drill-changed' };
type ResultUpdate = { courseId: string; chapterId: string; drillId: string; testPath: string; result: TestResult };
type RunnerErrorUpdate = { courseId: string; chapterId: string; drillId: string; testPath: string; error: 'runner-error'; stale: true };
type ResultSubscriber = { write: (chunk: string) => boolean; end?: () => void; destroy?: () => void; on?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void; destroyed?: boolean };
type SubscriberState = { queue: string[]; blocked: boolean; initializing: boolean; pendingUpdates: ResultUpdate[]; heartbeat?: ReturnType<typeof setInterval>; drainListener?: () => void; lifecycleListener?: () => void; closed: boolean };
const maxQueuedEvents = 64;

const resultStatuses = new Set(['passed', 'failed', 'skipped', 'pending']);
function normaliseStatus(value: unknown): string {
  if (value === 'todo') return 'pending';
  if (typeof value !== 'string' || !resultStatuses.has(value)) throw new Error('Invalid Vitest result status');
  return value;
}
function resultFor(entry: ReportEntry, updatedAt: string): TestResult {
  if (!Array.isArray(entry.assertionResults)) throw new Error('Invalid Vitest assertion results');
  const tests = entry.assertionResults.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid Vitest assertion');
    const test = raw as ReportTest;
    const name = typeof test.fullName === 'string' ? test.fullName : typeof test.title === 'string' ? test.title : 'Unnamed test';
    const messages = Array.isArray(test.failureMessages) ? test.failureMessages : [];
    if (messages.some((message) => typeof message !== 'string')) throw new Error('Invalid Vitest failure message');
    return { name, status: normaliseStatus(test.status), ...(messages[0] ? { message: sanitiseMessage(messages[0] as string) } : {}) };
  });
  const entryStatus = entry.status === undefined ? undefined : normaliseStatus(entry.status);
  const counts = { total: tests.length, passed: tests.filter((test) => test.status === 'passed').length, failed: tests.filter((test) => test.status === 'failed').length, skipped: tests.filter((test) => test.status === 'skipped').length, pending: tests.filter((test) => test.status === 'pending').length };
  const status = entryStatus === 'failed' || counts.failed > 0 ? 'failed'
    : counts.total === 0 || entryStatus === 'skipped' || entryStatus === 'pending' || counts.passed !== counts.total ? 'incomplete'
    : 'passed';
  return { status, tests, counts, updatedAt };
}
function reportTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return undefined;
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch { return undefined; }
}
function sanitiseMessage(value: string): string {
  return courseRepos.reduce((text, repo) => text.split(repo.root).join(''), value)
    .split(packageRoot).join('')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`]+/g, (path) => basename(path.replaceAll('\\', '/')));
}

export function parseIrResult(output: string, sandboxRoots: string[] = []): SubmissionResult {
  if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw Object.assign(new Error('Sandbox output exceeded 4 MiB'), { status: 413 });
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith('IR_RESULT '));
  if (lines.length !== 1) throw new Error('Sandbox returned an invalid result envelope');
  let raw: unknown; try { raw = JSON.parse(lines[0].slice('IR_RESULT '.length)); } catch { throw new Error('Sandbox returned invalid result JSON'); }
  const result = submissionResult(raw); if (!result) throw new Error('Sandbox returned an invalid test result'); return normaliseSandboxResult(result, sandboxRoots);
}
function normaliseSandboxResult(result: SubmissionResult, sandboxRoots: string[]): SubmissionResult {
  const clean = (message: string) => sandboxRoots.reduce((text, root) => text.split(root).join(''), sanitiseMessage(message));
  if (result.status === 'type-errors') return { ...result, diagnostics: result.diagnostics.map((item) => ({ ...item, message: clean(item.message) })), tests: [] };
  const normalised = resultFor({ status: result.status === 'tests-failed' ? 'failed' : result.status === 'passed' ? 'passed' : 'pending', assertionResults: result.tests.map((test) => ({ fullName: test.name, status: test.status, failureMessages: test.message ? [clean(test.message)] : [] })) }, new Date().toISOString());
  return { status: result.status === 'error' ? 'error' : normalised.status === 'failed' ? 'tests-failed' : normalised.status === 'passed' ? 'passed' : 'incomplete', diagnostics: result.diagnostics.map((item) => ({ ...item, message: clean(item.message) })), tests: normalised.tests, ...(result.output ? { output: { ...result.output, entries: result.output.entries.map((entry) => ({ ...entry, text: clean(entry.text), ...(entry.testName ? { testName: clean(entry.testName) } : {}) })) } } : {}) };
}
function safeReportPath(value: string): string | undefined {
  for (const root of [packageRoot, ...courseRepos.map((repo) => repo.root), ...(contentSource() === 'db' ? [managedStateRoot()] : [])]) {
    const filePath = resolve(root, value);
    if (!relative(root, filePath).startsWith('..')) return filePath;
  }
  return undefined;
}

async function persistReport(reportPath: string, notify: boolean, subscribers: Set<ResultSubscriber>, sendUpdate: (subscriber: ResultSubscriber, update: ResultUpdate) => void): Promise<boolean> {
  let report: Report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')) as Report; } catch { return false; }
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) return false;
  const fallbackTime = reportTimestamp(report.startTime) ?? new Date().toISOString();
  const prepared: Array<{ entry: ReportEntry; filePath: string; result: TestResult }> = [];
  try { for (const raw of report.testResults) { if (!raw || typeof raw !== 'object' || typeof (raw as ReportEntry).name !== 'string') throw new Error('entry'); const entry = raw as ReportEntry; const filePath = safeReportPath(entry.name as string); if (!filePath) throw new Error('path'); const updatedAt = reportTimestamp(entry.endTime) ?? reportTimestamp(entry.startTime) ?? fallbackTime; prepared.push({ entry, filePath, result: resultFor(entry, updatedAt) }); } } catch { return false; }
  const courses = await loadCourses();
  for (const { entry, filePath, result } of prepared) {
    let resultPath = filePath;
    if (contentSource() === 'db') for (const course of courses) for (const chapter of course.chapters) for (const drill of chapter.drills) {
      if (!drill.testPath) continue;
      const prefix = `drills/${course.id}/${drill.id}/`;
      if (drill.testPath.startsWith(prefix) && join(codingWorkspace(course.id, drill.id), drill.testPath.slice(prefix.length)) === filePath) resultPath = await resultKey(course.id, drill);
    }
    if (!upsertTestFile(resultPath, result.status, result.tests, result.updatedAt)) continue;
    if (!notify) continue;
    for (const course of courses) for (const chapter of course.chapters) for (const drill of chapter.drills) {
      if (!drill.testPath || await resultKey(course.id, drill) !== resultPath) continue;
      const update: ResultUpdate = { courseId: course.id, chapterId: chapter.id, drillId: drill.id, testPath: drill.testPath, result: await freshResult(course.id, drill, result) };
      for (const subscriber of subscribers) {
        try { sendUpdate(subscriber, update); } catch { subscribers.delete(subscriber); }
      }
    }
  }
  return true;
}

async function resultKey(courseId: string, drill: Drill, materialize = true): Promise<string> {
  const path = drill.testPath ?? (drill.contentType === 'ai-coding' ? drill.workspacePath : undefined);
  if (!path) throw new Error('Drill has no result path');
  if (contentSource() !== 'db') return pathInRepo(requireRepoForCourse(courseId), path);
  const database = await contentDatabase(); const attempt = drill.contentType === 'ai-coding' ? getDrillAttempts(courseId, drill.id).at(-1) : undefined;
  const revision = attempt?.contentRevision ?? currentContentRevision(database, courseId);
  if (!materialize && !database.prepare('SELECT 1 FROM course_revision WHERE course_id=? AND revision=?').get(courseId, revision)) throw new Error(`Unknown content revision: ${courseId}/${revision}`);
  return join(materialize ? await materializeCourse(database, courseId, revision, undefined, path) : materializedRoot(courseId, revision), path);
}

let lastSnapshot: { token: string; value: ReturnType<typeof snapshot> } | undefined;
function snapshot(aiCodingPaths: ReadonlySet<string> = new Set()): { available: boolean; reason?: 'no-runs-recorded'; files?: Record<string, ReturnType<typeof resultFor>> } {
  const database = stateDb();
  const changes = database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
  const version = database.prepare('PRAGMA data_version').get() as { data_version: number };
  const token = JSON.stringify([changes.changes, version.data_version, [...aiCodingPaths].sort()]);
  if (lastSnapshot?.token === token) return lastSnapshot.value;
  const files = getAllTestFiles(aiCodingPaths);
  const value = Object.keys(files).length ? { available: true, files } : { available: false, reason: 'no-runs-recorded' as const };
  lastSnapshot = { token, value }; return value;
}

async function manifestSnapshot(): Promise<ReturnType<typeof snapshot>> {
  const courses = await loadCourses();
  const aiCodingPaths = new Set(await Promise.all(courses.flatMap((course) => course.chapters.flatMap((chapter) => chapter.drills.filter((drill) => drill.contentType === 'ai-coding').map((drill) => resultKey(course.id, drill, false))))));
  const current = snapshot(aiCodingPaths);
  if (!current.files) return current;
  const files: Record<string, ReturnType<typeof resultFor>> = {};
  for (const course of courses) for (const chapter of course.chapters) for (const drill of chapter.drills) {
    const key = drill.testPath ?? (drill.contentType === 'ai-coding' ? drill.workspacePath : undefined);
    if (!key) continue;
    const currentKey = await resultKey(course.id, drill, false); let result = current.files[currentKey]; let previousRevision = false;
    if (!result && contentSource() === 'db' && drill.contentType === 'coding') {
      const base = join(managedStateRoot(), 'materialized', course.id);
      const previous = Object.entries(current.files).filter(([candidate]) => { const rel = relative(base, candidate).replaceAll('\\', '/'); return /^[1-9]\d*\//.test(rel) && rel.slice(rel.indexOf('/') + 1) === key; }).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
      if (previous) { result = previous[1]; previousRevision = true; }
    }
    if (result) { const fresh = drill.contentType === 'ai-coding' ? result : await freshResult(course.id, drill, result); files[key] = previousRevision ? { ...fresh, stale: true, staleReason: 'drill-changed' } : fresh; }
  }
  return Object.keys(files).length ? { available: true, files } : { available: false, reason: 'no-runs-recorded' };
}

async function freshResult(courseId: string, drill: Drill, result: TestResult): Promise<TestResult> {
  if (!drill.testPath) return result;
  try {
    const prefix = `drills/${courseId}/${drill.id}/`;
    const repo = contentSource() === 'db' ? undefined : requireRepoForCourse(courseId);
    if (!repo && !drill.sourcePath.startsWith(prefix)) throw new Error('Drill source is outside the workspace');
    const [source, test] = await Promise.all([
      stat(repo ? pathInRepo(repo, drill.sourcePath) : join(codingWorkspace(courseId, drill.id), drill.sourcePath.slice(prefix.length))),
      repo ? stat(pathInRepo(repo, drill.testPath)) : retryMissingRevision(async () => stat(await resultKey(courseId, drill))),
    ]);
    return new Date(result.updatedAt).getTime() < Math.max(source.mtimeMs, test.mtimeMs)
      ? { ...result, stale: true, staleReason: 'drill-changed' }
      : result;
  } catch {
    return { ...result, stale: true, staleReason: 'drill-changed' };
  }
}

async function recallSummaries(course: Course): Promise<Record<string, { checked: number; total: number; hasStoredChecks: boolean }>> {
  const drills = course.chapters.flatMap((chapter) => chapter.drills).filter((drill) => drill.contentType === 'recall' || drill.contentType === 'whiteboard');
  const progress = getProgress(course.id);
  return Object.fromEntries(await Promise.all(drills.map(async (drill) => {
    if (isWhiteboardDrill(drill)) return [drill.id, { checked: progress[drill.id]?.status === 'done' ? 1 : 0, total: 1, hasStoredChecks: false }] as const;
    const lesson = await readMapRecall(course, drill) as RecallLesson;
    const state = getOutlineState(course.id, drill.id);
    return [drill.id, { checked: lesson.questions.filter((q) => state[q.id]?.checked).length, total: lesson.questions.length, hasStoredChecks: Object.values(state).some((item) => item.checked) }] as const;
  })));
}
function effectiveSchedule(course: Course, schedule?: CourseScheduleOverride) {
  return { deadline: schedule?.deadline === null ? undefined : schedule?.deadline ?? course.deadline, tier: course.company ? schedule?.tier === null ? undefined : schedule?.tier ?? course.tier : undefined };
}
async function libraryCatalog(workspace = defaultWorkspace) {
  const [courses, cheatsheets] = await Promise.all([loadCourses(), availableCheatsheets()]);
  const workspaceMode = contentSource() === 'db';
  const owners = new Map(await Promise.all(courses.map(async (course) => [course.id, (await contentReader().courseOwner(course.id)).id] as const)));
  const selectedCourses = workspaceMode ? courses.filter((course) => owners.get(course.id) === workspace) : courses;
  const selectedSheets = workspaceMode ? cheatsheets.filter((sheet) => sheet.repo === workspace) : cheatsheets;
  const identities = [...selectedCourses.map((course) => ({ kind: 'course' as const, id: course.id })), ...selectedSheets.map((sheet) => ({ kind: 'cheatsheet' as const, id: sheet.id }))];
  syncLibraryItems(identities, workspace);
  const states = getLibraryItems(workspace);
  const courseTags = getCourseTagOverrides();
  const schedules = getCourseScheduleOverrides();
  const items = [
    ...await Promise.all(selectedCourses.map(async (course) => {
      const owner = owners.get(course.id)!;
      const state = states.find((item) => item.kind === 'course' && item.id === course.id)!;
      const schedule = schedules[course.id];
      const metadata = { company: course.company, manifestDeadline: course.deadline, manifestTier: course.tier, deadlineOverride: schedule?.deadline, tierOverride: schedule?.tier, ...effectiveSchedule(course, schedule) };
        const drills = course.chapters.flatMap((chapter) => chapter.drills); const progress = getProgress(course.id);
        if (course.type === 'map-recall') {
           const recall = drills.filter((drill) => drill.contentType === 'recall' || drill.contentType === 'whiteboard');
            const whiteboardLessonCount = recall.filter(isWhiteboardDrill).length;
           const mapLessonCount = drills.filter((drill) => drill.contentType === 'map').length;
          try {
            const results = Object.values(await recallSummaries(course));
            const checked = results.reduce((sum, item) => sum + item.checked, 0); const total = results.reduce((sum, item) => sum + item.total, 0);
             return { ...state, ...metadata, repo: owner, status: !state.statusExplicit && total > 0 && checked === total ? 'done' : state.status, manifestTitle: course.title, title: state.titleOverride ?? course.title, tags: courseTags[course.id] ?? course.tags ?? [], type: course.type, mapLessonCount, recallLessonCount: recall.length, whiteboardLessonCount, doneDrills: checked, totalDrills: total, remainingMinutes: 0, inProgress: checked > 0 && checked < total };
          } catch {
             return { ...state, ...metadata, repo: owner, manifestTitle: course.title, title: state.titleOverride ?? course.title, tags: courseTags[course.id] ?? course.tags ?? [], type: course.type, mapLessonCount, recallLessonCount: recall.length, whiteboardLessonCount, recallUnavailable: true, doneDrills: 0, totalDrills: 0, remainingMinutes: 0, inProgress: false };
          }
        }
       const done = drills.filter((drill) => progress[drill.id]?.status === 'done').length;
       const inProgress = drills.some((drill) => progress[drill.id]?.status === 'in-progress');
       const blocked = drills.filter((drill) => progress[drill.id]?.status === 'blocked').length;
       const effectiveStatus = !state.statusExplicit && drills.length > 0 && done === drills.length ? 'done' : state.status;
         return { ...state, ...metadata, repo: owner, status: effectiveStatus, manifestTitle: course.title, title: state.titleOverride ?? course.title, role: course.role, tags: courseTags[course.id] ?? course.tags ?? [], doneDrills: done, blockedDrills: blocked, totalDrills: drills.length, remainingMinutes: drills.filter((drill) => progress[drill.id]?.status !== 'done').reduce((sum, drill) => sum + drill.estMinutes, 0), inProgress };
    })),
    ...selectedSheets.map((sheet) => { const state = states.find((item) => item.kind === 'cheatsheet' && item.id === sheet.id)!; return { ...state, repo: sheet.repo, manifestTitle: sheet.title, title: state.titleOverride ?? sheet.title, tags: [], doneDrills: 0, totalDrills: 0, remainingMinutes: 0, inProgress: false }; }),
  ];
  const registered = workspaceMode ? (await contentDatabase()).prepare("SELECT value FROM content_meta WHERE key LIKE 'workspace:%'").all() as Array<{ value: string }> : [];
  return { categories: getLibraryCategories(workspace), items, courseRepos: workspaceMode ? [...new Set([defaultWorkspace, ...registered.map((row) => row.value), ...owners.values(), ...cheatsheets.map((sheet) => sheet.repo)])].sort() : courseRepos.map((repo) => repo.id), workspaceMode, defaultWorkspace };
}
async function knownLibraryItem(kind: LibraryKind, id: string, workspace: string): Promise<boolean> {
  if (kind === 'course') return Boolean(await loadCourse(id)) && (contentSource() !== 'db' || (await contentReader().courseOwner(id)).id === workspace);
  return (await availableCheatsheets()).some((item) => item.id === id && (contentSource() !== 'db' || item.repo === workspace));
}
// Coding and test streaming stay off the open network. Loopback plus the tailnet is
// the whole trust boundary: Tailscale hands out the CGNAT range (100.64/10) and
// fd7a:115c:a1e0::/48, both of which are only reachable by this user's own devices.
export function isTrustedLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.toLowerCase().replace(/^::ffff:/, '').replace(/%.*$/, '');
  if (host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('fd7a:115c:a1e0:')) return true;
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const [first, second] = octets.map(Number);
  return first === 100 && second >= 64 && second <= 127;
}
export function isExactWebSocketOrigin(request: Pick<import('node:http').IncomingMessage, 'headers'>): boolean {
  const origin = request.headers.origin; const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try { const parsed = new URL(origin); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host && parsed.origin === origin; } catch { return false; }
}
type ApiPluginOptions = {
  allowStreamRequest?: (remoteAddress: string | undefined) => boolean;
  allowCodingRequest?: (remoteAddress: string | undefined) => boolean;
  allowUpgradeRequest?: (request: import('node:http').IncomingMessage) => boolean | Promise<boolean>;
  sandboxManager?: SandboxManager;
  reportFile?: string;
  watcherFactory?: typeof watch;
  spawnFactory?: typeof spawn;
  runnerTimeoutMs?: number;
  /** Test seam; production uses the repository's local Vitest executable. */
  runner?: (testPath: string, outputPath: string) => Promise<ConsoleOutput | void>;
  /** Test seams. Production always reads and writes the manifest-resolved source. */
  sourceReader?: (sourcePath: string) => Promise<string>;
  /** Explicitly opt into deterministic drill watchers; dev and production default off. */
  enableDeterministicWatchers?: boolean;
  /** Development-only state service. Persistent state routes are delegated without opening its SQLite file locally. */
  remoteStateOrigin?: string;
  workspaceCleanupIntervalMs?: number;
};
export async function cleanupStaleAttemptWorkspaces(manager: Pick<SandboxManager, 'all' | 'removeWorkspace'>, now = Date.now()): Promise<void> {
  const active = new Set(manager.all().filter((item) => item.kind === 'ai-coding' && item.status === 'running' && item.attemptNumber).map((item) => `${item.courseId}/${item.drillId}/${item.attemptNumber}`));
  for (const item of staleAttemptWorkspaces(new Date(now - 14 * 24 * 60 * 60_000))) if (!active.has(`${item.courseId}/${item.drillId}/${item.attemptNumber}`)) await manager.removeWorkspace(item.courseId, item.drillId, item.attemptNumber);
}
export default function apiPlugin(options: ApiPluginOptions = {}): Plugin & { configureServer(server: Pick<ViteDevServer, 'httpServer' | 'middlewares'>): void } {
  const allowStreamRequest = options.allowStreamRequest ?? isTrustedLocalAddress;
  const allowCodingRequest = options.allowCodingRequest ?? isTrustedLocalAddress;
  const reportFile = resolve(packageRoot, options.reportFile ?? '.vitest-report.json');
  const watcherFactory = options.watcherFactory ?? watch;
  const remoteStateOrigin = options.remoteStateOrigin;
  const runnerTimeoutMs = options.runnerTimeoutMs ?? COURSE_TEST_TIMEOUT_MS;
  const sourceReader = options.sourceReader ?? ((sourcePath: string) => readFile(sourcePath, 'utf8'));
  const sandboxManager = options.sandboxManager ?? SandboxManager.fromEnvironment();
  let contentApi: Promise<ReturnType<typeof createContentApi>> | undefined;
  // Vitest loads the Vite config in middleware mode, without an HTTP server.
  // Only injected watcher/runner seams may opt into that mode; the production
  // config must have a real Vite HTTP server before it can watch the drill tree.
  const deterministicWatchersEnabled = options.enableDeterministicWatchers
    ?? Boolean(options.watcherFactory || options.runner || options.spawnFactory);
  const injectedWatcherSeam = Boolean(options.watcherFactory || options.runner);
  const subscribers = new Set<ResultSubscriber>();
  const drillWatchers = new Set<FSWatcher>();
  type RunState = { courseId: string; chapterId: string; drillId: string; root: string; testPath: string; sourcePath: string; resultPath?: string; manifestTestPath?: string; generation: number; debouncedGeneration: number; runningGeneration?: number; pendingGeneration?: number; timer?: ReturnType<typeof setTimeout>; running: boolean; queued: boolean };
  const runStates = new Map<string, RunState>();
  const runQueue: RunState[] = [];
  const runStateKey = (state: RunState) => `${state.courseId}/${state.chapterId}/${state.drillId}`;
  let detachCatalogInvalidation = () => {};
  let watcherRefresh: Promise<void> = Promise.resolve();
  const children = new Set<ChildProcess>();
  const cancelRunners = new Set<() => void>();
  let stopping = false;
  let activeRuns = 0;
  const heartbeatIntervals = new Set<ReturnType<typeof setInterval>>();
  const subscriberStates = new WeakMap<ResultSubscriber, SubscriberState>();
  let detachSandboxProxy = () => {};
  let sandboxStarted: Promise<void> | undefined;
  let ensureSandboxStarted: () => Promise<void> = async () => {};
  let workspaceCleanupInterval: ReturnType<typeof setInterval> | undefined;
  const remove = (subscriber: ResultSubscriber) => subscribers.delete(subscriber);
  const closeSubscriber = (subscriber: ResultSubscriber) => {
    const state = subscriberStates.get(subscriber);
    if (state?.closed) return;
    if (state) state.closed = true;
    if (state?.heartbeat) { clearInterval(state.heartbeat); heartbeatIntervals.delete(state.heartbeat); state.heartbeat = undefined; }
    if (state?.drainListener) subscriber.removeListener?.('drain', state.drainListener);
    if (state?.lifecycleListener) {
      subscriber.removeListener?.('close', state.lifecycleListener);
      subscriber.removeListener?.('error', state.lifecycleListener);
    }
    remove(subscriber);
  };
  const drain = (subscriber: ResultSubscriber) => {
    const state = subscriberStates.get(subscriber);
    if (!state || state.closed) return;
    state.blocked = false;
    try {
      while (state.queue.length && !state.blocked) {
        const next = state.queue.shift()!;
        if (!subscriber.write(next)) state.blocked = true;
      }
      if (!state.blocked && !state.queue.length && !state.initializing) flushPending(subscriber);
    } catch { closeSubscriber(subscriber); }
  };
  const writeSubscriber = (subscriber: ResultSubscriber, chunk: string) => {
    const state = subscriberStates.get(subscriber);
    if (!state || subscriber.destroyed) return false;
    if (state.initializing || state.blocked || state.queue.length) {
      if (state.queue.length >= maxQueuedEvents) { try { subscriber.end?.(); } catch {} closeSubscriber(subscriber); return false; }
      state.queue.push(chunk); return true;
    }
    try {
      if (subscriber.write(chunk)) return true;
      state.blocked = true;
      if (!state.drainListener) {
        state.drainListener = () => drain(subscriber);
        subscriber.on?.('drain', state.drainListener);
      }
      return true;
    } catch { closeSubscriber(subscriber); return false; }
  };
  const flushPending = (subscriber: ResultSubscriber) => {
    const state = subscriberStates.get(subscriber);
    if (!state || state.initializing) return;
    const updates = state.pendingUpdates.splice(0);
    for (const update of updates) writeSubscriber(subscriber, `event: test-result\ndata: ${JSON.stringify(update)}\n\n`);
  };
  const sendUpdate = (subscriber: ResultSubscriber, update: ResultUpdate) => {
    const state = subscriberStates.get(subscriber);
    if (!state) return;
    if (state.initializing) { if (state.pendingUpdates.length < maxQueuedEvents) state.pendingUpdates.push(update); else closeSubscriber(subscriber); return; }
    writeSubscriber(subscriber, `event: test-result\ndata: ${JSON.stringify(update)}\n\n`);
  };
  const publishSandboxResult = async (courseId: string, drillId: string, testPath: string, absoluteTestPath: string, result: SubmissionResult) => {
    const course = await loadCourse(courseId); if (!course) return;
    const chapter = course.chapters.find((item) => item.drills.some((drill) => drill.id === drillId)); if (!chapter) return;
    const updatedAt = new Date().toISOString(); const status = result.status === 'tests-failed' ? 'failed' : result.status;
    if (!upsertTestFile(absoluteTestPath, status, result.tests, updatedAt)) return;
    const update: ResultUpdate = { courseId, chapterId: chapter.id, drillId, testPath, result: { status, tests: result.tests, ...(result.output ? { output: result.output } : {}), updatedAt } };
    for (const subscriber of subscribers) { try { sendUpdate(subscriber, update); } catch { subscribers.delete(subscriber); } }
  };
  const sendRunnerError = (update: RunnerErrorUpdate) => {
    for (const subscriber of subscribers) {
      try {
        writeSubscriber(subscriber, `event: runner-error\ndata: ${JSON.stringify(update)}\n\n`);
      } catch { subscribers.delete(subscriber); }
    }
  };
  const runLocalVitest = (testPath: string, outputPath: string): Promise<ConsoleOutput> => new Promise((resolveRun, reject) => {
    const executable = resolve(packageRoot, 'node_modules/vitest/vitest.mjs');
    const consoleReporter = resolve(packageRoot, 'server/consoleReporter.ts');
    const child = (options.spawnFactory ?? spawn)(process.execPath, [executable, 'run', testPath, '--reporter=json', `--reporter=${consoleReporter}`, `--outputFile.json=${outputPath}`], { cwd: packageRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const output: ConsoleOutput = { entries: [] };
    const maxOutputBytes = 64 * 1024;
    let outputBytes = 0;
    let framed = '';
    const decoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stderrTail = '';
    const appendStderr = (chunk: Buffer | string) => { stderrTail += stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); stderrTail = Buffer.from(stderrTail).subarray(-16 * 1024).toString('utf8'); };
    const runnerFailure = (message: string) => { const detail = sanitiseMessage(stripAnsi(stderrTail.trim())); return new Error(detail ? `${message}: ${detail}` : message); };
    const append = (entry: ConsoleEntry) => {
      if (output.truncated) return;
      if (output.entries.length >= 256) { output.truncated = true; return; }
      const cleanEntry = { ...entry, text: sanitiseMessage(stripAnsi(entry.text)), ...(entry.testName ? { testName: sanitiseMessage(stripAnsi(entry.testName)) } : {}) };
      const bytes = Buffer.from(cleanEntry.text);
      const remaining = maxOutputBytes - outputBytes;
      if (bytes.length <= remaining) { output.entries.push(cleanEntry); outputBytes += bytes.length; return; }
      if (remaining > 0) output.entries.push({ ...cleanEntry, text: bytes.subarray(0, remaining).toString('utf8') });
      output.truncated = true;
    };
    const consumeFrames = (text: string) => {
      framed += text;
      const lines = framed.split('\n'); framed = lines.pop() ?? '';
      if (framed.length > 64 * 1024) framed = '';
      for (const line of lines) {
        const start = line.indexOf(consoleFramePrefix);
        if (start < 0) { const notice = `JSON report written to ${outputPath}`; const raw = line.endsWith(notice) ? line.slice(0, -notice.length) : line ? `${line}\n` : ''; if (raw) append({ stream: 'stdout', text: raw }); continue; }
        if (start > 0) append({ stream: 'stdout', text: line.slice(0, start) });
        try {
          const value = JSON.parse(line.slice(start + consoleFramePrefix.length)) as ConsoleEntry;
          if ((value.stream === 'stdout' || value.stream === 'stderr') && typeof value.text === 'string' && (value.testName === undefined || (typeof value.testName === 'string' && value.testName.length <= 2000))) append(value);
        } catch { append({ stream: 'stdout', text: `${line.slice(start)}\n` }); }
      }
    };
    child.stdout?.on('data', (chunk) => consumeFrames(decoder.write(chunk)));
    child.stderr?.on('data', appendStderr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (error?: Error) => { if (finished) return; finished = true; consumeFrames(decoder.end()); if (framed) consumeFrames('\n'); stderrTail += stderrDecoder.end(); if (timer) clearTimeout(timer); children.delete(child); cancelRunners.delete(cancel); error ? reject(error) : resolveRun(output); };
    const cancel = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); } finish(new Error('Test runner stopped')); };
    cancelRunners.add(cancel);
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (signal) return finish(runnerFailure(`Test runner stopped (${signal})`));
      if (code !== 0 && code !== 1) return finish(runnerFailure(`Test runner failed (exit code ${code ?? 'unknown'})`));
      void stat(outputPath).then(() => finish()).catch(() => finish(runnerFailure('Test runner produced no report')));
    });
    timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      finish(courseTestTimeoutError(runnerTimeoutMs));
    }, runnerTimeoutMs);
  });
  const resolveCodingDrill = async (courseId: string, drillId: string) => {
    const course = await loadCourse(courseId);
    if (!course) return { error: { status: 404, message: `Unknown course: ${courseId}` } } as const;
    const drill = drillInCourse(course, drillId);
    if (!drill) return { error: { status: 404, message: `Unknown drill: ${drillId}` } } as const;
    if (!/\.(?:tsx?|py)$/.test(drill.sourcePath) || !drill.testPath) return { error: { status: 409, message: 'This drill does not use the code editor' } } as const;
    if (contentSource() === 'db') {
      const database = await contentDatabase(); const revision = currentContentRevision(database, course.id);
      const linked = repoForCourse(course.id); const prefix = `drills/${course.id}/${drill.id}/`;
      if (!drill.sourcePath.startsWith(prefix) || !drill.testPath.startsWith(prefix)) throw new Error('Drill paths are outside the workspace');
      const workspace = await prepareCodingWorkspace({ db: database, courseId: course.id, drillId: drill.id, revision, testPaths: [drill.testPath], ...(linked ? { linkedDrillPath: pathInRepo(linked, prefix.slice(0, -1)) } : {}) });
      const root = await materializeCourse(database, course.id, revision, undefined, drill.testPath);
      return { course, drill, repo: { id: 'managed', root }, workspace, revision, sourcePath: join(workspace, drill.sourcePath.slice(prefix.length)), testPath: join(root, drill.testPath) } as const;
    }
    const repo = requireRepoForCourse(course.id);
    const sourcePath = pathInRepo(repo, drill.sourcePath);
    const testPath = pathInRepo(repo, drill.testPath);
    return { course, drill, repo, sourcePath, testPath } as const;
  };
  const resolveAttemptDrill = async (courseId: string, drillId: string, currentCourse?: Course): Promise<{ course: Course; drill: Drill; revision?: number } | undefined> => {
    const current = currentCourse ?? await loadCourse(courseId); if (!current) return undefined;
    const attempt = getDrillAttempts(courseId, drillId).at(-1);
    if (contentSource() === 'db' && attempt && !attempt.completedAt && attempt.contentRevision) {
      const course = await courseAtRevision(courseId, attempt.contentRevision); if (!course) throw new Error('Attempt content revision is unavailable');
      const drill = drillInCourse(course, drillId);
      if (drill?.contentType === 'ai-coding') return { course, drill, revision: attempt.contentRevision };
    }
    const drill = drillInCourse(current, drillId); if (!drill) return undefined;
    return { course: current, drill };
  };
  const attemptDrillIds = (course: Course): string[] => {
    const ids = new Set(course.chapters.flatMap((chapter) => chapter.drills.map((drill) => drill.id)));
    if (contentSource() === 'db') for (const [id, attempts] of Object.entries(getCourseDrillAttempts(course.id))) { const latest = attempts.at(-1); if (latest && !latest.completedAt && latest.contentRevision !== undefined) ids.add(id); }
    return [...ids];
  };
  const resolveSandboxDrill = async (courseId: string, drillId: string, reviewAttempt?: ReturnType<typeof getDrillAttempts>[number]) => {
    const historical = reviewAttempt?.contentRevision !== undefined && contentSource() === 'db' ? await courseAtRevision(courseId, reviewAttempt.contentRevision) : undefined;
    if (reviewAttempt?.contentRevision !== undefined && contentSource() === 'db' && !historical) throw Object.assign(new Error('Attempt content revision is unavailable'), { status: 409 });
    const historicalDrill = historical && drillInCourse(historical, drillId);
    const resolved: { course: Course; drill: Drill; revision?: number } | undefined = historical ? historicalDrill ? { course: historical, drill: historicalDrill, revision: reviewAttempt!.contentRevision } : undefined : reviewAttempt ? await loadCourse(courseId).then((course) => { const drill = course && drillInCourse(course, drillId); return course && drill ? { course, drill } : undefined; }) : await resolveAttemptDrill(courseId, drillId);
    if (!resolved) return { error: { status: 404, message: await loadCourse(courseId) ? `Unknown drill: ${drillId}` : `Unknown course: ${courseId}` } } as const;
    const { course, drill } = resolved;
    if (drill.contentType !== 'coding' && drill.contentType !== 'ai-coding') return { error: { status: 409, message: 'This drill does not use the code editor' } } as const;
    if (contentSource() === 'db') {
      if (drill.contentType === 'coding') return resolveCodingDrill(courseId, drillId);
      const database = await contentDatabase(); const attempt = getDrillAttempts(courseId, drillId).at(-1);
      const current = currentContentRevision(database, course.id);
      const revision = resolved.revision ?? (!reviewAttempt && attempt && !attempt.completedAt ? pinOpenAttemptContentRevision(courseId, drillId, attempt.attemptNumber, current) : current);
      const pinnedCourse = await courseAtRevision(courseId, revision); const pinnedDrill = pinnedCourse && drillInCourse(pinnedCourse, drillId);
      if (!pinnedCourse || !pinnedDrill || pinnedDrill.contentType !== 'ai-coding') throw new Error('Attempt drill is unavailable in its content revision');
      const root = await materializeCourse(database, course.id, revision, undefined, pinnedDrill.sourcePath);
      return { course: pinnedCourse, drill: pinnedDrill, repo: { id: 'managed', root }, revision, sourcePath: join(root, pinnedDrill.sourcePath) } as const;
    }
    const repo = requireRepoForCourse(course.id);
    return { course, drill, repo, sourcePath: pathInRepo(repo, drill.sourcePath) } as const;
  };
  const activeAiSandbox = (courseId: string, drillId: string) => sandboxManager.all().find((item) => item.kind === 'ai-coding' && !item.review && item.status === 'running' && item.courseId === courseId && item.drillId === drillId);
  const unlockedStage = (courseId: string, drillId: string) => { const attempt = getDrillAttempts(courseId, drillId).at(-1); return attempt ? Math.max(1, getAttemptStages(courseId, drillId, attempt.attemptNumber).at(-1)?.stage ?? 1) : 1; };
  const advanceAiStage = async (course: NonNullable<Awaited<ReturnType<typeof loadCourse>>>, drill: Extract<Drill, { contentType: 'ai-coding' }>, reason: 'manual' | 'timer', timeZone?: unknown) => {
    const attempt = getDrillAttempts(course.id, drill.id).at(-1); if (!attempt || attempt.completedAt) throw Object.assign(new Error('Start an attempt before revealing another requirement'), { status: 409 });
    const resolved = await resolveAttemptDrill(course.id, drill.id); if (!resolved || resolved.drill.contentType !== 'ai-coding') throw new Error('Attempt drill is unavailable');
    course = resolved.course; drill = resolved.drill;
    const current = Math.max(1, getAttemptStages(course.id, drill.id, attempt.attemptNumber).at(-1)?.stage ?? 1); const count = stageCount(drill.instructions);
    if (current >= count) return { attempts: getDrillAttempts(course.id, drill.id), stage: current, stageCount: count, reason };
    if (reason === 'timer') { const threshold = drill.stageUnlock.mode === 'timer' ? drill.stageUnlock.minutes[current - 1] * 60_000 : Infinity; if (attempt.elapsedMs < threshold) throw Object.assign(new Error('The next requirement is not due yet'), { status: 409 }); }
    await ensureSandboxStarted();
    const record = activeAiSandbox(course.id, drill.id); if (!record || !await sandboxManager.isRunning(record.id)) throw Object.assign(new Error('The attempt workspace is not running'), { status: 409, code: 'SANDBOX_STOPPED' });
    const commit = await sandboxManager.exec(record.id, { action: 'stage-commit', stage: current, timeZone }); if (commit.exitCode !== 0) throw Object.assign(new Error('Stage commit failed'), { status: 502 });
    const stage = current + 1; recordAttemptStage(course.id, drill.id, attempt.attemptNumber, stage, reason, new Date(), parseCommitOutput(commit.output));
    return { attempts: getDrillAttempts(course.id, drill.id), stage, stageCount: count, reason };
  };
  const applyDueStages = async (course: NonNullable<Awaited<ReturnType<typeof loadCourse>>>, drill: Extract<Drill, { contentType: 'ai-coding' }>, timeZone?: unknown) => {
    const resolved = await resolveAttemptDrill(course.id, drill.id); if (!resolved || resolved.drill.contentType !== 'ai-coding') return;
    course = resolved.course; drill = resolved.drill;
    if (drill.stageUnlock.mode !== 'timer') return;
    const attempt = getDrillAttempts(course.id, drill.id).at(-1); if (!attempt || attempt.completedAt) return;
    try { await ensureSandboxStarted(); } catch { return; /* initialization failure was logged; retry on the next read */ }
    if (!activeAiSandbox(course.id, drill.id)) return;
    while (true) { const attempt = getDrillAttempts(course.id, drill.id).at(-1); if (!attempt || attempt.completedAt) return; const stage = Math.max(1, getAttemptStages(course.id, drill.id, attempt.attemptNumber).at(-1)?.stage ?? 1); const due = drill.stageUnlock.minutes[stage - 1]; if (due === undefined || attempt.elapsedMs < due * 60_000) return; try { await advanceAiStage(course, drill, 'timer', timeZone); } catch (error) { if ((error as { code?: string }).code === 'SANDBOX_STOPPED') return; throw error; } }
  };
  const decorateAiAttempts = async (courseId: string, drill: Extract<Drill, { contentType: 'ai-coding' }>, attempts: ReturnType<typeof getDrillAttempts>, start = false) => Promise.all(attempts.map(async (attempt) => {
    if (start && attempt.attemptNumber === attempts.at(-1)?.attemptNumber) recordAttemptStage(courseId, drill.id, attempt.attemptNumber, 1, 'start');
    const historical = attempt.contentRevision === undefined ? undefined : await courseAtRevision(courseId, attempt.contentRevision);
    if (attempt.contentRevision !== undefined && contentSource() === 'db' && !historical) throw new Error('Attempt content revision is unavailable');
    const definition = historical && drillInCourse(historical, drill.id); const last = getAttemptStages(courseId, drill.id, attempt.attemptNumber).at(-1);
    return { ...attempt, stage: last?.stage ?? 1, stageCount: stageCount(definition?.contentType === 'ai-coding' ? definition.instructions : drill.instructions), lastStageReason: last?.reason ?? 'start' };
  }));
  const fingerprint = async (paths: string[]) => (await Promise.all(paths.map(async (path) => { try { const s = await stat(path); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } }))).join('|');
  const runOne = async (state: Exclude<ReturnType<typeof runStates.get>, undefined>, generation: number) => {
    let { sourcePath, testPath, resultPath, manifestTestPath } = state; let revision: number | undefined;
    if (contentSource() === 'db') {
      const current = await resolveCodingDrill(state.courseId, state.drillId);
      if (!current.sourcePath || !current.testPath || !current.drill?.testPath || !('revision' in current)) throw new Error(current.error?.message ?? 'Current drill is unavailable');
      const prefix = `drills/${state.courseId}/${state.drillId}/`;
      sourcePath = current.sourcePath; testPath = join(codingWorkspace(state.courseId, state.drillId), current.drill.testPath.slice(prefix.length));
      resultPath = current.testPath; manifestTestPath = current.drill.testPath; revision = current.revision;
    }
    if (generation !== state.generation || runStates.get(runStateKey(state)) !== state) return;
    const before = await fingerprint([sourcePath, testPath]);
    if (generation !== state.generation || runStates.get(runStateKey(state)) !== state) return;
    const directory = await mkdtemp(join(tmpdir(), 'interview-runner-'));
    const output = join(directory, 'result.json');
    try {
      const consoleOutput = sourcePath.endsWith('.py') ? await runPytest(testPath, output, state.root, runnerTimeoutMs, children).then((value) => ({ ...value, entries: value.entries.map((entry) => ({ ...entry, text: sanitiseMessage(entry.text), ...(entry.testName ? { testName: sanitiseMessage(entry.testName) } : {}) })) })) : await (options.runner ?? runLocalVitest)(testPath, output);
      // `state` is the canonical entry (the map key includes course/chapter so
      // duplicate drill ids cannot collide); checking its generation also makes
      // this safe when a save arrives while the child is still running.
      if (generation !== state.generation || before !== await fingerprint([sourcePath, testPath]) || (revision !== undefined && currentContentRevision(await contentDatabase(), state.courseId) !== revision)) return;
      let report: Report;
      try { report = JSON.parse(await readFile(output, 'utf8')) as Report; } catch { throw new Error('Test runner produced no valid report'); }
      const raw = Array.isArray(report.testResults) ? report.testResults.find((entry) => entry && typeof entry === 'object' && resolve(state.root, String((entry as ReportEntry).name)) === testPath) : undefined;
      if (!raw || typeof raw !== 'object') return;
      const entry = raw as ReportEntry;
      // The runner's completion is the authoritative freshness boundary. Include
      // file mtimes as a lower bound too, so a clock-skewed filesystem cannot
      // make a just-persisted live result look stale on the next GET snapshot.
      let completedAt = Date.now();
      try {
        const [source, test] = await Promise.all([stat(sourcePath), contentSource() === 'db' ? retryMissingRevision(() => stat(testPath)) : stat(testPath)]);
        completedAt = Math.max(completedAt, source.mtimeMs, test.mtimeMs);
      } catch { /* fingerprint already proved the inputs existed at run start */ }
      const result = { ...resultFor(entry, new Date(completedAt).toISOString()), ...(consoleOutput ? { output: consoleOutput } : {}) };
      if (generation !== state.generation || (revision !== undefined && currentContentRevision(await contentDatabase(), state.courseId) !== revision)) return;
      if (!upsertTestFile(resultPath ?? testPath, result.status, result.tests, result.updatedAt)) return;
      // Generation and fingerprint checks above establish that this report was
      // produced for the current save. Do not re-run the mtime-based snapshot
      // heuristic here: filesystem clocks can legitimately be ahead of wall
      // clock, and that would turn a successful save-triggered result stale.
      const update: ResultUpdate = { courseId: state.courseId, chapterId: state.chapterId, drillId: state.drillId, testPath: manifestTestPath ?? relative(state.root, testPath), result };
      for (const subscriber of subscribers) { try { sendUpdate(subscriber, update); } catch { subscribers.delete(subscriber); } }
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  };
  const enqueue = (state: RunState) => {
    if (stopping || state.queued || runStates.get(runStateKey(state)) !== state) return;
    state.pendingGeneration = undefined;
    state.queued = true;
    runQueue.push(state);
    pump();
  };
  const pump = () => {
    while (!stopping && activeRuns < 2 && runQueue.length) {
      const state = runQueue.shift()!;
      // A state is either represented by the queue or by a running promise.
      // Repair the flag before inspecting it so an unexpected duplicate can
      // never strand the state as queued forever.
      state.queued = false;
      if (runStates.get(runStateKey(state)) !== state) continue;
      if (state.running) {
        continue;
      }
      const generation = state.generation;
      state.running = true;
      state.runningGeneration = generation;
      activeRuns++;
      void runOne(state, generation).catch(() => {
        if (!stopping && generation === state.generation) sendRunnerError({ courseId: state.courseId, chapterId: state.chapterId, drillId: state.drillId, testPath: relative(state.root, state.testPath), error: 'runner-error', stale: true });
      }).finally(() => {
        state.running = false;
        state.runningGeneration = undefined;
        activeRuns--;
        const followUpGeneration = Math.max(state.generation, state.pendingGeneration ?? 0);
        if (!stopping && runStates.get(runStateKey(state)) === state && followUpGeneration > generation) enqueue(state);
        pump();
      });
    }
  };
  const schedule = (state: RunState) => {
    if (stopping || runStates.get(runStateKey(state)) !== state) return;
    const generation = ++state.generation;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.debouncedGeneration = Math.max(state.debouncedGeneration, generation);
      if (stopping) return;
      if (state.running) {
        // The completion path owns the follow-up. Recording the debounced
        // generation makes both timer/completion interleavings explicit: a
        // timer that wins first is consumed by completion, while a completion
        // that wins first leaves this callback with an already-running or
        // already-queued generation and therefore no duplicate.
        if (generation > (state.runningGeneration ?? 0)) state.pendingGeneration = generation;
        return;
      } else if (state.queued) {
        // The existing queue entry will read state.generation when it starts.
        return;
      } else {
        enqueue(state);
      }
    }, 100);
  };
  const rebuildDeterministicWatchers = async () => {
    if (stopping) return;
    const pending = new Set([...runStates.values()].filter((state) => state.running || state.queued || state.timer).map(runStateKey));
    for (const state of runStates.values()) { state.generation++; if (state.timer) clearTimeout(state.timer); }
    for (const watcher of drillWatchers) watcher.close(); drillWatchers.clear(); runStates.clear(); runQueue.length = 0;
    try {
      const courses = await loadCourses();
      for (const course of courses) for (const chapter of course.chapters) for (const drill of chapter.drills) {
        if (stopping) return;
        if (!drill.testPath || drill.evaluation) continue;
        let state: RunState;
        if (contentSource() === 'db') {
          const resolved = await resolveCodingDrill(course.id, drill.id); if (!resolved.sourcePath || !resolved.testPath) continue;
          const prefix = `drills/${course.id}/${drill.id}/`;
          state = { courseId: course.id, chapterId: chapter.id, drillId: drill.id, root: codingWorkspace(course.id, drill.id), testPath: join(codingWorkspace(course.id, drill.id), drill.testPath.slice(prefix.length)), sourcePath: resolved.sourcePath, resultPath: resolved.testPath, manifestTestPath: drill.testPath, generation: 0, debouncedGeneration: 0, running: false, queued: false };
        } else {
          const repo = requireRepoForCourse(course.id); state = { courseId: course.id, chapterId: chapter.id, drillId: drill.id, root: repo.root, testPath: pathInRepo(repo, drill.testPath), sourcePath: pathInRepo(repo, drill.sourcePath), generation: 0, debouncedGeneration: 0, running: false, queued: false };
        }
        runStates.set(runStateKey(state), state);
      }
      const directoryStates = new Map<string, Map<string, Set<RunState>>>();
      for (const state of runStates.values()) for (const watched of [state.sourcePath, state.testPath]) {
        const directory = dirname(watched);
        let states = directoryStates.get(directory);
        if (!states) { states = new Map(); directoryStates.set(directory, states); }
        let matching = states.get(basename(watched));
        if (!matching) { matching = new Set(); states.set(basename(watched), matching); }
        matching.add(state);
      }
      for (const [directory, states] of directoryStates) try {
        const watcher = watcherFactory(directory, { persistent: false }, (_event, filename) => {
          const name = filename == null ? undefined : String(filename).replaceAll('\\', '/').split('/').pop();
          if (name) for (const state of states.get(name) ?? []) schedule(state);
          // An omitted filename cannot be mapped safely. Ignore it rather than
          // triggering every drill in the directory (which would violate the
          // exact-path guarantee).
        });
        drillWatchers.add(watcher);
        watcher.on('error', () => { watcher.close(); drillWatchers.delete(watcher); });
      } catch (error) { console.warn(`Could not watch drill directory ${directory}`, error); }
      for (const key of pending) { const state = runStates.get(key); if (state) schedule(state); }
    } catch (error) { console.error('Could not rebuild deterministic drill watchers', error); }
  };
  const startDeterministicWatchers = () => { watcherRefresh = watcherRefresh.then(rebuildDeterministicWatchers).catch((error: unknown) => { console.error('Deterministic watcher refresh failed', error); }); return watcherRefresh; };
  const stop = () => {
    stopping = true;
    detachCatalogInvalidation(); detachCatalogInvalidation = () => {};
    if (workspaceCleanupInterval) clearInterval(workspaceCleanupInterval);
    detachSandboxProxy(); detachSandboxProxy = () => {}; sandboxManager.close();
    for (const state of runStates.values()) if (state.timer) clearTimeout(state.timer);
    for (const watcher of drillWatchers) watcher.close(); drillWatchers.clear();
    for (const cancel of cancelRunners) cancel();
    for (const child of children) { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); } const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } } }, 250); timer.unref?.(); }
    for (const heartbeat of heartbeatIntervals) clearInterval(heartbeat);
    heartbeatIntervals.clear();
    for (const subscriber of [...subscribers]) { try { subscriber.end?.(); } catch {} closeSubscriber(subscriber); }
    subscribers.clear();
  };
  const courseImages = courseRepos.map((repo) => sirv(resolve(repo.root, 'images'), { dev: true, etag: true }));
  return { name: 'practice-api', configureServer(server: Pick<ViteDevServer, 'httpServer' | 'middlewares'>) {
    const hasHttpServer = Boolean(server.httpServer);
    if (deterministicWatchersEnabled && (hasHttpServer || injectedWatcherSeam)) {
      if (contentSource() === 'db') detachCatalogInvalidation = onCourseCatalogInvalidated(() => { void startDeterministicWatchers(); });
      void startDeterministicWatchers();
    }
    if (hasHttpServer) {
      if (contentSource() === 'db') void contentDatabase().then((database) => {
        const row = database.prepare('SELECT COUNT(*) AS count FROM course WHERE deleted_at IS NULL').get() as { count: number };
        if (row.count === 0) console.warn('Content database has no courses; run npm run content:import once to import linked courses.');
      }).catch((error: unknown) => console.error('Content database startup check failed', error));
      const rawServer = server.httpServer! as unknown as import('node:http').Server;
      const allowUpgradeRequest = options.allowUpgradeRequest ?? ((request: import('node:http').IncomingMessage) => allowCodingRequest(request.socket.remoteAddress) && isExactWebSocketOrigin(request));
      const cleanup = async () => { await cleanupStaleAttemptWorkspaces(sandboxManager); if (contentSource() === 'db') { const database = await contentDatabase(); for (const course of await loadCourses()) await gcMaterialized(database, course.id, openAttemptContentRevisions(course.id)); } };
      ensureSandboxStarted = () => {
        if (stopping) return Promise.reject(Object.assign(new Error('Sandbox service unavailable'), { status: 503 }));
        if (!sandboxStarted) {
          sandboxStarted = Promise.resolve().then(async () => {
            await sandboxManager.start();
            if (stopping) { sandboxManager.close(); throw new Error('Server stopped during sandbox initialization'); }
            try { await cleanup(); } catch (error) { console.error('Workspace cleanup failed', error); }
            if (!stopping) { workspaceCleanupInterval = setInterval(() => { void cleanup().catch((error: unknown) => console.error('Workspace cleanup failed', error)); }, options.workspaceCleanupIntervalMs ?? 60_000); workspaceCleanupInterval.unref?.(); }
          }).catch((error: unknown) => {
            sandboxStarted = undefined;
            console.error('Sandbox initialization failed', error);
            throw Object.assign(new Error('Sandbox service unavailable', { cause: error }), { status: 503 });
          });
        }
        return sandboxStarted;
      };
      // Attach a rejection handler immediately: sandboxd may still be starting.
      void ensureSandboxStarted().catch(() => { /* already logged; the next request retries */ });
      if (typeof rawServer.on === 'function' && typeof rawServer.off === 'function') {
        const attached = attachSandboxProxy(rawServer, sandboxManager, { allowHttpRequest: (request) => allowCodingRequest(request.socket.remoteAddress), allowUpgradeRequest, ensureStarted: ensureSandboxStarted });
        detachSandboxProxy = attached.close;
        server.middlewares.use(attached.middleware);
      }
      server.httpServer!.once('close', stop);
    }
    server.middlewares.use(async (request, response, next) => {
      const rawPath = (request.url ?? '').split('?', 1)[0];
      if (!rawPath.startsWith('/cheatsheets/')) return next();
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.statusCode = 405; response.setHeader('Allow', 'GET, HEAD'); response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end('Method not allowed'); return;
      }
      const segments = rawPath.slice('/cheatsheets/'.length).split('/');
      let asset: Awaited<ReturnType<typeof readCheatsheetAsset>>;
      try { asset = await readCheatsheetAsset(segments); }
      catch (error) { response.statusCode = 400; response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.end(error instanceof Error ? error.message : 'Cheatsheet unavailable'); return; }
      if (!asset) { response.statusCode = 404; response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-cache'); response.end('Not found'); return; }
      response.statusCode = 200; response.setHeader('Content-Type', asset.contentType); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      if (contentNotModified(request, response, asset.sha256)) { response.statusCode = 304; response.end(); return; }
      response.end(request.method === 'HEAD' ? undefined : asset.body);
    });
    // Outline images (`/images/...`) are course material served from the courses checkout.
    server.middlewares.use(async (request, response, next) => {
      const url = request.url ?? '';
      if (!url.startsWith('/images/')) return next();
      // Fragments are not valid in an HTTP request target; never pass one to sirv.
      if (url.includes('#')) { response.statusCode = 400; response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end('Invalid request URL'); return; }
      // Match @polka/url's pathname before decoding or checking containment.
      const pathname = url.split(/[?#]/, 1)[0];
      if (contentSource() === 'db') {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) return next();
        let path: string;
        try { path = decodeURIComponent(pathname.slice('/images/'.length)); } catch { return next(); }
        if (!path || path.includes('\\') || path.includes(':') || path.includes('\0') || path.split('/').some((part) => !part || part.startsWith('.'))) return next();
        try {
          const image = await contentReader().readImage(path); if (!image) return next();
          const extension = path.split('.').at(-1)?.toLowerCase();
          const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon' };
          response.statusCode = 200; response.setHeader('Content-Type', types[extension ?? ''] ?? 'application/octet-stream'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-cache');
          if (contentNotModified(request, response, image.sha256)) { response.statusCode = 304; response.end(); return; }
          response.end(request.method === 'HEAD' ? undefined : image.bytes); return;
        } catch (error) { return next(error); }
      }
      let path: string;
      path = pathname.slice('/images/'.length);
      try { path = decodeURI(path); } catch { /* sirv also leaves malformed escapes unchanged */ }
      try {
        const repo = await fileImageRepository(path); const index = courseRepos.findIndex((item) => item.id === repo);
        if (index < 0) return next();
        request.url = url.slice('/images'.length); courseImages[index](request, response, () => { request.url = url; next(); });
      } catch (error) { next(error); }
    });
    server.middlewares.use(async (request, response, next) => {
      if (!/^\/api\/content(?:[/?]|$)/.test(request.url ?? '')) return next();
      response.setHeader('Cache-Control', 'no-store');
      let api: ReturnType<typeof createContentApi>;
      try {
        api = await (contentApi ??= Promise.resolve().then(() => contentDatabase()).then((contentDb) => createContentApi({ contentDb, stateDb: stateDb(), readWhiteboards: whiteboards, whiteboardStateOrigin: remoteStateOrigin })).catch((error: unknown) => { contentApi = undefined; throw error; }));
      } catch (error) {
        console.error('Content API initialization failed', error);
        return send(response, 500, { error: 'Content API unavailable' });
      }
      try {
        const parts = new URL(request.url!, 'http://localhost').pathname.split('/').filter(Boolean);
        if (!await api.handle(request, response, parts, request.method ?? 'GET')) return next();
      } catch (error) {
        return send(response, Number((error as { status?: number }).status ?? 400), { error: error instanceof Error ? error.message : 'Request failed' });
      }
    });
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/api/')) return next();
      let streamStarted = false;
      let streamCleanup: (() => void) | undefined;
      try {
        let url = new URL(request.url, 'http://localhost'); let parts = url.pathname.split('/').filter(Boolean); const method = request.method ?? 'GET';
        if (method === 'GET') response.setHeader('Cache-Control', 'no-store');
        if (method === 'POST' && parts.length === 5 && parts[1] === 'drills' && parts[4] === 'run') {
          if (!allowCodingRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Sandboxes are available only from this machine or its tailnet' });
          await ensureSandboxStarted();
          const record = sandboxManager.all().find((item) => item.courseId === parts[2] && item.drillId === parts[3]);
          if (!record) return send(response, 409, { error: 'Open the sandbox before running this drill' });
          request.url = `/api/sandboxes/${encodeURIComponent(record.id)}/run`; url = new URL(request.url, 'http://localhost'); parts = url.pathname.split('/').filter(Boolean);
        }
        const courseTagsMatch = /^\/api\/courses\/([^/]+)\/tags$/.exec(url.pathname);
        if (remoteStateOrigin && method === 'PUT' && courseTagsMatch) {
          const authoritative = await fetchAuthoritativeCourseTags(remoteStateOrigin, decodeURIComponent(courseTagsMatch[1]), request.headers?.['x-interview-time-zone']);
          if (authoritative.known) { try { await proxyStateRequest(request, response, remoteStateOrigin); } catch { send(response, 502, { error: 'Authoritative state service is unavailable' }); } return; }
        }
        if (!CHEATSHEET_COVERAGE_ENABLED && parts[1] === 'cheatsheet-coverage') return method === 'GET' ? send(response, 200, { enabled: false }) : send(response, 403, { error: 'Coverage is disabled' });
        if (remoteStateOrigin && isStateRoute(url.pathname)) { try { await proxyStateRequest(request, response, remoteStateOrigin); } catch { send(response, 502, { error: 'Authoritative state service is unavailable' }); } return; }
        const workspace = contentSource() === 'db' ? url.searchParams.get('workspace') ?? defaultWorkspace : defaultWorkspace;
        if (parts[1] === 'library' && contentSource() === 'db') {
          if (url.searchParams.getAll('workspace').length > 1 || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(workspace)) return send(response, 400, { error: 'Invalid workspace' });
          const database = await contentDatabase();
          if (workspace !== defaultWorkspace && !database.prepare('SELECT 1 FROM content_meta WHERE key=? UNION ALL SELECT 1 FROM course WHERE namespace_id=? AND deleted_at IS NULL LIMIT 1').get(`workspace:${workspace}`, workspace)) return send(response, 404, { error: 'Unknown workspace' });
        }
        if (method === 'GET' && url.pathname === '/api/library') return send(response, 200, await libraryCatalog(workspace));
        if (method === 'POST' && parts.length === 3 && parts[1] === 'library' && parts[2] === 'categories') {
          const input = await body(request); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'name') return send(response, 400, { error: 'Request body must contain only name' });
          let name: string; try { name = libraryName((input as { name?: unknown }).name, 'name'); } catch (error) { return send(response, 400, { error: (error as Error).message }); }
          createLibraryCategory(name, workspace);
          return send(response, 201, await libraryCatalog(workspace));
        }
        if ((method === 'PUT' || method === 'DELETE') && parts.length === 4 && parts[1] === 'library' && parts[2] === 'categories') {
          const category = getLibraryCategories(workspace).find((item) => item.id === parts[3]); if (!category) return send(response, 404, { error: `Unknown category: ${parts[3]}` });
          if (category.fixed) return send(response, 400, { error: 'Uncategorized cannot be renamed or deleted' });
          if (method === 'DELETE') { deleteLibraryCategory(parts[3], workspace); return send(response, 200, await libraryCatalog(workspace)); }
          const input = await body(request); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'name') return send(response, 400, { error: 'Request body must contain only name' });
          let name: string; try { name = libraryName((input as { name?: unknown }).name, 'name'); } catch (error) { return send(response, 400, { error: (error as Error).message }); }
          renameLibraryCategory(parts[3], name, workspace);
          return send(response, 200, await libraryCatalog(workspace));
        }
        if (method === 'PUT' && parts.length === 5 && parts[1] === 'library' && parts[2] === 'categories' && parts[4] === 'move') {
          const category = getLibraryCategories(workspace).find((item) => item.id === parts[3]); if (!category) return send(response, 404, { error: `Unknown category: ${parts[3]}` });
          if (category.fixed) return send(response, 400, { error: 'Uncategorized cannot be reordered' });
          const input = await body(request) as { position?: unknown }; if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'position' || !Number.isInteger(input.position) || Number(input.position) < 0) return send(response, 400, { error: 'position must be a non-negative integer' });
          moveLibraryCategory(parts[3], Number(input.position), workspace); return send(response, 200, await libraryCatalog(workspace));
        }
        if (method === 'PUT' && parts.length === 6 && parts[1] === 'library' && parts[2] === 'items') {
          const kind = parts[3] as LibraryKind; const id = parts[4]; const action = parts[5];
          if (kind !== 'course' && kind !== 'cheatsheet') return send(response, 400, { error: 'kind must be course or cheatsheet' });
          if (!await knownLibraryItem(kind, id, workspace)) return send(response, 404, { error: `Unknown ${kind}: ${id}` });
          const input = await body(request);
          if (!input || typeof input !== 'object' || Array.isArray(input)) return send(response, 400, { error: 'Request body must be an object' });
          if (action === 'move') {
            const value = input as { categoryId?: unknown; position?: unknown }; if (Object.keys(value).sort().join(',') !== 'categoryId,position' || typeof value.categoryId !== 'string' || !Number.isInteger(value.position) || Number(value.position) < 0) return send(response, 400, { error: 'move requires categoryId and a non-negative integer position' });
            if (value.categoryId !== 'uncategorized' && !getLibraryCategories(workspace).some((category) => category.id === value.categoryId)) return send(response, 404, { error: `Unknown category: ${value.categoryId}` });
            moveLibraryItem(kind, id, value.categoryId, Number(value.position), workspace); return send(response, 200, await libraryCatalog(workspace));
          }
          if (action === 'status') {
            const value = input as { status?: unknown }; if (Object.keys(value).join(',') !== 'status' || !['active', 'done', 'archived'].includes(String(value.status))) return send(response, 400, { error: 'status must be active, done, or archived' });
            setLibraryItemStatus(kind, id, value.status as LibraryStatus, workspace); return send(response, 200, await libraryCatalog(workspace));
          }
          if (action === 'title') {
            const value = input as { title?: unknown }; if (Object.keys(value).join(',') !== 'title') return send(response, 400, { error: 'Request body must contain only title' });
            let title: string | null = null; if (value.title !== null) { try { title = libraryName(value.title, 'title'); } catch (error) { return send(response, 400, { error: (error as Error).message }); } }
            setLibraryItemTitle(kind, id, title, workspace); return send(response, 200, await libraryCatalog(workspace));
          }
          if (action === 'schedule') {
            if (kind !== 'course') return send(response, 400, { error: 'Deadline and tier are only available for courses' });
            const value = input as { deadline?: unknown; tier?: unknown; deadlineCleared?: unknown; tierCleared?: unknown };
            if (!Object.hasOwn(value, 'deadline') || !Object.hasOwn(value, 'tier') || Object.keys(value).some((key) => !['deadline', 'tier', 'deadlineCleared', 'tierCleared'].includes(key)) || (value.deadlineCleared !== undefined && typeof value.deadlineCleared !== 'boolean') || (value.tierCleared !== undefined && typeof value.tierCleared !== 'boolean') || (value.deadlineCleared === true && value.deadline !== null) || (value.tierCleared === true && value.tier !== null)) return send(response, 400, { error: 'Request body must contain deadline and tier with optional clear flags' });
            let deadline: string | null = null;
            if (value.deadline !== null) { try { deadline = parseDeadline(value.deadline, 'library'); } catch { return send(response, 400, { error: 'deadline must be a valid calendar date or ISO datetime with an explicit offset' }); } }
            const course = await loadCourse(id); if (!course) return send(response, 404, { error: `Unknown course: ${id}` });
            if (value.tier !== null && (value.tier !== 1 && value.tier !== 2 && value.tier !== 3 || !course.company)) return send(response, 400, { error: 'tier must be 1, 2, or 3 and requires a company' });
            setCourseScheduleOverride(id, deadline, value.tier as 1 | 2 | 3 | null, value.deadlineCleared === true, value.tierCleared === true); return send(response, 200, await libraryCatalog(workspace));
          }
          return send(response, 404, { error: 'Not found' });
        }
        if (parts.length === 3 && parts[1] === 'cheatsheet-coverage') {
          const sheet = await loadCheatsheet(parts[2]);
          if (!sheet) return send(response, 404, { error: 'Cheatsheet not found' });
          if (method === 'GET') return send(response, 200, getCheatsheetCoverage(sheet.id));
          if (method === 'POST') {
            if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
            const batch = coverageBatch(await body(request, 256 * 1024));
            if (!batch) return send(response, 400, { error: 'Invalid coverage batch' });
            const result = addCheatsheetCoverage(sheet.id, batch);
            return result ? send(response, 200, result) : send(response, 409, { error: 'Coverage was reset; reload before recording more activity' });
          }
          if (method === 'DELETE') {
            const match = /^"(0|[1-9]\d*)"$/.exec(String(request.headers?.['if-match'] ?? ''));
            if (!match || !Number.isSafeInteger(Number(match[1]))) return send(response, 428, { error: 'If-Match with the observed revision is required' });
            const result = resetCheatsheetCoverage(sheet.id, Number(match[1]));
            return result ? send(response, 200, result) : send(response, 409, { error: 'Coverage changed; reload before resetting' });
          }
          return send(response, 405, { error: 'Method not allowed' });
        }
        if (method === 'GET' && url.pathname === '/api/cheatsheets') return send(response, 200, await availableCheatsheets());
        if (method === 'GET' && parts.length === 3 && parts[1] === 'cheatsheets') {
          const sheet = await loadCheatsheet(parts[2]);
          if (!sheet) return send(response, 404, { error: 'Cheatsheet not found' });
          const { repo: _repo, ...manifest } = sheet;
          return send(response, 200, manifest);
        }
        if (method === 'GET' && parts.length === 4 && parts[1] === 'cheatsheets' && parts[3] === 'content') {
          const sheet = await loadCheatsheet(parts[2]);
          if (!sheet) return send(response, 404, { error: 'Cheatsheet not found' });
          return send(response, 200, await readCheatsheetDocument(sheet));
        }
        if (method === 'GET' && parts.length === 2 && parts[1] === 'courses') { const courses = await loadCourses(); const overrides = getCourseTagOverrides(); const schedules = getCourseScheduleOverrides(); const authoritative = remoteStateOrigin ? await fetchAuthoritativeCourseMap(remoteStateOrigin) : undefined; return send(response, 200, await Promise.all(courses.map(async (course) => { const remote = authoritative?.get(course.id); const schedule = effectiveSchedule(course, schedules[course.id]); return { id: course.id, repo: (await contentReader().courseOwner(course.id)).id, title: course.title, deadline: remote ? remote.deadline : schedule.deadline, company: course.company, tier: course.company ? remote ? remote.tier : schedule.tier : undefined, role: course.role, tags: remote ? remote.tags : overrides[course.id] ?? course.tags, createdAt: course.createdAt, updatedAt: course.updatedAt, chapterCount: course.chapters.length, drillCount: course.chapters.reduce((n, c) => n + c.drills.length, 0) }; }))); }
        if (method === 'GET' && parts.length === 2 && parts[1] === 'books') { const courses = await loadCourses(); const overrides = getCourseTagOverrides(); const statuses = getBookStatuses(); return send(response, 200, courses.filter((course) => course.book === true).map((course) => ({ id: course.id, title: course.title, tags: overrides[course.id] ?? course.tags, status: statuses[course.id] ?? 'reading' }))); }
        if (method === 'PUT' && parts.length === 4 && parts[1] === 'courses' && parts[3] === 'tags') {
          const courseId = parts[2];
          if (!await loadCourse(courseId)) return send(response, 404, { error: `Unknown course: ${courseId}` });
          if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
          const input = await body(request);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'tags')) return send(response, 400, { error: 'Request body must contain only a tags array' });
          let tags: string[];
          try { tags = normalizeTags((input as { tags: unknown }).tags); } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid tags' }); }
          setCourseTagOverride(courseId, tags);
          return send(response, 200, { courseId, tags });
        }
        if (method === 'PUT' && parts.length === 3 && parts[1] === 'books') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); const input = await body(request); if (!input || typeof input !== 'object' || !('status' in input) || (input.status !== 'reading' && input.status !== 'archived')) return send(response, 400, { error: 'status must be reading or archived' }); const owner = contentSource() === 'db' ? (await contentReader().courseOwner(parts[2])).id : defaultWorkspace; return send(response, 200, setBookStatus(parts[2], input.status, owner)); }
        if (method === 'GET' && parts.length === 3 && parts[1] === 'book-chapter-rank') { const course = await loadCourse(parts[2]); return course ? send(response, 200, getChapterRanks(parts[2])) : send(response, 404, { error: `Unknown course: ${parts[2]}` }); }
         if (method === 'PUT' && parts.length === 4 && parts[1] === 'book-chapter-rank') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (!course.chapters.some((chapter) => chapter.id === parts[3])) return send(response, 404, { error: `Unknown chapter: ${parts[3]}` }); const input = await body(request); if (!input || typeof input !== 'object' || !('rank' in input) || typeof input.rank !== 'number' || !Number.isInteger(input.rank) || input.rank < 0) return send(response, 400, { error: 'rank must be a non-negative integer' }); setChapterRank(parts[2], parts[3], input.rank); return send(response, 200, { chapterId: parts[3], rank: input.rank }); }
         if (method === 'GET' && parts.length === 3 && parts[1] === 'courses') {
           const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` });
           const chapters = await Promise.all(course.chapters.map(async (chapter) => ({ ...chapter, drills: await Promise.all(chapter.drills.map(async (current) => {
             const resolved = await resolveAttemptDrill(course.id, current.id, course); const drill = resolved?.drill ?? current;
             if (drill.contentType !== 'ai-coding') return current;
             await applyDueStages(resolved?.course ?? course, drill, request.headers?.['x-interview-time-zone']);
             return { ...drill, instructions: unlockedInstructions(drill.instructions, unlockedStage(course.id, drill.id)) };
           })) })));
           const included = new Set(chapters.flatMap((chapter) => chapter.drills.map((drill) => drill.id)));
           for (const id of attemptDrillIds(course)) {
             if (included.has(id)) continue;
             const resolved = await resolveAttemptDrill(course.id, id, course); if (!resolved || resolved.drill.contentType !== 'ai-coding') continue;
             await applyDueStages(resolved.course, resolved.drill, request.headers?.['x-interview-time-zone']);
             const original = resolved.course.chapters.find((chapter) => chapter.drills.some((drill) => drill.id === id)); if (!original) continue;
             let chapter = chapters.find((item) => item.id === original.id); if (!chapter) { chapter = { ...original, drills: [] }; chapters.push(chapter); }
             chapter.drills.push({ ...resolved.drill, instructions: unlockedInstructions(resolved.drill.instructions, unlockedStage(course.id, id)) });
           }
           const authoritative = remoteStateOrigin ? await fetchAuthoritativeCourse(remoteStateOrigin, course.id, request.headers?.['x-interview-time-zone']) : undefined; const tags = effectiveCourseTags(authoritative, getCourseTagOverride(course.id) ?? course.tags); const schedule = effectiveSchedule(course, getCourseScheduleOverrides()[course.id]); return send(response, 200, { ...course, chapters, tags, deadline: authoritative?.known ? authoritative.deadline : schedule.deadline, tier: course.company ? authoritative?.known ? authoritative.tier : schedule.tier : undefined });
         }
          if (method === 'GET' && parts.length === 3 && parts[1] === 'course-hints') {
            const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `No milestone hints for ${parts[2]}` });
            const current = await loadCourseHints(course.id); const drills = { ...(current?.drills ?? {}) }; let found = Boolean(current);
            for (const id of attemptDrillIds(course)) {
              const resolved = await resolveAttemptDrill(course.id, id, course); if (!resolved || resolved.drill.contentType !== 'ai-coding') continue;
              if (resolved.revision !== undefined) { const pinned = await loadCourseHintsAtRevision(course.id, resolved.revision); if (pinned?.drills[id]) { drills[id] = pinned.drills[id]; found = true; } else delete drills[id]; }
              if (drills[id]) drills[id] = drills[id].slice(0, unlockedStage(course.id, id));
            }
            if (!found) return send(response, 404, { error: `No milestone hints for ${parts[2]}` }); return send(response, 200, { courseId: course.id, drills });
          }
          if (method === 'GET' && parts.length === 5 && parts[1] === 'drills' && parts[4] === 'handoff') {
             if (!allowCodingRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Interviewer handoff is available only from this machine or its tailnet' });
             await ensureSandboxStarted();
            const resolved = await resolveAttemptDrill(parts[2], parts[3]); if (!resolved) return send(response, 404, { error: 'Unknown drill' }); const { course, drill, revision } = resolved; if (drill.contentType !== 'ai-coding') return send(response, 409, { error: 'This drill has no interviewer handoff' });
            await applyDueStages(course, drill, request.headers?.['x-interview-time-zone']); const attempt = getDrillAttempts(course.id, drill.id).at(-1); const stage = attempt ? Math.max(1, getAttemptStages(course.id, drill.id, attempt.attemptNumber).at(-1)?.stage ?? 1) : 1; const record = activeAiSandbox(course.id, drill.id); let tree = '(workspace not started)'; let commitSha: string | null = null; let files: WorkspaceFiles['files'] = [];
            if (record) { const execution = await sandboxManager.exec(record.id, { action: 'commit-files', timeZone: request.headers?.['x-interview-time-zone'] }); if (execution.exitCode !== 0) return send(response, 502, { error: 'Sandbox workspace commit failed' }); commitSha = parseCommitOutput(execution.output); files = parseWorkspaceFilesOutput(execution.output).files; tree = files.map((file) => file.path).sort().join('\n'); }
            const [templateBytes, rubricBytes] = await Promise.all([readCourseFileAtRevision(course.id, drill.handoffPath, revision), readCourseFileAtRevision(course.id, drill.rubricPath, revision)]); if (!templateBytes || !rubricBytes) throw new Error('Missing interviewer handoff or rubric'); const template = Buffer.from(templateBytes).toString('utf8'); const rubric = Buffer.from(rubricBytes).toString('utf8'); const values: Record<string, string> = { drillTitle: drill.title, stage: String(stage), stageCount: String(stageCount(drill.instructions)), fileTree: tree, rubric }; const prompt = template.replace(/\{\{(drillTitle|stage|stageCount|fileTree|rubric)\}\}/g, (_, key: string) => values[key]); return send(response, 200, { prompt, commitSha, files });
          }
         if (parts[1] === 'sandboxes') {
           if (!allowCodingRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Sandboxes are available only from this machine or its tailnet' });
           await ensureSandboxStarted();
           if (method === 'POST' && parts.length === 2) {
             if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
               const input = await body(request); const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort().join(',') : ''; if (!input || typeof input !== 'object' || Array.isArray(input) || !['courseId,drillId', 'attemptNumber,courseId,drillId,review'].includes(keys) || typeof (input as any).courseId !== 'string' || typeof (input as any).drillId !== 'string' || (keys !== 'courseId,drillId' && ((input as any).review !== true || !Number.isSafeInteger((input as any).attemptNumber) || (input as any).attemptNumber < 1))) return send(response, 400, { error: 'Request body must contain courseId and drillId, optionally with review and attemptNumber' });
               const review = keys !== 'courseId,drillId'; const reviewAttempt = review ? getDrillAttempts((input as any).courseId, (input as any).drillId).find((item) => item.attemptNumber === (input as any).attemptNumber && item.completedAt) : undefined; if (review && !reviewAttempt) return send(response, 409, { error: 'Completed attempt not found' });
                const resolved = await resolveSandboxDrill((input as any).courseId, (input as any).drillId, reviewAttempt); if (!('sourcePath' in resolved)) return send(response, resolved.error.status, { error: resolved.error.message });
               const sandbox = resolved as { course: { id: string }; drill: Drill; repo: { id: string; root: string }; sourcePath: string };
                const id = randomUUID(); const aiDrill = sandbox.drill.contentType === 'ai-coding' ? sandbox.drill : undefined; const ai = Boolean(aiDrill);
                const workspacePath = aiDrill ? aiDrill.workspacePath : `drills/${sandbox.course.id}/${sandbox.drill.id}`;
                 if (review && !ai) return send(response, 409, { error: 'Only AI attempts can be reviewed' });
                 const attempt = reviewAttempt ?? (ai ? getDrillAttempts(sandbox.course.id, sandbox.drill.id).at(-1) : undefined); if (ai && (!attempt || (!review && attempt.completedAt))) return send(response, 409, { error: 'Start a new attempt before opening the workspace' });
                const attemptNumber = attempt?.attemptNumber;
                 const existing = ai && !review ? activeAiSandbox(sandbox.course.id, sandbox.drill.id) : undefined; if (existing && await sandboxManager.isRunning(existing.id)) { const stage = Math.max(1, getAttemptStages(sandbox.course.id, sandbox.drill.id, attemptNumber!).at(-1)?.stage ?? 1); return send(response, 200, { id: existing.id, status: existing.status, url: `/sandbox/${existing.id}/?folder=${encodeURIComponent(existing.workspace)}`, attemptNumber, stage }); }
                  const record = await sandboxManager.create({ id, repoId: sandbox.repo.id, courseId: sandbox.course.id, drillId: sandbox.drill.id, kind: ai ? 'ai-coding' : 'coding', workspacePath, sourcePath: sandbox.drill.sourcePath, ...(sandbox.drill.contentType === 'coding' ? { testPath: sandbox.drill.testPath } : {}), ...(aiDrill?.acceptancePath ? { acceptancePath: aiDrill.acceptancePath } : {}), ...(attemptNumber ? { attemptNumber } : {}), ...(review ? { review: true } : {}), ...(contentSource() === 'db' ? { contentRevision: (resolved as { revision: number }).revision } : {}) }, ai);
                if (ai && !review) recordAttemptStage(sandbox.course.id, sandbox.drill.id, attemptNumber!, 1, 'start'); const stage = ai ? Math.max(1, getAttemptStages(sandbox.course.id, sandbox.drill.id, attemptNumber!).at(-1)?.stage ?? 1) : undefined;
                return send(response, record.id === id ? 201 : 200, { id: record.id, status: record.status, url: `/sandbox/${record.id}/?folder=${encodeURIComponent(record.workspace)}`, ...(ai ? { attemptNumber, stage } : {}) });
           }
           if (parts.length >= 3) {
             const id = parts[2]; const record = sandboxManager.get(id); if (!record) return send(response, 404, { error: 'Unknown sandbox' });
             if (method === 'GET' && parts.length === 3) { await sandboxManager.pollHealth?.(); return send(response, 200, { id: record.id, status: record.status, url: `/sandbox/${record.id}/?folder=${encodeURIComponent(record.workspace)}`, health: sandboxManager.health?.(record.id) ?? null }); }
              if (method === 'DELETE' && parts.length === 3) { await sandboxManager.remove(id, record.kind !== 'ai-coding'); return send(response, 200, { deleted: true }); }
             if (method === 'PUT' && parts.length === 4 && parts[3] === 'settings') {
               const input = await body(request); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'enabled' || typeof (input as any).enabled !== 'boolean') return send(response, 400, { error: 'Request body must contain only boolean enabled' });
               const execution = await sandboxManager.exec(id, { action: 'settings', enabled: (input as any).enabled }); if (execution.exitCode !== 0) return send(response, 502, { error: 'Sandbox settings update failed' }); return send(response, 200, { saved: true });
             }
              if (method === 'GET' && parts.length === 4 && parts[3] === 'export.md') {
                const execution = await sandboxManager.exec(id, { action: 'workspace-files' }); if (execution.exitCode !== 0) return send(response, 502, { error: 'Sandbox workspace files failed' }); const markdown = workspaceMarkdown(parseWorkspaceFilesOutput(execution.output)); response.statusCode = 200; response.setHeader('Content-Type', 'text/markdown; charset=utf-8'); response.setHeader('Content-Disposition', 'attachment; filename="workspace.md"'); response.end(markdown); return;
              }
               if (method === 'POST' && parts.length === 4 && (parts[3] === 'run' || parts[3] === 'submit')) {
                  if (record.review) return send(response, 409, { error: 'Review workspaces are read-only' });
                 const input = await body(request); const timeZone = input && typeof input === 'object' && !Array.isArray(input) ? (input as { timeZone?: unknown }).timeZone : undefined;
                 if (record.kind === 'ai-coding') {
                   const resolved = await resolveSandboxDrill(record.courseId, record.drillId); if (!('sourcePath' in resolved) || !resolved.course || !resolved.drill || resolved.drill.contentType !== 'ai-coding') return send(response, 409, { error: 'This is not an AI coding workspace' });
                   const course = resolved.course; const drill = resolved.drill as Extract<Drill, { contentType: 'ai-coding' }>; await applyDueStages(course, drill, timeZone); const attempt = getDrillAttempts(course.id, drill.id).at(-1); if (!attempt || attempt.completedAt) return send(response, 409, { error: 'The attempt is not open' }); const stage = Math.max(1, getAttemptStages(course.id, drill.id, attempt.attemptNumber).at(-1)?.stage ?? 1); const count = stageCount(drill.instructions);
                   if (parts[3] === 'submit' && stage < count) return send(response, 409, { error: 'Reveal the final requirement before submitting' });
                     const workspaceArgs = ['--mode', 'workspace', '--runner', drill.testRunner];
                     const acceptanceArgs = parts[3] === 'submit' && drill.acceptancePath ? ['--mode', 'acceptance', '--runner', drill.testRunner, '--acceptance', record.acceptance ?? '/opt/ir/acceptance', '--max-stage', String(stage)] : undefined;
                      const execution = await sandboxManager.exec(id, { action: 'capture-run', runs: acceptanceArgs ? [workspaceArgs, acceptanceArgs] : [workspaceArgs], timeZone }); if (execution.exitCode !== 0) throw Object.assign(new Error(execution.output.includes('IR_GIT_UNAVAILABLE: Git is required for workspace commits') ? 'Git is unavailable; workspace commits are required to run tests or submit' : 'Sandbox captured run failed'), { status: 502 }); const captured = parseCapturedRunOutput(execution.output, '', [record.workspace]); const workspaceResult = captured.results[0]; const acceptanceResult = captured.results[1]; const result = browserFacingAiResult(workspaceResult, acceptanceResult);
                       if (parts[3] === 'submit') { if (!passedResult(workspaceResult) || (acceptanceResult && !passedResult(acceptanceResult))) return send(response, 409, { ...result, error: 'Workspace and acceptance tests must all pass before submitting' }); addGitSubmission(course.id, drill.id, result, captured.commitSha, true); setProgress(course.id, drill.id, 'done'); completeDrillAttempt(course.id, drill.id); await sandboxManager.remove(id, false); }
                       await publishSandboxResult(course.id, drill.id, drill.workspacePath, resolved.repo.id === 'managed' ? join(resolved.repo.root, drill.workspacePath) : pathInRepo(resolved.repo as ReturnType<typeof requireRepoForCourse>, drill.workspacePath), result); return send(response, 200, result);
                 }
                 const resolved = await resolveCodingDrill(record.courseId, record.drillId); if (!('sourcePath' in resolved)) return send(response, resolved.error.status, { error: resolved.error.message });
                const coding = resolved as { course: { id: string }; drill: { id: string; sourcePath: string; testPath: string }; repo: { id: string; root: string }; sourcePath: string; testPath: string };
                if (contentSource() === 'db' && record.contentRevision !== (resolved as { revision: number }).revision) {
                  // Bind mounts cannot be retargeted while a container is running. Recreate
                  // the editor against the current protected test and retain its workspace/Git.
                  await sandboxManager.create({ id, repoId: 'managed', courseId: coding.course.id, drillId: coding.drill.id, kind: 'coding', workspacePath: `drills/${coding.course.id}/${coding.drill.id}`, sourcePath: coding.drill.sourcePath, testPath: coding.drill.testPath, contentRevision: (resolved as { revision: number }).revision });
                }
                 const relativeSource = contentSource() === 'db' ? relative(codingWorkspace(coding.course.id, coding.drill.id), coding.sourcePath).replaceAll('\\', '/') : relative(resolve(coding.repo.root, `drills/${coding.course.id}/${coding.drill.id}`), coding.sourcePath).replaceAll('\\', '/'); const relativeTest = contentSource() === 'db' ? relative(`drills/${coding.course.id}/${coding.drill.id}`, coding.drill.testPath).replaceAll('\\', '/') : relative(resolve(coding.repo.root, `drills/${coding.course.id}/${coding.drill.id}`), coding.testPath).replaceAll('\\', '/');
                const args = ['--mode', 'file', '--runner', coding.sourcePath.endsWith('.py') ? 'pytest' : 'vitest', '--source', relativeSource, '--test', relativeTest];
                 const execution = await sandboxManager.exec(id, { action: 'capture-run', runs: [args], timeZone } satisfies SandboxExecRequest); if (execution.exitCode !== 0) throw Object.assign(new Error(execution.output.includes('IR_GIT_UNAVAILABLE: Git is required for workspace commits') ? 'Git is unavailable; workspace commits are required to run tests or submit' : 'Sandbox captured run failed'), { status: 502 });
                  const workspacePath = `drills/${coding.course.id}/${coding.drill.id}`;
                  const captured = parseCapturedRunOutput(execution.output, workspacePath, [record.workspace]); const result = captured.results[0]; const workspaceFiles = captured.workspaceFiles;
                  const content = workspaceFiles.files.find((file) => file.path === coding.drill.sourcePath && !file.binary)?.content ?? '';
                  const stateUrl = `/api/progress/${encodeURIComponent(coding.course.id)}/${encodeURIComponent(coding.drill.id)}/submissions`;
                  const stateBody = { content, result, commitSha: captured.commitSha };
                if (parts[3] === 'submit') {
                  if (!(result.status === 'passed' && result.tests.length > 0 && result.tests.every((test) => test.status === 'passed'))) return send(response, 409, { ...result, error: 'All tests must pass before submitting' });
                   if (remoteStateOrigin) { const submissionResponse = await fetch(`${remoteStateOrigin}${stateUrl}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stateBody) }); if (!submissionResponse.ok) throw Object.assign(new Error('Authoritative state service could not store the submission'), { status: 502 }); }
                     else { addGitSubmission(coding.course.id, coding.drill.id, result, captured.commitSha); setProgress(coding.course.id, coding.drill.id, 'done'); completeDrillAttempt(coding.course.id, coding.drill.id); }
                 }
                await publishSandboxResult(coding.course.id, coding.drill.id, coding.drill.testPath, coding.testPath, result);
               return send(response, 200, result);
             }
             return send(response, 405, { error: 'Method not allowed' });
           }
         }
          if (parts.length === 5 && parts[1] === 'drills' && (parts[4] === 'source' || parts[4] === 'tests')) {
            if (!allowCodingRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Code editing and execution are available only from this machine or its tailnet' });
           const resolved = await resolveCodingDrill(parts[2], parts[3]);
           if (!('sourcePath' in resolved)) return send(response, resolved.error.status, { error: resolved.error.message });
             const coding = resolved as { course: { id: string }; drill: { id: string; testPath: string }; repo: { root: string }; revision?: number; sourcePath: string; testPath: string };
           if (parts[4] === 'source' && method === 'GET') return send(response, 200, { content: await sourceReader(coding.sourcePath), filename: basename(coding.sourcePath) });
              if (parts[4] === 'tests' && method === 'GET') return send(response, 200, { files: [{ path: relative(coding.repo.root, coding.testPath).replaceAll('\\', '/'), filename: basename(coding.testPath), content: contentSource() === 'db' ? await retryMissingRevision(async () => { const root = await materializeCourse(await contentDatabase(), coding.course.id, coding.revision!, undefined, coding.drill.testPath); return sourceReader(join(root, coding.drill.testPath)); }) : await sourceReader(coding.testPath) }] });
           return send(response, 405, { error: 'Method not allowed' });
         }
         if (method === 'GET' && parts.length === 3 && parts[1] === 'progress') { const course = await loadCourse(parts[2]); return course ? send(response, 200, getProgress(parts[2])) : send(response, 404, { error: `Unknown course: ${parts[2]}` }); }
          if (method === 'GET' && parts.length === 3 && parts[1] === 'attempts') {
            const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` });
            const aiDrills: Array<Extract<Drill, { contentType: 'ai-coding' }>> = [];
            for (const id of attemptDrillIds(course)) { const resolved = await resolveAttemptDrill(course.id, id, course); if (resolved?.drill.contentType === 'ai-coding') { await applyDueStages(resolved.course, resolved.drill, request.headers?.['x-interview-time-zone']); aiDrills.push(resolved.drill); } }
            const attempts = getCourseDrillAttempts(course.id); for (const drill of aiDrills) attempts[drill.id] = await decorateAiAttempts(course.id, drill, attempts[drill.id] ?? []);
            return send(response, 200, { courseId: course.id, attempts });
          }
          if (method === 'POST' && parts.length === 4 && parts[1] === 'attempts') {
            const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` });
            const resolved = await resolveAttemptDrill(course.id, parts[3], course); if (!resolved) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const drill = resolved.drill;
            if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
             const input = await body(request); const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort().join(',') : ''; const action = keys === 'action' || keys === 'action,reason' || keys === 'action,reason,timeZone' ? (input as { action?: unknown }).action : undefined;
             if (action === 'advance') { if (drill.contentType !== 'ai-coding' || (keys !== 'action,reason' && keys !== 'action,reason,timeZone') || !['manual', 'timer'].includes(String((input as any).reason))) return send(response, 400, { error: 'advance requires reason manual or timer' }); return send(response, 200, await advanceAiStage(resolved.course, drill, (input as any).reason, (input as any).timeZone)); }
             if (keys !== 'action' || (action !== 'start' && action !== 'pause' && action !== 'complete')) return send(response, 400, { error: 'action must be start, pause, complete, or advance' });
               if (action === 'start' && drill.contentType === 'ai-coding') { await ensureSandboxStarted(); const latest = getDrillAttempts(course.id, drill.id).at(-1); if (!latest || latest.completedAt) { for (const record of sandboxManager.all().filter((item) => item.kind === 'ai-coding' && item.courseId === course.id && item.drillId === drill.id)) await sandboxManager.remove(record.id, false); } }
             const revision = action === 'start' && contentSource() === 'db' ? currentContentRevision(await contentDatabase(), course.id) : undefined;
             const attempts = action === 'start' ? startDrillAttempt(course.id, drill.id, new Date(), revision) : action === 'pause' ? pauseDrillAttempt(course.id, drill.id) : completeDrillAttempt(course.id, drill.id);
             const decorated = drill.contentType === 'ai-coding' ? await decorateAiAttempts(course.id, drill, attempts, action === 'start') : attempts;
             return send(response, 200, { attempts: decorated });
          }
          if (parts.length === 5 && parts[1] === 'progress' && parts[4] === 'hints') {
           const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` });
          const resolved = await resolveAttemptDrill(course.id, parts[3], course); if (!resolved) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const drill = resolved.drill;
           if (method === 'GET') { const authored = (await loadCourseHintsAtRevision(course.id, resolved.revision))?.drills[drill.id] ?? []; const allowed = new Set((drill.contentType === 'ai-coding' ? authored.slice(0, unlockedStage(course.id, drill.id)) : authored).map((item) => item.title)); return send(response, 200, { revealed: getRevealedHints(course.id, drill.id).filter((title) => allowed.has(title)) }); }
          if (method === 'PUT') {
            if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
            const input = await body(request); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'hint' || typeof (input as { hint?: unknown }).hint !== 'string') return send(response, 400, { error: 'Request body must contain only string hint' });
             const hint = (input as { hint: string }).hint; const authored = (await loadCourseHintsAtRevision(course.id, resolved.revision))?.drills[drill.id] ?? []; const unlocked = drill.contentType === 'ai-coding' ? authored.slice(0, unlockedStage(course.id, drill.id)) : authored;
             if (!unlocked.some((item) => item.title === hint)) return send(response, 404, { error: 'Hint is not available for the current requirement' });
            return send(response, 200, { revealed: revealHint(course.id, drill.id, hint) });
          }
           return send(response, 405, { error: 'Method not allowed' });
         }
         if (parts.length === 5 && parts[1] === 'progress' && parts[4] === 'submissions') {
           if (!allowCodingRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Submission history is available only from this machine or its tailnet' });
           const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` });
           const drill = drillInCourse(course, parts[3]); if (!drill) return send(response, 404, { error: `Unknown drill: ${parts[3]}` });
              const aiCoding = drill.contentType === 'ai-coding';
              if (method === 'GET') return send(response, 200, { submissions: getSubmissions(course.id, drill.id, aiCoding) });
            if (method === 'POST') {
             if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
             const input = await body(request);
              const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort().join(',') : '';
               if (!input || typeof input !== 'object' || Array.isArray(input) || keys !== 'commitSha,content,result' || typeof (input as { content?: unknown }).content !== 'string') return send(response, 400, { error: 'Request body must contain content, result, and commitSha' });
              const content = (input as { content: string }).content; if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) return send(response, 413, { error: 'Submission content is too large' });
               const result = submissionResult((input as { result?: unknown }).result); if (!result) return send(response, 400, { error: 'Submission result is invalid' });
               let commitSha: string; try { commitSha = workspaceCommitSha((input as { commitSha?: unknown }).commitSha); } catch { return send(response, 400, { error: 'Invalid workspace commit' }); } return send(response, 201, { submissions: addGitSubmission(course.id, drill.id, result, commitSha, aiCoding) });
           }
           return send(response, 405, { error: 'Method not allowed' });
          }
          if (parts.length === 6 && parts[1] === 'progress' && parts[4] === 'submissions') {
           if (!allowCodingRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Submission history is available only from this machine or its tailnet' });
           const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` });
           const drill = drillInCourse(course, parts[3]); if (!drill) return send(response, 404, { error: `Unknown drill: ${parts[3]}` });
           const id = Number(parts[5]); if (!Number.isSafeInteger(id) || id < 1 || String(id) !== parts[5]) return send(response, 404, { error: 'Unknown submission' });
           if (method === 'PATCH') {
             if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers?.['content-type'] ?? ''))) return send(response, 415, { error: 'Content-Type must be application/json' });
             const input = await body(request); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'name') return send(response, 400, { error: 'Request body must contain only name' });
             let name: string | null; try { name = submissionName((input as { name?: unknown }).name); } catch (error) { return send(response, 400, { error: (error as Error).message }); }
               const submissions = renameSubmission(course.id, drill.id, id, name, drill.contentType === 'ai-coding'); return submissions ? send(response, 200, { submissions }) : send(response, 404, { error: 'Unknown submission' });
           }
             if (method === 'DELETE') { const submissions = deleteSubmission(course.id, drill.id, id, drill.contentType === 'ai-coding'); return submissions ? send(response, 200, { submissions }) : send(response, 404, { error: 'Unknown submission' }); }
           return send(response, 405, { error: 'Method not allowed' });
         }
           if (method === 'GET' && parts.length === 3 && parts[1] === 'recall-progress') {
             const course = await loadCourse(parts[2]);
             if (!course || course.type !== 'map-recall') return send(response, 404, { error: 'Unknown map + recall course' });
             return send(response, 200, await recallSummaries(course));
           }
            if (method === 'GET' && parts.length === 4 && parts[1] === 'map-recall') {
            const course = await loadCourse(parts[2]); const drill = course && drillInCourse(course, parts[3]);
              if (!course || !drill || (drill.contentType !== 'map' && !isWhiteboardDrill(drill) && !(drill.contentType === 'recall' && course.type === 'map-recall'))) return send(response, 404, { error: 'Unknown map or recall lesson' });
            const content = await readMapRecall(course, drill);
            return send(response, 200, typeof content === 'string' ? { source: content } : content);
           }
           if (parts.length === 4 && parts[1] === 'map-fold-state') {
             const course = await loadCourse(parts[2]); const drill = course && drillInCourse(course, parts[3]);
              if (!course || !drill || drill.contentType !== 'map') return send(response, 404, { error: 'Unknown map lesson' });
             if (method === 'GET') return send(response, 200, { folds: getMapFoldState(course.id, drill.id) });
             if (method === 'PUT') {
               const input = await body(request);
               if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'folds,sequence,writer') return send(response, 400, { error: 'Map state requires folds, writer and sequence' });
               const { folds, writer, sequence } = input as { folds: unknown; writer: unknown; sequence: unknown };
               if (typeof writer !== 'string' || !MAP_FOLD_WRITER.test(writer) || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || (folds !== null && (!folds || typeof folds !== 'object' || Array.isArray(folds) || Object.entries(folds).length > MAP_FOLD_MAX_NODES || Object.entries(folds).some(([key, value]) => !MAP_FOLD_KEY.test(key) || typeof value !== 'boolean')))) return send(response, 400, { error: 'Invalid map folds' });
               return send(response, 200, setMapFoldState(course.id, drill.id, writer, sequence, folds as Record<string, boolean> | null));
             }
             return send(response, 405, { error: 'Method not allowed' });
           }
            if (parts[1] === 'map-highlights' && (parts.length === 4 || parts.length === 5)) {
              const course = await loadCourse(parts[2]); const drill = course && drillInCourse(course, parts[3]);
              if (!course || !drill || drill.contentType !== 'map') return send(response, 404, { error: 'Unknown map lesson' });
              if (method === 'GET' && parts.length === 4) return send(response, 200, { highlights: getMapHighlights(course.id, drill.id) });
              if (parts.length === 5 && !MAP_HIGHLIGHT_ID.test(parts[4])) return send(response, 400, { error: 'Invalid highlight id' });
              if (method === 'PUT' && parts.length === 5) {
                const input = await body(request, 48 * 1024);
                if (!validMapHighlight(input) || input.id !== parts[4]) return send(response, 400, { error: 'Invalid highlight' });
                const result = addMapHighlight(course.id, drill.id, input);
                if (result !== 'added') return send(response, 409, { error: result === 'full' ? 'Too many highlights' : result === 'removed' ? 'Highlight was removed' : 'Highlight id already exists', ...(result === 'removed' ? { removed: true } : {}) });
                return send(response, 200, { highlight: input });
              }
              if (method === 'DELETE' && parts.length === 5) { removeMapHighlight(course.id, drill.id, parts[4]); return send(response, 200, { removed: true }); }
              return send(response, 405, { error: 'Method not allowed' });
            }
           if (parts[1] === 'outline-state' && (parts.length === 4 || parts.length === 5)) {
            const course = await loadCourse(parts[2]); const drill = course && drillInCourse(course, parts[3]);
            if (course?.type === 'map-recall') {
              if (!drill || drill.contentType !== 'recall') return send(response, 404, { error: 'Unknown recall lesson' });
              const lesson = await readMapRecall(course, drill) as RecallLesson;
              const ids = new Set(lesson.questions.map((question) => question.id));
              const visible = () => Object.fromEntries(Object.entries(getOutlineState(course.id, drill.id)).filter(([id]) => ids.has(id)));
              if (method === 'GET' && parts.length === 4) return send(response, 200, visible());
              if (method === 'PUT' && parts.length === 5) {
                const input = await body(request);
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'checked' || typeof (input as { checked?: unknown }).checked !== 'boolean') return send(response, 400, { error: 'Recall state requires only a checked boolean' });
                const checked = (input as { checked: boolean }).checked;
                if (parts[4] === 'bulk') { if (checked) return send(response, 400, { error: 'Bulk recall state may only clear checks' }); clearRecallChecks(course.id, drill.id); }
                else { if (!ids.has(parts[4])) return send(response, 404, { error: 'Unknown recall question' }); setOutlineNode(course.id, drill.id, parts[4], { checked }); }
                return send(response, 200, visible());
              }
              return send(response, 405, { error: 'Method not allowed' });
            }
          }
            if (parts[1] === 'recall-whiteboards' && (parts.length === 4 || parts.length === 5)) {
              const result = await whiteboards(parts[2], parts[3]);
              if (!result) return send(response, 404, { error: 'Unknown recall lesson' });
              if (method === 'GET' && parts.length === 4) return send(response, 200, { ...result, legacy: result.questions.map(({ id }) => ({ id, snapshot: getRecallWhiteboard(parts[2], parts[3], id) })) });
              if (method === 'PUT' && parts.length === 4) {
                const snapshot = whiteboardInput(await body(request));
                if (!snapshot) return send(response, 400, { error: 'Invalid whiteboard snapshot' });
                const match = request.headers['if-match']; const none = request.headers['if-none-match'];
                if (match === undefined && none === undefined) return send(response, 428, { error: 'Whiteboard writes require If-Match or If-None-Match: *' });
                const revision = typeof match === 'string' ? /^"([1-9]\d*)"$/.exec(match) : null;
                if ((match !== undefined && none !== undefined) || (none !== undefined && none !== '*') || (match !== undefined && (!revision || !Number.isSafeInteger(Number(revision[1]))))) return send(response, 400, { error: 'Invalid whiteboard precondition' });
                const baseUpdatedAt = revision ? Number(revision[1]) : null;
                if (!setDrillWhiteboard(parts[2], parts[3], snapshot, baseUpdatedAt)) return send(response, 409, { error: 'Whiteboard changed elsewhere', snapshot: getDrillWhiteboard(parts[2], parts[3]) });
                return send(response, 200, { updatedAt: snapshot.updatedAt });
              }
              return send(response, 405, { error: 'Method not allowed' });
            }
          if (method === 'GET' && parts.length === 4 && parts[1] === 'reading') {
            const course = await loadCourse(parts[2]); const drill = course && drillInCourse(course, parts[3]);
            if (!course || !drill || drill.contentType !== 'reading' || drill.outlinePath || !drill.sourcePath.endsWith('.md')) return send(response, 404, { error: 'Unknown reading lesson' });
            const bytes = await contentReader().readCourseFile(course.id, drill.sourcePath);
            if (!bytes) return send(response, 404, { error: 'Reading content not found' });
            return send(response, 200, { markdown: Buffer.from(bytes).toString('utf8') });
          }
          if (method === 'GET' && parts.length === 4 && parts[1] === 'outlines') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (!drillInCourse(course, parts[3])) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const outline = await loadOutline(parts[2], parts[3]); return outline ? send(response, 200, outline) : send(response, 404, { error: `No outline for ${parts[3]}` }); }
        if (method === 'GET' && parts.length === 4 && parts[1] === 'outline-state') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (!drillInCourse(course, parts[3])) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const outline = await loadOutline(parts[2], parts[3]); if (!outline) return send(response, 404, { error: `No outline for ${parts[3]}` }); return send(response, 200, visibleState(outline, getOutlineState(parts[2], parts[3]))); }
         if (method === 'PUT' && parts.length === 5 && parts[1] === 'outline-state' && parts[4] === 'bulk') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (!drillInCourse(course, parts[3])) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const outline = await loadOutline(parts[2], parts[3]); if (!outline) return send(response, 404, { error: `No outline for ${parts[3]}` }); const input = await body(request) as Record<string, unknown>; if (typeof input.folded !== 'boolean' || (input.nodeIds !== undefined && (!Array.isArray(input.nodeIds) || input.nodeIds.some((id: unknown) => typeof id !== 'string')))) return send(response, 400, { error: 'bulk outline state requires folded and optional nodeIds' }); const nodeIds = (input.nodeIds as string[] | undefined) ?? collectNodeIds(outline.nodes); if (nodeIds.some((id) => !nodeInOutline(outline, id))) return send(response, 404, { error: 'Node is not present in outline' }); setOutlineNodesBulk(parts[2], parts[3], nodeIds, { folded: input.folded as boolean }); return send(response, 200, visibleState(outline, getOutlineState(parts[2], parts[3]))); }
         if (method === 'PUT' && parts.length === 5 && parts[1] === 'outline-state') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (!drillInCourse(course, parts[3])) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const outline = await loadOutline(parts[2], parts[3]); if (!outline) return send(response, 404, { error: `No outline for ${parts[3]}` }); if (!nodeInOutline(outline, parts[4])) return send(response, 404, { error: `Unknown outline node: ${parts[4]}` }); const input = await body(request) as Record<string, unknown>; if ((input.folded === undefined && input.checked === undefined) || (input.folded !== undefined && typeof input.folded !== 'boolean') || (input.checked !== undefined && typeof input.checked !== 'boolean')) return send(response, 400, { error: 'outline state must contain folded and/or checked booleans' }); setOutlineNode(parts[2], parts[3], parts[4], { ...(input.folded === undefined ? {} : { folded: input.folded as boolean }), ...(input.checked === undefined ? {} : { checked: input.checked as boolean }) }); return send(response, 200, visibleState(outline, getOutlineState(parts[2], parts[3]))); }
           if (method === 'PUT' && parts.length === 4 && parts[1] === 'progress') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (!await resolveAttemptDrill(course.id, parts[3], course)) return send(response, 404, { error: `Unknown drill: ${parts[3]}` }); const drill = drillInCourse(course, parts[3]); const whiteboard = isWhiteboardDrill(drill); if (course.type === 'map-recall' && !whiteboard) return send(response, 409, { error: 'Map + recall progress is recorded by recall checks' }); const input = await body(request); if (!input || typeof input !== 'object' || !('status' in input) || !['not-started', 'in-progress', 'blocked', 'done'].includes(input.status as string)) return send(response, 400, { error: 'status must be not-started, in-progress, blocked, or done' }); if (whiteboard && input.status !== 'not-started' && input.status !== 'done') return send(response, 400, { error: 'Whiteboard status must be not-started or done' }); const notes = 'notes' in input && typeof input.notes === 'string' ? input.notes : whiteboard ? getProgress(course.id)[parts[3]]?.notes : undefined; if (input.status === 'done' && !whiteboard) completeDrillAttempt(parts[2], parts[3]); return send(response, 200, setProgress(parts[2], parts[3], input.status as ProgressStatus, notes)); }
        if (method === 'POST' && parts.length === 4 && parts[1] === 'progress' && parts[3] === 'reset') { const course = await loadCourse(parts[2]); if (!course) return send(response, 404, { error: `Unknown course: ${parts[2]}` }); if (course.type === 'map-recall') return send(response, 409, { error: 'Reset recall checks from the individual lesson' }); const input = await body(request); const chapterId = input && typeof input === 'object' && 'chapterId' in input && typeof input.chapterId === 'string' ? input.chapterId : undefined; if (chapterId !== undefined && !course.chapters.some((chapter) => chapter.id === chapterId)) return send(response, 400, { error: `Unknown chapter: ${chapterId}` }); return send(response, 200, await resetProgress(parts[2], chapterId)); }
        if (method === 'GET' && parts.length === 3 && parts[1] === 'test-results' && parts[2] === 'stream') {
          if (!allowStreamRequest(request.socket.remoteAddress)) return send(response, 403, { error: 'Test result stream is available only from this machine or its tailnet' });
          if (subscribers.size >= 32) return send(response, 503, { error: 'Too many test result subscribers' });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/event-stream');
          response.setHeader('Cache-Control', 'no-cache');
          response.setHeader('Connection', 'keep-alive');
          response.setHeader('X-Accel-Buffering', 'no');
          response.write('retry: 3000\n: connected\n\n');
          streamStarted = true;
          const subscriber = response as unknown as ResultSubscriber;
          const state: SubscriberState = { queue: [], blocked: false, initializing: true, pendingUpdates: [], closed: false };
          subscriberStates.set(subscriber, state);
          subscribers.add(subscriber);
          const removeSubscriber = () => {
            closeSubscriber(subscriber);
          };
          streamCleanup = removeSubscriber;
           state.lifecycleListener = removeSubscriber;
           (response as any).on?.('close', state.lifecycleListener);
           (response as any).on?.('error', state.lifecycleListener);
          try {
             // Ingest the legacy report once for backwards-compatible startup
             // snapshots. Correctness never depends on this shared artifact: live
             // updates come only from the focused runner above.
             await persistReport(reportFile, false, subscribers, sendUpdate);
             writeSubscriber(subscriber, `event: snapshot\ndata: ${JSON.stringify(await manifestSnapshot())}\n\n`);
          } catch {
            closeSubscriber(subscriber);
            try { subscriber.end?.(); } catch { try { subscriber.destroy?.(); } catch {} }
            return;
          }
          if (!subscribers.has(subscriber)) return;
          state.initializing = false;
          const queued = state.queue.splice(0);
          for (const chunk of queued) writeSubscriber(subscriber, chunk);
          state.pendingUpdates.splice(0).forEach((update) => sendUpdate(subscriber, update));
          state.heartbeat = setInterval(() => { if (!writeSubscriber(subscriber, ': heartbeat\n\n')) closeSubscriber(subscriber); }, 20_000);
          heartbeatIntervals.add(state.heartbeat);
          return;
        }
        if (method === 'GET' && parts.length === 2 && parts[1] === 'test-results') {
          // This endpoint is deliberately read-only. The stream performs initial
          // artifact ingestion; a GET must not repeatedly replay an old report.
          return send(response, 200, await manifestSnapshot());
        }
        return send(response, 404, { error: 'Not found' });
       } catch (error) {
         // SSE headers are irreversible. Never turn an initialization failure into a
         // second JSON response after the stream has begun.
         if (streamStarted || (response as any).headersSent) {
           streamCleanup?.();
           try { response.end(); } catch { try { (response as any).destroy?.(); } catch {} }
           return;
         }
          return send(response, Number((error as { status?: number }).status ?? 400), { error: error instanceof Error ? error.message : 'Request failed' });
       }
    });
  }, closeBundle: stop };
}
