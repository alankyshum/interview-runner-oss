import { Alert, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { Button, Panel, SaveStatus, SplitPane, type SaveStatusProps } from '../ui';
import { CaptureUpdateAction, Excalidraw, exportToSvg, hashElementsVersion } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecallLesson } from '../../server/mapRecall';
import { HoldForHint } from '../course/MilestoneHint';
import { combineLegacyScenes, type WhiteboardScene, type WhiteboardSnapshot } from './whiteboardMigration';
import { WhiteboardMarkdown } from './WhiteboardMarkdown';
import './recallWhiteboard.css';

type Change = NonNullable<ExcalidrawProps['onChange']>;
type Scene = WhiteboardScene;
type Snapshot = WhiteboardSnapshot & { migrationPending?: true; legacySources?: Record<string, number>; baseUpdatedAt?: number | null; pendingSync?: true };
type Status = 'loading' | 'ready' | 'saving' | 'local' | 'syncing' | 'synced' | 'failed' | 'load-failed' | 'local-failed' | 'conflict';
const LOCAL_DELAY = 1000;
const SYNC_DELAY = 2500;
const MAX_WAIT = 12000;
const KEEPALIVE_LIMIT = 64 * 1024;
const fingerprint = (scene: Scene) => JSON.stringify([hashElementsVersion(scene.elements), Object.keys(scene.files).sort(), scene.appState.viewBackgroundColor ?? null]);

// Excalidraw resolves font assets at runtime; Vite copies them to this same-origin path.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${window.location.origin}/excalidraw-assets/`;

function localKey(course: string, drill: string) { return `recall-whiteboard:${JSON.stringify([course, drill])}`; }
function legacyKey(course: string, drill: string, question: string) { return `recall-whiteboard:${JSON.stringify([course, drill, question])}`; }
// Keep unsaved scenes for this tab even when their canvas or lesson unmounts.
const pendingScenes = new Map<string, Snapshot>();
const beforeUnload = (event: BeforeUnloadEvent) => { if (pendingScenes.size) { event.preventDefault(); event.returnValue = ''; } };
function remember(key: string, snapshot: Snapshot) { if ((pendingScenes.get(key)?.updatedAt ?? 0) <= snapshot.updatedAt) pendingScenes.set(key, snapshot); window.addEventListener('beforeunload', beforeUnload); }
function savedLocally(key: string, snapshot: Snapshot) {
  if ((pendingScenes.get(key)?.updatedAt ?? Infinity) <= snapshot.updatedAt) pendingScenes.delete(key);
  if (!pendingScenes.size) window.removeEventListener('beforeunload', beforeUnload);
}
class InvalidLocalWhiteboard extends Error {}
class UnsafeLegacyWhiteboard extends Error {}
function readLocal(key: string): Snapshot | null {
  const raw = localStorage.getItem(key); if (raw === null) return null;
  let value: Snapshot;
  try { value = JSON.parse(raw) as Snapshot; } catch { throw new InvalidLocalWhiteboard('Invalid local whiteboard'); }
  if (!value || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !Array.isArray(value.scene?.elements) || !value.scene.appState || !value.scene.files || typeof value.svg !== 'string' || (value.migrationPending !== undefined && value.migrationPending !== true) || (value.pendingSync !== undefined && value.pendingSync !== true) || (value.baseUpdatedAt !== undefined && value.baseUpdatedAt !== null && (!Number.isSafeInteger(value.baseUpdatedAt) || value.baseUpdatedAt < 1)) || (value.legacySources !== undefined && (!value.legacySources || typeof value.legacySources !== 'object' || Array.isArray(value.legacySources) || Object.values(value.legacySources).some((time) => !Number.isSafeInteger(time) || time < 0)))) throw new InvalidLocalWhiteboard('Invalid local whiteboard');
  return value;
}

export default function RecallWhiteboard({ lesson, questionsCollapsed, editorPercent = 65, onEditorPercentChange }: { lesson: RecallLesson; questionsCollapsed: boolean; editorPercent?: number; onEditorPercentChange?: (value: number) => void }) {
  const hintKey = `recall-whiteboard-hints:${JSON.stringify([lesson.courseId, lesson.drillId])}`;
  const [unlocked, setUnlocked] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem(hintKey) ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; } catch { return []; } });
  const [hintError, setHintError] = useState('');
  const unlock = (id: string) => { const next = [...new Set([...unlocked, id])]; setUnlocked(next); try { localStorage.setItem(hintKey, JSON.stringify(next)); setHintError(''); } catch { setHintError('Hint unlock could not be saved locally.'); } };
  return <SplitPane className="recall-whiteboard" role="region" aria-label="Whiteboard practice workspace" value={editorPercent} valueSide="second" onChange={(value) => onEditorPercentChange?.(value)} min={45} max={80} resetValue={65} label="Resize question and whiteboard" visiblePane={questionsCollapsed ? 'second' : undefined}>
    <Panel id="whiteboard-questions" className="whiteboard-question-pane" label="Question" scrollable padding="sm" hidden={questionsCollapsed} inert={questionsCollapsed} aria-hidden={questionsCollapsed || undefined}>
      <Text component="h2" fw={700} size="xl" mb="sm">Question</Text>{hintError && <Alert color="orange">{hintError}</Alert>}
      <Stack gap="md">{lesson.questions.map((question, index) => {
        const title = `Milestone ${index + 1}`;
        return <Panel component="section" key={question.id} label={title} padding="md" style={{ background: 'var(--ir-color-canvas)' }}>
          <HoldForHint title={title} headingLevel={3} allowWrap hint={{ title, approach: question.hint ?? 'Consider the question before revealing the answer.', solution: question.answer }} initiallyUnlocked={unlocked.includes(question.id)} initiallyVisible={unlocked.includes(question.id)} onUnlock={() => unlock(question.id)} renderHintText={(source) => <WhiteboardMarkdown source={source} />} />
          <WhiteboardMarkdown source={question.prompt} />
          {question.expectation && <><Text fw={600} mt="sm">Expected on the board</Text><WhiteboardMarkdown source={question.expectation} /></>}
        </Panel>;
      })}</Stack>
    </Panel>
    <QuestionCanvas lesson={lesson} />
  </SplitPane>;
}

function QuestionCanvas({ lesson }: { lesson: RecallLesson }) {
  const { courseId, drillId } = lesson;
  const theme = useComputedColorScheme('light', { getInitialValueInEffect: false });
  const path = `/api/recall-whiteboards/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}`;
  const key = localKey(courseId, drillId);
  const [initial, setInitial] = useState<Snapshot | null | undefined>();
  const [status, setStatus] = useState<Status>('loading');
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const current = useRef<Snapshot | null>(null);
  const currentFingerprint = useRef<string | null>(null);
  const syncedFingerprint = useRef<string | null>(null);
  const viewSignature = useRef('');
  const firstChange = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canvas = useRef<HTMLDivElement>(null);
  const statusOverlay = useRef<HTMLDivElement>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const active = useRef(true);
  const localOK = useRef(true);
  const localSeen = useRef<string | null>(null);
  const localDirty = useRef(false);
  const dirty = useRef(false);
  const baseUpdatedAt = useRef<number | null>(null);
  const conflictRemote = useRef<Snapshot | null | undefined>(undefined);
  const syncing = useRef(false);
  const requestInFlight = useRef(false);
  const pageHiding = useRef(false);
  const finalSent = useRef<string | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const [fitInitial, setFitInitial] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const initialData = useMemo(() => initial ? { ...initial.scene, scrollToContent: fitInitial } : undefined, [initial, fitInitial]);
  const setApi = useCallback((instance: ExcalidrawImperativeAPI) => { api.current = instance; }, []);
  const localSave = useCallback((value: Snapshot, replaceSeen = false) => {
    try {
      const raw = localStorage.getItem(key);
      const previous = readLocal(key);
      if (raw !== localSeen.current || (previous && previous.updatedAt > value.updatedAt && !replaceSeen)) throw new Error('A newer local scene exists');
      const encoded = JSON.stringify(value); localStorage.setItem(key, encoded); localSeen.current = encoded; localDirty.current = false; savedLocally(key, value); localOK.current = true; return true;
    }
    catch { remember(key, value); localOK.current = false; if (active.current) setStatus('local-failed'); return false; }
  }, [key]);
  const flushLocal = useCallback(() => {
    clearTimeout(localTimer.current);
    localTimer.current = undefined;
    if (current.current && (localDirty.current || !localOK.current)) return localSave(current.current, !dirty.current);
    return true;
  }, [localSave]);
  const adopt = useCallback((remote: Snapshot | null) => {
    const previous = current.current;
    if (remote) {
      const clean: Snapshot = { ...remote, baseUpdatedAt: remote.updatedAt, ...(previous?.legacySources ? { legacySources: previous.legacySources } : {}) };
      if (!localSave(clean, true)) return;
      const oldFiles = previous?.scene.files ?? {};
      const replaceFiles = JSON.stringify(Object.keys(oldFiles).sort()) !== JSON.stringify(Object.keys(remote.scene.files).sort()) || Object.entries(remote.scene.files).some(([id, file]) => JSON.stringify(oldFiles[id]) !== JSON.stringify(file));
      current.current = clean; baseUpdatedAt.current = remote.updatedAt; dirty.current = false; conflictRemote.current = undefined; firstChange.current = true; currentFingerprint.current = null; syncedFingerprint.current = null;
      pendingScenes.delete(key); if (!pendingScenes.size) window.removeEventListener('beforeunload', beforeUnload);
      if (api.current && !replaceFiles) { api.current.addFiles(Object.values(remote.scene.files)); api.current.updateScene({ elements: remote.scene.elements, appState: remote.scene.appState as Parameters<Change>[1], captureUpdate: CaptureUpdateAction.NEVER }); }
      else { api.current = null; setInitial(clean); setCanvasVersion((version) => version + 1); }
      setStatus('synced');
    } else {
      try { if (localStorage.getItem(key) !== localSeen.current) throw new Error('A newer local scene exists'); localStorage.removeItem(key); localSeen.current = null; }
      catch { if (previous) remember(key, previous); setStatus('local-failed'); return; }
      pendingScenes.delete(key); if (!pendingScenes.size) window.removeEventListener('beforeunload', beforeUnload);
      current.current = null; baseUpdatedAt.current = null; dirty.current = false; localDirty.current = false; localOK.current = true; conflictRemote.current = undefined; firstChange.current = true; currentFingerprint.current = null; syncedFingerprint.current = null; api.current = null; setInitial(null); setCanvasVersion((version) => version + 1); setStatus('ready');
    }
  }, [key, localSave]);
  const sync = useCallback(async () => {
    if (syncing.current || !dirty.current || conflictRemote.current !== undefined || !current.current) return;
    clearTimeout(timer.current); clearTimeout(maxTimer.current); timer.current = undefined; maxTimer.current = undefined;
    const snapshot: Snapshot = JSON.parse(JSON.stringify(current.current)) as Snapshot;
    const sentFingerprint = currentFingerprint.current ?? fingerprint(snapshot.scene);
    const base = baseUpdatedAt.current; syncing.current = true; let succeeded = false;
    try {
      const visible = snapshot.scene.elements.filter((element) => !element.isDeleted);
      const svg = visible.length ? (await exportToSvg({ elements: visible, appState: snapshot.scene.appState, files: snapshot.scene.files })).outerHTML : '';
      if (pageHiding.current) return;
      const request = fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(base === null ? { 'If-None-Match': '*' } : { 'If-Match': `"${base}"` }) }, body: JSON.stringify({ scene: snapshot.scene, svg, updatedAt: snapshot.updatedAt }) });
      requestInFlight.current = true; if (active.current && localOK.current) setStatus('syncing');
      const response = await request;
      if (response.status === 409) {
        const conflict = await response.json() as { snapshot?: Snapshot | null };
        if (conflict.snapshot === undefined) throw new Error('Invalid conflict response');
        if (conflict.snapshot?.updatedAt === snapshot.updatedAt && fingerprint(conflict.snapshot.scene) === sentFingerprint) succeeded = true;
        else if (!dirty.current || (syncedFingerprint.current !== null && currentFingerprint.current === syncedFingerprint.current)) { if (active.current) adopt(conflict.snapshot); return; }
        else { conflictRemote.current = conflict.snapshot; if (active.current) setStatus('conflict'); return; }
      } else {
        if (!response.ok) throw new Error(`Sync failed (${response.status})`);
        const confirmation = await response.json() as { updatedAt?: number };
        if (confirmation.updatedAt !== snapshot.updatedAt) throw new Error('Invalid sync confirmation');
        succeeded = true;
      }
      if (succeeded && current.current) {
        baseUpdatedAt.current = snapshot.updatedAt; syncedFingerprint.current = sentFingerprint;
        dirty.current = currentFingerprint.current !== sentFingerprint;
        const latest: Snapshot = { ...current.current, svg, baseUpdatedAt: snapshot.updatedAt, ...(dirty.current ? { pendingSync: true as const } : {}) };
        if (dirty.current && latest.updatedAt <= snapshot.updatedAt) latest.updatedAt = Math.max(Date.now(), snapshot.updatedAt + 1);
        if (!dirty.current) { delete latest.pendingSync; delete latest.migrationPending; }
        current.current = latest; localDirty.current = true;
        const saved = localSave(latest); if (active.current && saved) setStatus(dirty.current ? 'local' : 'synced');
      }
    } catch { if (active.current && localOK.current) setStatus('failed'); }
    finally { requestInFlight.current = false; syncing.current = false; if (succeeded && dirty.current && active.current && conflictRemote.current === undefined) scheduleRef.current(); }
  }, [adopt, localSave, path]);
  const schedule = useCallback(() => {
    clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = undefined; void sync(); }, SYNC_DELAY);
    if (!maxTimer.current) maxTimer.current = setTimeout(() => { maxTimer.current = undefined; void sync(); }, MAX_WAIT);
  }, [sync]);
  scheduleRef.current = schedule;
  const finalFlush = useCallback(() => {
    pageHiding.current = true; clearTimeout(timer.current); clearTimeout(maxTimer.current); timer.current = undefined; maxTimer.current = undefined; flushLocal();
    const snapshot = current.current; const fp = currentFingerprint.current;
    if (!snapshot || !dirty.current || conflictRemote.current !== undefined || requestInFlight.current || !fp || finalSent.current === fp) return;
    const body = JSON.stringify({ scene: snapshot.scene, svg: snapshot.svg, updatedAt: snapshot.updatedAt });
    if (new TextEncoder().encode(body).byteLength >= KEEPALIVE_LIMIT) return;
    finalSent.current = fp; const base = baseUpdatedAt.current;
    void fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(base === null ? { 'If-None-Match': '*' } : { 'If-Match': `"${base}"` }) }, body, keepalive: true }).catch(() => { /* locally saved pending content retries on next load */ });
  }, [flushLocal, path]);
  useEffect(() => {
    active.current = true; pageHiding.current = false; finalSent.current = null; let cancelled = false;
    const load = async () => {
      let local: Snapshot | null = null; let localReadable = true;
      const memory = pendingScenes.get(key);
      if (memory) { localOK.current = false; localDirty.current = true; }
      try { localSeen.current = localStorage.getItem(key); local = readLocal(key); } catch (error) { localReadable = false; localOK.current = false; if (error instanceof InvalidLocalWhiteboard && !memory) { if (!cancelled) { setLoadError('The local whiteboard is invalid and has not been overwritten.'); setStatus('local-failed'); } return; } }
      try {
        const response = await fetch(path); if (!response.ok) throw new Error('Whiteboard state unavailable');
        const result = await response.json() as { snapshot: Snapshot | null; legacy?: Array<{ id: string; snapshot: Snapshot | null }> };
        const remote = result.snapshot;
        if (remote === undefined) throw new Error('Invalid whiteboard state');
        if (cancelled) return;
        if (remote && !memory) {
          if (!localReadable || !Array.isArray(result.legacy)) throw new Error('Cannot safely check legacy drawings. Retry when local and server storage are available.');
          for (const question of lesson.questions) {
            const oldLocal = readLocal(legacyKey(courseId, drillId, question.id));
            const oldServer = result.legacy.find((item) => item.id === question.id)?.snapshot ?? null;
            const recorded = local?.legacySources?.[question.id];
            if (oldLocal && (recorded !== undefined ? oldLocal.updatedAt > recorded : !oldServer || oldLocal.updatedAt > oldServer.updatedAt || (oldLocal.updatedAt === oldServer.updatedAt && JSON.stringify(oldLocal.scene) !== JSON.stringify(oldServer.scene)))) throw new UnsafeLegacyWhiteboard('This device has unmigrated local question drawings. The originals were preserved.');
          }
        }
        const candidate = memory ?? local; let chosen: Snapshot | null = remote;
        baseUpdatedAt.current = remote?.updatedAt ?? null; dirty.current = false; conflictRemote.current = undefined;
        if (candidate && remote) {
          const sameContent = fingerprint(candidate.scene) === fingerprint(remote.scene);
          if (sameContent && !candidate.pendingSync && !candidate.migrationPending && candidate.baseUpdatedAt === remote.updatedAt) chosen = candidate;
          else if (!sameContent && candidate.baseUpdatedAt === undefined) { chosen = candidate; dirty.current = true; conflictRemote.current = remote; }
          else if (candidate.pendingSync || candidate.migrationPending || candidate.updatedAt > remote.updatedAt) {
            if (candidate.updatedAt === remote.updatedAt && sameContent) chosen = { ...candidate, baseUpdatedAt: remote.updatedAt, pendingSync: undefined, migrationPending: undefined };
            else { chosen = candidate; dirty.current = true; if (candidate.baseUpdatedAt !== remote.updatedAt) conflictRemote.current = remote; }
          } else if (candidate.updatedAt === remote.updatedAt && (candidate.baseUpdatedAt === remote.updatedAt || sameContent)) chosen = candidate;
        } else if (candidate && !remote) {
          chosen = candidate; dirty.current = Boolean(candidate.pendingSync || candidate.migrationPending || candidate.updatedAt > 0);
          if (candidate.baseUpdatedAt !== undefined && candidate.baseUpdatedAt !== null && dirty.current) conflictRemote.current = null;
        }
        if (!chosen && !remote) {
          if (!localReadable || !Array.isArray(result.legacy)) throw new Error('Cannot safely migrate legacy drawings. Retry when local and server storage are available.');
          const legacy = lesson.questions.flatMap((question) => {
            const localQuestion = readLocal(legacyKey(courseId, drillId, question.id));
            const remoteQuestion = result.legacy!.find((item) => item.id === question.id)?.snapshot ?? null;
            if (localQuestion && remoteQuestion && localQuestion.updatedAt === remoteQuestion.updatedAt && JSON.stringify(localQuestion.scene) !== JSON.stringify(remoteQuestion.scene)) throw new Error('Legacy drawings have conflicting timestamps; originals were preserved.');
            const newest = localQuestion && (!remoteQuestion || localQuestion.updatedAt > remoteQuestion.updatedAt) ? localQuestion : remoteQuestion;
            return newest ? [{ id: question.id, snapshot: newest }] : [];
          });
          if (legacy.length) {
            chosen = { scene: combineLegacyScenes(legacy.map((item) => item.snapshot)), svg: '', updatedAt: Math.max(Date.now(), ...legacy.map((item) => item.snapshot.updatedAt + 1)), migrationPending: true, pendingSync: true, baseUpdatedAt: null, legacySources: Object.fromEntries(legacy.map((item) => [item.id, item.snapshot.updatedAt])) };
            dirty.current = true; localDirty.current = true; remember(key, chosen); localSave(chosen); setFitInitial(true);
          }
        }
        if (chosen === remote && remote && local?.legacySources) chosen = { ...remote, legacySources: local.legacySources };
        current.current = chosen; currentFingerprint.current = chosen ? fingerprint(chosen.scene) : null; syncedFingerprint.current = remote ? fingerprint(remote.scene) : null; firstChange.current = true;
        setInitial(chosen); setLoadError('');
        if (conflictRemote.current !== undefined) setStatus('conflict');
        else if (memory || !localOK.current) setStatus('local-failed');
        else if (dirty.current) setStatus('local');
        else setStatus(remote ? 'synced' : 'ready');
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'Whiteboard state unavailable');
        if (error instanceof UnsafeLegacyWhiteboard) { current.current = null; setInitial(undefined); setStatus('load-failed'); return; }
        const chosen = memory ?? local; current.current = chosen; currentFingerprint.current = chosen ? fingerprint(chosen.scene) : null; dirty.current = Boolean(chosen?.pendingSync || chosen?.migrationPending); baseUpdatedAt.current = chosen?.baseUpdatedAt ?? null; if (chosen) setInitial(chosen); setStatus(memory || !localOK.current ? 'local-failed' : local ? 'failed' : 'load-failed');
      }
    };
    void load();
    const pagehide = () => finalFlush();
    const pageshow = () => { pageHiding.current = false; finalSent.current = null; if (dirty.current && conflictRemote.current === undefined) scheduleRef.current(); };
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    return () => { cancelled = true; finalFlush(); active.current = false; window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); };
  }, [courseId, drillId, finalFlush, key, lesson.questions, localSave, path, retry, sync]);
  useEffect(() => {
    const root = canvas.current; if (!root) return;
    const labelMenu = () => { const button = root.querySelector('button.main-menu-trigger'); if (button && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Whiteboard menu'); };
    labelMenu(); const observer = new MutationObserver(labelMenu); observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [initial]);
  useEffect(() => {
    if (status !== 'failed' && status !== 'load-failed' && status !== 'local-failed' && status !== 'conflict') return;
    let frame = 0;
    const reveal = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(() => statusOverlay.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })); };
    reveal(); window.addEventListener('resize', reveal);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('resize', reveal); };
  }, [status]);
  const changed = useCallback<Change>((elements, appState, files) => {
    setHasContent(elements.some((element) => !element.isDeleted));
    const scene: Scene = { elements, appState: {
      viewBackgroundColor: appState.viewBackgroundColor, gridModeEnabled: appState.gridModeEnabled, objectsSnapModeEnabled: appState.objectsSnapModeEnabled, gridSize: appState.gridSize, gridStep: appState.gridStep,
      scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom,
      currentItemStrokeColor: appState.currentItemStrokeColor, currentItemBackgroundColor: appState.currentItemBackgroundColor, currentItemFillStyle: appState.currentItemFillStyle,
      currentItemStrokeWidth: appState.currentItemStrokeWidth, currentItemStrokeStyle: appState.currentItemStrokeStyle, currentItemRoughness: appState.currentItemRoughness,
      currentItemOpacity: appState.currentItemOpacity, currentItemFontFamily: appState.currentItemFontFamily, currentItemFontSize: appState.currentItemFontSize,
      currentItemTextAlign: appState.currentItemTextAlign, currentItemStartArrowhead: appState.currentItemStartArrowhead, currentItemEndArrowhead: appState.currentItemEndArrowhead,
      currentItemRoundness: appState.currentItemRoundness, currentItemArrowType: appState.currentItemArrowType,
    }, files };
    const next = fingerprint(scene); const view = JSON.stringify(scene.appState);
    if (firstChange.current) {
      firstChange.current = false; currentFingerprint.current = next; viewSignature.current = view;
      current.current = { ...(current.current ?? { svg: '', updatedAt: 0 }), scene, baseUpdatedAt: baseUpdatedAt.current };
      if (!dirty.current) syncedFingerprint.current = next;
      else if (conflictRemote.current === undefined && active.current && localOK.current) void sync();
      return;
    }
    const contentChanged = next !== currentFingerprint.current;
    if (!contentChanged && view === viewSignature.current) return;
    currentFingerprint.current = next; viewSignature.current = view;
    const previous = current.current ?? { svg: '', updatedAt: 0, scene };
    const snapshot: Snapshot = { ...previous, scene, baseUpdatedAt: baseUpdatedAt.current };
    if (contentChanged) {
      dirty.current = syncedFingerprint.current === null || next !== syncedFingerprint.current;
      if (dirty.current) { snapshot.updatedAt = Math.max(Date.now(), previous.updatedAt + 1, (baseUpdatedAt.current ?? 0) + 1); snapshot.pendingSync = true; }
      else { snapshot.updatedAt = baseUpdatedAt.current ?? 0; delete snapshot.pendingSync; clearTimeout(timer.current); clearTimeout(maxTimer.current); timer.current = undefined; maxTimer.current = undefined; }
    }
    current.current = snapshot; localDirty.current = true; remember(key, snapshot);
    if (active.current && conflictRemote.current === undefined) setStatus('saving');
    clearTimeout(localTimer.current); localTimer.current = setTimeout(() => { if (flushLocal() && active.current) setStatus(conflictRemote.current !== undefined ? 'conflict' : requestInFlight.current ? 'syncing' : dirty.current ? 'local' : baseUpdatedAt.current === null ? 'ready' : 'synced'); }, LOCAL_DELAY);
    if (contentChanged && dirty.current && conflictRemote.current === undefined) schedule();
  }, [flushLocal, schedule, sync]);
  const keepMine = () => {
    if (conflictRemote.current === undefined || !current.current) return;
    baseUpdatedAt.current = conflictRemote.current?.updatedAt ?? null; conflictRemote.current = undefined; dirty.current = true;
    current.current = { ...current.current, updatedAt: Math.max(Date.now(), current.current.updatedAt + 1, (baseUpdatedAt.current ?? 0) + 1), baseUpdatedAt: baseUpdatedAt.current, pendingSync: true };
    localDirty.current = true; remember(key, current.current); if (localSave(current.current)) { setStatus('local'); void sync(); }
  };
  const label: Record<Status, string> = { loading: 'Loading whiteboard…', ready: 'Ready to draw', saving: 'Saving locally…', local: 'Saved locally', syncing: 'Saved locally · Syncing…', synced: 'Saved locally · Synced', failed: 'Saved locally · Sync failed', 'load-failed': 'Whiteboard unavailable', 'local-failed': 'Not saved locally', conflict: 'Changed elsewhere' };
  const saveState: Record<Exclude<Status, 'loading' | 'ready'>, SaveStatusProps['state']> = { saving: 'saving', local: 'local-only', syncing: 'saving', synced: 'saved', failed: 'error', 'load-failed': 'error', 'local-failed': 'error', conflict: 'conflict' };
  return <div className="whiteboard-canvas-pane">
    <div ref={canvas} className="recall-whiteboard-canvas">
      {initial !== undefined ? <Excalidraw key={canvasVersion} excalidrawAPI={setApi} initialData={initialData} onChange={changed} theme={theme} handleKeyboardGlobally autoFocus /> : <Alert>{status === 'load-failed' || status === 'local-failed' ? loadError || 'Cannot load whiteboard. Retry before drawing to protect the saved scene.' : 'Loading whiteboard…'}</Alert>}
      <Button className="whiteboard-return-to-content" variant="secondary" disabled={!hasContent} onClick={() => api.current?.scrollToContent(undefined, { fitToContent: true, animate: true })}>Scroll back to content</Button>
      <div ref={statusOverlay} className="whiteboard-status" data-conflict={status === 'conflict' || undefined}>{status === 'loading' || status === 'ready' ? <Text size="sm" aria-live="polite">{label[status]}</Text> : <SaveStatus state={saveState[status]} text={label[status]} actions={<>{status === 'conflict' && <><Button variant="secondary" onClick={() => { if (conflictRemote.current !== undefined) adopt(conflictRemote.current); }}>Load latest</Button><Button variant="secondary" onClick={keepMine}>Keep mine</Button></>}{(status === 'failed' || status === 'load-failed' || status === 'local-failed') && <Button variant="secondary" onClick={() => { if (current.current) { if (flushLocal()) { if (conflictRemote.current !== undefined) setStatus('conflict'); else if (dirty.current) void sync(); else setStatus(baseUpdatedAt.current === null ? 'ready' : 'synced'); } } else setRetry((value) => value + 1); }}>Retry</Button>}</>} />}</div>
    </div>
  </div>;
}
