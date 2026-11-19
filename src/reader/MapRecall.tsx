import { Alert, Checkbox, Group, Loader, Menu, Modal, Progress, SegmentedControl, Stack, Text, Title, Tooltip, VisuallyHidden } from '@mantine/core';
import { Button, IconButton, Panel } from '../ui';
import { IconFocusCentered, IconListDetails, IconMaximize, IconMenu2, IconSitemap, IconX, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import DOMPurify from 'dompurify';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import { MAP_MAX_WIDTH } from './mapWidth';
import type { INode, IPureNode } from 'markmap-common';
import type { ZoomTransform } from 'd3-zoom';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { RecallLesson } from '../../server/mapRecall';
import { MAP_FOLD_KEY, MAP_FOLD_MAX_NODES, MAP_FOLD_WRITER } from '../../shared/mapFoldState';
import { overviewNeedsFolding } from './mapOverview';
import { clampRestoredViewport, focusExpandedBranch, setImmediateMapLayout, type MapViewport } from './mapNavigation';
import { mapNodeKey } from './mapHighlightAnchors';
import { useMapHighlights } from './MapHighlights';
import { ContentTypeIcon } from '../course/ContentTypeIcon';
import { validCourseImage } from './imagePath';
import { hasJapanesePronunciation, JapaneseLink, useMapJapaneseSpeech } from './japaneseSpeech';
import Markdown from 'react-markdown';
import './mapRecall.css';
const RecallWhiteboard = lazy(() => import('./RecallWhiteboard'));
function stopWhiteboardControlKey(event: KeyboardEvent<HTMLElement>) {
  if (!event.metaKey && !event.ctrlKey && !event.altKey && [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && event.target instanceof Element && !event.target.closest('.excalidraw')) event.stopPropagation();
}

export function sanitizeMapNode(node: IPureNode): IPureNode {
  const content = DOMPurify.sanitize(node.content, { ALLOWED_TAGS: ['a', 'br', 'code', 'em', 'strong', 's', 'span', 'img'], ALLOWED_ATTR: ['href', 'title', 'src', 'alt'], RETURN_DOM: true }) as HTMLElement;
  for (const image of content.querySelectorAll('img')) {
    const src = image.getAttribute('src'); const alt = image.getAttribute('alt');
    if (!validCourseImage(src, alt)) { image.remove(); continue; }
    for (const attribute of [...image.attributes]) if (attribute.name !== 'src' && attribute.name !== 'alt') image.removeAttribute(attribute.name);
    let link = image.closest('a');
    if (!link) { link = document.createElement('a'); image.replaceWith(link); link.appendChild(image); }
    link.setAttribute('href', src); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', `Open image: ${alt} (opens in a new tab)`);
  }
  return { ...node, content: content.innerHTML, children: node.children.map(sanitizeMapNode) };
}

// Hash the content path, including an index among equal siblings, rather than
// markmap's traversal IDs, which change when unrelated branches are inserted.
function mapFolds(root: INode, restore?: Record<string, boolean>, firstLevel?: string[]): Record<string, boolean> | null {
  const result: Record<string, boolean> = {};
  let count = 0;
  const visit = (node: INode, path: string, depth: number) => {
    const key = mapNodeKey(path);
    if (node.children.length) {
      if (restore && Object.hasOwn(restore, key)) node.payload = { ...node.payload, fold: restore[key] ? 1 : 0 };
      count += 1;
      if (count <= MAP_FOLD_MAX_NODES) result[key] = Boolean(node.payload?.fold);
      if (depth === 1) firstLevel?.push(key);
    }
    const counts = new Map<string, number>();
    for (const child of node.children) { const index = counts.get(child.content) ?? 0; counts.set(child.content, index + 1); visit(child, `${path}/${JSON.stringify([child.content, index])}`, depth + 1); }
  };
  visit(root, JSON.stringify([root.content, 0]), 0);
  return count <= MAP_FOLD_MAX_NODES ? result : null;
}

type MapWriter = { writer: string; next: () => number; advance: (sequence: number) => void };
let documentWriter: Promise<MapWriter | null> | undefined;
function mapWriter(): Promise<MapWriter | null> {
  if (documentWriter) return documentWriter;
  documentWriter = (async () => {
    if (!navigator.locks) return null;
    let release: (() => void) | null = null;
    try {
    const key = 'map-fold-writer';
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { writer?: unknown; sequence?: unknown } | null;
    let writer = typeof stored?.writer === 'string' && MAP_FOLD_WRITER.test(stored.writer) && typeof stored.sequence === 'number' && Number.isSafeInteger(stored.sequence) && stored.sequence >= 0 ? stored.writer : crypto.randomUUID().replaceAll('-', '');
    let sequence = writer === stored?.writer ? stored.sequence as number : 0;
    // sessionStorage can be cloned into a newly opened tab. Hold a per-writer
    // Web Lock for this document so that clone gets a new identity instead.
    const claim = (id: string) => new Promise<(() => void) | null>((resolve, reject) => {
      void navigator.locks.request(`map-fold-writer:${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(null); return; }
        return new Promise<void>((release) => resolve(release));
      }).catch(reject);
    });
    release = await claim(writer);
    if (!release) { writer = crypto.randomUUID().replaceAll('-', ''); sequence = 0; release = await claim(writer); }
    if (!release) return null;
    sessionStorage.setItem(key, JSON.stringify({ writer, sequence }));
    const unlock = release;
    window.addEventListener('pagehide', () => { unlock(); documentWriter = undefined; }, { once: true });
    const latestSequence = () => { const latest = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { writer?: unknown; sequence?: unknown } | null; if (latest?.writer !== writer || typeof latest.sequence !== 'number' || !Number.isSafeInteger(latest.sequence)) throw new Error('Map writer changed'); return latest.sequence; };
    const advance = (value: number) => { sequence = Math.max(sequence, latestSequence(), value); sessionStorage.setItem(key, JSON.stringify({ writer, sequence })); };
    return { writer, next: () => { sequence = Math.max(sequence, latestSequence()); if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Map save sequence exhausted'); advance(sequence + 1); return sequence; }, advance };
    } catch { release?.(); return null; }
  })();
  return documentWriter;
}

async function initialLayout(instance: Markmap) {
  const root = instance.state.data;
  const viewport = instance.svg.node()?.getBoundingClientRect();
  if (root && viewport && viewport.width > 0 && viewport.height > 0) {
    const nodes = [root, ...root.children];
    // Keep the source's expansion settings when the first-level overview fits.
    // Otherwise fold just those branches; descendants retain the source's settings.
    if (overviewNeedsFolding(viewport, nodes.map((node) => node.state.rect), instance.options.fitRatio, instance.options.maxInitialScale) && root.children.some((node) => node.children.length && !node.payload?.fold)) {
      for (const node of root.children) if (node.children.length) node.payload = { ...node.payload, fold: 1 };
      await instance.renderData();
    }
  }
}
async function initialFit(instance: Markmap) {
  await initialLayout(instance);
  await instance.fit();
}

function validViewport(value: unknown): value is MapViewport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { k, x, y } = value as Record<string, unknown>;
  return typeof k === 'number' && Number.isFinite(k) && k > 0 && typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
}
function readViewport(key: string): MapViewport | null {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return validViewport(value) ? value : null; }
  catch { return null; }
}

export function MapRecall({ courseId, lessonId, kind, title, whiteboard = false, questionsCollapsed = false, onToggleQuestions, editorPercent = 65, onEditorPercentChange, timer, completion, hasStoredChecks = false, onProgress, onNext, floatingControls, floatingControlsOpened, onFullscreenChange }: { courseId: string; lessonId: string; kind: 'map' | 'recall' | 'whiteboard'; title: string; whiteboard?: boolean; questionsCollapsed?: boolean; onToggleQuestions?: () => void; editorPercent?: number; onEditorPercentChange?: (value: number) => void; timer?: ReactNode; completion?: ReactNode; hasStoredChecks?: boolean; onProgress?: (lessonId: string, value: { checked: number; total: number }) => void; onNext?: () => void; floatingControls?: ReactNode; floatingControlsOpened?: boolean; onFullscreenChange?: (fullscreen: boolean) => void }) {
  const [content, setContent] = useState<string | RecallLesson>();
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setContent(undefined); setFailure('');
    fetch(`/api/map-recall/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}`).then(async (response) => {
      if (!response.ok) throw new Error(`Content request failed (${response.status})`);
      const data = await response.json() as { source?: string } | RecallLesson;
      if (kind === 'map' && (typeof (data as { source?: unknown }).source !== 'string' || !(data as { source: string }).source.trim())) throw new Error('Map source is empty or invalid');
      if (kind !== 'map' && (!Array.isArray((data as RecallLesson).questions) || typeof (data as RecallLesson).title !== 'string')) throw new Error('Recall questions are invalid');
      if (active) setContent(kind === 'map' ? (data as { source: string }).source : data as RecallLesson);
    }).catch((error: unknown) => { if (active) setFailure(error instanceof Error ? error.message : 'Content unavailable'); });
    return () => { active = false; };
  }, [courseId, lessonId, kind, retry]);
  if (failure) return <Alert color="red" role="alert" title={`${kind === 'map' ? 'Map' : 'Questions'} unavailable`}><Text>{failure}</Text><Button mih={44} onClick={() => setRetry((x) => x + 1)}>Retry</Button></Alert>;
  if (!content) return <Group><Loader /><Text>Loading {kind === 'map' ? 'map' : 'questions'}…</Text></Group>;
  if (typeof content === 'string') return <MapLesson source={content} title={title} courseId={courseId} lessonId={lessonId} completion={completion} floatingControls={floatingControls} floatingControlsOpened={floatingControlsOpened} onFullscreenChange={onFullscreenChange} />;
  if (whiteboard || kind === 'whiteboard') return <Stack gap="xs" className="recall-whiteboard-surface" onKeyDown={stopWhiteboardControlKey} onKeyUp={stopWhiteboardControlKey}>
    <div className="recall-whiteboard-header"><Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}><ContentTypeIcon type="recall" whiteboard /><Title order={1} size="h2">{content.title}</Title></Group><Group className="recall-whiteboard-actions" gap="xs" wrap="nowrap" role="region" aria-label="Whiteboard controls" tabIndex={0}><Button variant="secondary" aria-controls="whiteboard-questions" aria-expanded={!questionsCollapsed} onClick={onToggleQuestions}>{questionsCollapsed ? 'Show questions' : 'Hide questions'}</Button>{completion}{timer}</Group></div>
    <Suspense fallback={<Group><Loader /><Text>Loading whiteboard…</Text></Group>}><RecallWhiteboard lesson={content} questionsCollapsed={questionsCollapsed} editorPercent={editorPercent} onEditorPercentChange={onEditorPercentChange} /></Suspense>
  </Stack>;
  return <RecallQuestions lesson={content} hasStoredChecks={hasStoredChecks} onProgress={onProgress} onNext={onNext} />;
}

function MapLesson({ source, title, courseId, lessonId, completion, floatingControls, floatingControlsOpened, onFullscreenChange }: { source: string; title: string; courseId: string; lessonId: string; completion?: ReactNode; floatingControls?: ReactNode; floatingControlsOpened?: boolean; onFullscreenChange?: (fullscreen: boolean) => void }) {
  const [svg] = useState(() => { const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); element.setAttribute('aria-label', `${title} mind map`); element.setAttribute('aria-hidden', 'true'); element.style.width = '100%'; element.style.height = '100%'; element.style.opacity = '0'; return element; });
  const [outlineElement, setOutlineElement] = useState<HTMLElement | null>(null);
  useMapJapaneseSpeech(svg);
  useMapJapaneseSpeech(outlineElement);
  const map = useRef<Markmap | null>(null);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const mapMenuTrigger = useRef<HTMLButtonElement>(null);
  const wasFullscreen = useRef(false);
  const pendingInitialFit = useRef(true);
  const dataReady = useRef(false);
  const interacted = useRef(false);
  const savedLayout = useRef(false);
  const mapVisible = useRef(false);
  const changed = useRef(() => {});
  const resetState = useRef(() => {});
  const resetViewport = useRef<() => () => void>(() => () => {});
  const baseline = useRef(() => {});
  const visibilityChanged = useRef(() => {});
  const [view, setView] = useState(() => { try { return localStorage.getItem('map-recall-view') === 'outline' ? 'outline' : 'map'; } catch { return 'map'; } });
  const [focusedView, setFocusedView] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => { onFullscreenChange?.(fullscreen); return () => onFullscreenChange?.(false); }, [fullscreen, onFullscreenChange]);
  const viewRef = useRef(view); viewRef.current = view;
  const fullscreenRef = useRef(fullscreen); fullscreenRef.current = fullscreen;
  const [failure, setFailure] = useState('');
  const [mapReady, setMapReady] = useState(false);
  const [mapRetry, setMapRetry] = useState(0);
  const transformed = useMemo(() => { const result = new Transformer().transform(source); return { ...result, root: sanitizeMapNode(result.root) }; }, [source]);
  const highlights = useMapHighlights({ courseId, lessonId, root: transformed.root, svg, map, mapReady, fullscreen });
  useEffect(() => {
    setMapReady(false); svg.style.opacity = '0'; svg.setAttribute('aria-hidden', 'true');
    const options = transformed.frontmatter?.markmap;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const numeric = Object.fromEntries((['maxWidth', 'initialExpandLevel', 'maxInitialScale', 'spacingVertical', 'duration'] as const).flatMap((key) => typeof options?.[key] === 'number' && Number.isFinite(options[key]) ? [[key, options[key]]] : []));
    let instance: Markmap;
    const compact = svg.getBoundingClientRect().width < 400;
    // On phones, reclaim branch whitespace for the inline 44px audio controls.
    try { instance = new Markmap(svg, { autoFit: false, maxWidth: MAP_MAX_WIDTH, ...(compact ? { spacingHorizontal: hasJapanesePronunciation(source) ? 0 : 20 } : {}), ...numeric, ...(reduced ? { duration: 0 } : {}) }); setImmediateMapLayout(instance); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Map rendering failed'); return; }
    const authoredMaxWidth = instance.options.maxWidth;
    const sizeNodes = () => {
      const width = svg.getBoundingClientRect().width;
      if (width > 0 && authoredMaxWidth > 0) instance.options.maxWidth = Math.min(authoredMaxWidth, Math.max(120, Math.floor(width - 32)));
    };
    instance.svg.on('wheel', null);
    instance.zoom.filter((event: Event & { ctrlKey?: boolean; button?: number; touches?: TouchList }) => event.type === 'wheel' ? Boolean(event.ctrlKey) : (!event.button && !event.ctrlKey && (Boolean(event.touches && event.touches.length > 1) || !(event.target instanceof Element && event.target.closest('foreignObject')))));
    map.current = instance;
    pendingInitialFit.current = true; dataReady.current = false; interacted.current = false;
    savedLayout.current = false;
    let active = true; let pageActive = true; let intersecting = false; let visible = false; let initialized = false; let loading = false; let canSave = false;
    let saved = ''; let current = ''; let defaults = ''; let sourceDefaults = ''; let savedDefault = false; let resetPending = false; let acknowledged = 0; let timer: ReturnType<typeof setInterval> | undefined; let loadController: AbortController | undefined; let imagePending = false; let imageFrame: number | undefined;
    let defaultRects: Array<{ x: number; y: number; width: number; height: number }> = []; const firstLevel: string[] = [];
    let writer: MapWriter | null = null;
    const path = `/api/map-fold-state/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}`;
    const viewportKey = `map-viewport:${encodeURIComponent(courseId)}:${encodeURIComponent(lessonId)}`;
    let storedViewport = readViewport(viewportKey);
    let pendingViewport: MapViewport | undefined; let viewportTimer: ReturnType<typeof setTimeout> | undefined; let suppressViewport = false;
    const flushViewport = () => {
      clearTimeout(viewportTimer); viewportTimer = undefined;
      if (!pendingViewport) return;
      try { localStorage.setItem(viewportKey, JSON.stringify(pendingViewport)); pendingViewport = undefined; }
      catch { /* local storage unavailable; the current view remains usable */ }
    };
    instance.zoom.on('zoom.viewport', (event) => {
      const { k, x, y } = event.transform;
      if (initialized && visible && !suppressViewport && validViewport({ k, x, y })) {
        if (event.sourceEvent) interacted.current = true;
        if (interacted.current) pendingViewport = { k, x, y };
      }
    });
    instance.zoom.on('end.viewport', () => {
      if (!pendingViewport || suppressViewport) return;
      clearTimeout(viewportTimer); viewportTimer = setTimeout(flushViewport, 250);
    });
    resetViewport.current = () => {
      suppressViewport = true; storedViewport = null; clearTimeout(viewportTimer); viewportTimer = undefined; pendingViewport = undefined;
      try { localStorage.removeItem(viewportKey); } catch { /* local storage unavailable */ }
      return () => { suppressViewport = false; };
    };
    const snapshot = () => { const folds = instance.state.data && mapFolds(instance.state.data); return folds ? JSON.stringify(folds) : ''; };
    const save = (final = false) => {
      if (!canSave || !writer || !current || (current === saved && ![...inFlight].some((sequence) => sequence > acknowledged))) return;
      const actor = writer;
      const sent = current;
      if (!final && pending.has(sent)) return;
      let number: number;
      try { number = actor.next(); } catch { canSave = false; return; }
      pending.set(sent, (pending.get(sent) ?? 0) + 1);
      inFlight.add(number);
      const sentReset = resetPending;
      issued.set(number, { snapshot: sent, reset: sentReset });
      void fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folds: sentReset ? null : JSON.parse(sent), writer: actor.writer, sequence: number }), ...(final ? { keepalive: true } : {}) }).then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as { applied?: unknown; sequence?: unknown };
        if (typeof result.applied !== 'boolean' || typeof result.sequence !== 'number' || !Number.isSafeInteger(result.sequence) || result.sequence < number) throw new Error('Invalid map save response');
        if (!result.applied) actor.advance(result.sequence);
        const accepted = issued.get(result.sequence);
        if (accepted && result.sequence > acknowledged) { acknowledged = result.sequence; savedDefault = accepted.reset; saved = accepted.reset ? defaults : accepted.snapshot; }
        for (const sequence of issued.keys()) if (sequence <= acknowledged) issued.delete(sequence);
      }).catch(() => { /* retry on the next visible tick */ }).finally(() => { inFlight.delete(number); const count = pending.get(sent) ?? 0; if (count > 1) pending.set(sent, count - 1); else pending.delete(sent); });
    };
    const pending = new Map<string, number>();
    const inFlight = new Set<number>();
    const issued = new Map<number, { snapshot: string; reset: boolean }>();
    changed.current = () => { if (canSave && initialized) { current = snapshot(); resetPending = false; } };
    resetState.current = () => {
      if (!canSave || !initialized || !sourceDefaults) return;
      const folds = JSON.parse(sourceDefaults) as Record<string, boolean>;
      const viewport = svg.getBoundingClientRect();
      if (viewport.width > 0 && viewport.height > 0 && overviewNeedsFolding(viewport, defaultRects, instance.options.fitRatio, instance.options.maxInitialScale)) for (const key of firstLevel) folds[key] = true;
      defaults = JSON.stringify(folds); if (savedDefault) saved = defaults;
      current = defaults; resetPending = true;
    };
    baseline.current = () => { if (!interacted.current && !savedLayout.current) defaults = saved = current = snapshot(); };
    const toggleNode = instance.toggleNode.bind(instance);
    let userToggle = false;
    instance.toggleNode = (...args) => { const expanding = userToggle && Boolean(args[0].payload?.fold); const result = toggleNode(...args); changed.current(); return result.then(async () => { if (expanding) await focusExpandedBranch(instance, args[0]); }); };
    const handleClick = instance.handleClick?.bind(instance);
    if (handleClick) instance.handleClick = (event, node) => { interacted.current = true; userToggle = true; try { handleClick(event, node); } finally { userToggle = false; } };
    const markInteraction = () => { interacted.current = true; };
    svg.addEventListener('pointerdown', markInteraction);
    svg.addEventListener('touchstart', markInteraction);
    svg.addEventListener('keydown', markInteraction);
    // Markmap observes node sizes and re-renders them; fit again after images load
    // only until the learner has taken control of the view.
    const refreshImages = () => {
      if (!active || !visible || !dataReady.current || !imagePending || imageFrame !== undefined) return;
      imageFrame = requestAnimationFrame(() => {
        imageFrame = undefined;
        if (!active || !visible || !dataReady.current) return;
        imagePending = false;
        void instance.renderData().then(() => { if (active && visible && !interacted.current) return savedLayout.current ? instance.fit() : initialFit(instance); }).then(() => { if (active) baseline.current(); }).catch((error: unknown) => { if (active) setFailure(String(error)); });
      });
    };
    const imageLoaded = (event: Event) => { if (event.target instanceof HTMLImageElement) { imagePending = true; refreshImages(); } };
    svg.addEventListener('load', imageLoaded, true);
    const decorate = () => {
      const groups = [...svg.querySelectorAll<SVGGElement>('g.markmap-node')];
      for (const group of groups) {
        const circle = group.querySelector(':scope > circle');
        if (!circle) continue;
        circle.setAttribute('aria-hidden', 'true');
        let hit = group.querySelector<SVGRectElement>(':scope > rect.map-toggle-hit');
        const node = (group as SVGGElement & { __data__: INode }).__data__;
        if (!hit) {
          hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          hit.classList.add('map-toggle-hit'); hit.setAttribute('fill', 'transparent'); hit.setAttribute('tabindex', '0'); hit.setAttribute('role', 'button');
          const toggle = (event: Event) => { event.stopPropagation(); const current = (group as SVGGElement & { __data__: INode }).__data__; interacted.current = true; userToggle = true; try { void instance.toggleNode(current).then(decorate).catch((error: unknown) => setFailure(String(error))); } finally { userToggle = false; } };
          hit.addEventListener('click', toggle); hit.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(event); } });
          group.appendChild(hit);
        }
        // A node's 44px toggle target may overlap its pronunciation button.
        // Keep the foreignObject above the hit rectangle for annotated nodes.
        const foreign = group.querySelector(':scope > foreignObject');
        if (foreign?.querySelector('button.japanese-speech') && hit.nextSibling !== foreign) group.insertBefore(hit, foreign);
        const zoom = (instance.svg.property('__zoom') as { k?: number })?.k;
        const size = 44 / (zoom && Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
        hit.setAttribute('width', String(size)); hit.setAttribute('height', String(size));
        hit.setAttribute('x', String(Number(circle.getAttribute('cx')) - size / 2)); hit.setAttribute('y', String(Number(circle.getAttribute('cy')) - size / 2));
        hit.setAttribute('aria-expanded', String(!node.payload?.fold));
        const text = group.querySelector('foreignObject')?.textContent?.trim() || 'branch';
        hit.setAttribute('aria-label', `${node.payload?.fold ? 'Expand' : 'Collapse'} ${text}`);
      }
      // Other branches' toggle targets can overlap as well. Paint annotated
      // nodes above them, ancestors first, without changing their layout.
      for (const parent of new Set(groups.filter((group) => group.querySelector('button.japanese-speech')).map((group) => group.parentElement))) {
        if (!parent) continue;
        const nodes = [...parent.children].filter((child): child is SVGGElement => child.matches('g.markmap-node'));
        const audio = nodes.filter((node) => node.querySelector('button.japanese-speech')).sort((a, b) => Number(a.dataset.depth) - Number(b.dataset.depth));
        if (audio.some((node, index) => nodes[nodes.length - audio.length + index] !== node)) for (const node of audio) parent.appendChild(node);
      }
    };
    instance.zoom.on('zoom.accessibility', decorate);
    const observer = new MutationObserver(decorate); observer.observe(svg, { childList: true, subtree: true });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const sizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      if (visible && !initialized && !loading && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0) {
        void initialize().catch((error: unknown) => { if (active) setFailure(error instanceof Error ? error.message : 'Map rendering failed'); });
        return;
      }
      if (!visible || !dataReady.current || interacted.current) return;
      resizeTimer = setTimeout(() => {
        if (!active || interacted.current || svg.getBoundingClientRect().width <= 0 || svg.getBoundingClientRect().height <= 0) return;
        sizeNodes();
        void instance.renderData().then(() => { if (active && !interacted.current) return savedLayout.current ? instance.fit() : initialFit(instance); }).then(() => { if (active) baseline.current(); }).catch((error: unknown) => { if (active) setFailure(String(error)); });
      }, 120);
    });
    sizeObserver.observe(svg);
    const initialize = async () => {
      loading = true; loadController = new AbortController(); let folds: Record<string, boolean> | null = null; let loaded = false;
      writer = await mapWriter();
      if (!active || !visible) { loading = false; return; }
      try { const response = await fetch(path, { signal: loadController.signal }); if (!response.ok) throw new Error('Map state unavailable'); const data = await response.json() as { folds?: unknown }; if (data.folds !== null && (!data.folds || typeof data.folds !== 'object' || Array.isArray(data.folds) || Object.entries(data.folds).length > MAP_FOLD_MAX_NODES || Object.entries(data.folds).some(([key, value]) => !MAP_FOLD_KEY.test(key) || typeof value !== 'boolean'))) throw new Error('Invalid map state'); folds = data.folds as Record<string, boolean> | null; loaded = true; }
      catch { if (loadController.signal.aborted) { loading = false; if (active && visible) void initialize(); return; } }
      await document.fonts?.ready; if (!active || !visible) { loading = false; return; }
      sizeNodes(); svg.style.opacity = '0'; await instance.setData(structuredClone(transformed.root)); if (!active) return;
      if (instance.state.data) { const source = mapFolds(instance.state.data, undefined, firstLevel); sourceDefaults = source ? JSON.stringify(source) : ''; defaultRects = [instance.state.data, ...instance.state.data.children].map((node) => ({ ...node.state.rect })); }
      if (svg.getBoundingClientRect().width <= 0 || svg.getBoundingClientRect().height <= 0) { loading = false; return; }
      if (!storedViewport) await initialFit(instance);
      pendingInitialFit.current = false;
      defaults = snapshot();
      if (folds && instance.state.data) { await instance.setData(structuredClone(transformed.root)); if (!active) return; mapFolds(instance.state.data!, folds); savedLayout.current = true; await instance.renderData(); }
      if (savedLayout.current && !storedViewport && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0) await instance.fit();
      if (storedViewport) {
        const zoom = instance.svg.property('__zoom') as ZoomTransform;
        const view = instance.state.data ? clampRestoredViewport(storedViewport, svg.getBoundingClientRect(), instance.state.data) : storedViewport;
        const target = zoom.translate((view.x - zoom.x) / zoom.k, (view.y - zoom.y) / zoom.k).scale(view.k / zoom.k);
        instance.svg.call(instance.zoom.transform, target); pendingInitialFit.current = false; interacted.current = true;
      }
      dataReady.current = true;
      saved = current = snapshot(); savedDefault = loaded && folds === null; canSave = loaded && Boolean(current) && Boolean(defaults); initialized = true; loading = false; svg.style.opacity = ''; svg.removeAttribute('aria-hidden'); setMapReady(true); decorate(); refreshImages();
    };
    const updateVisibility = () => {
      const next = active && pageActive && intersecting && document.visibilityState === 'visible' && (viewRef.current === 'map' || fullscreenRef.current);
      if (next === visible) return;
      visible = next; mapVisible.current = visible;
      if (visible) {
        refreshImages();
        if (!initialized && !loading) void initialize().catch((error: unknown) => { if (active) setFailure(error instanceof Error ? error.message : 'Map rendering failed'); });
        if (initialized && !writer) void mapWriter().then((value) => { if (active && visible) writer = value; });
        if (initialized && pendingInitialFit.current && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0) { pendingInitialFit.current = false; void instance.renderData().then(() => savedLayout.current ? instance.fit() : initialFit(instance)).then(() => baseline.current()).catch((error: unknown) => { if (active) setFailure(String(error)); }); }
        timer = setInterval(() => save(), 60000);
      }
      else { clearInterval(timer); clearTimeout(resizeTimer); loadController?.abort(); save(true); flushViewport(); }
    };
    visibilityChanged.current = updateVisibility;
    const intersection = new IntersectionObserver((entries) => { intersecting = entries.some((entry) => entry.isIntersecting); updateVisibility(); });
    intersection.observe(svg);
    document.addEventListener('visibilitychange', updateVisibility);
    const pagehide = () => { pageActive = false; updateVisibility(); writer = null; };
    const pageshow = () => { pageActive = true; updateVisibility(); };
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    return () => { pagehide(); flushViewport(); active = false; changed.current = () => {}; resetState.current = () => {}; resetViewport.current = () => () => {}; baseline.current = () => {}; visibilityChanged.current = () => {}; clearTimeout(resizeTimer); if (imageFrame !== undefined) cancelAnimationFrame(imageFrame); intersection.disconnect(); document.removeEventListener('visibilitychange', updateVisibility); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); sizeObserver.disconnect(); observer.disconnect(); svg.removeEventListener('pointerdown', markInteraction); svg.removeEventListener('touchstart', markInteraction); svg.removeEventListener('keydown', markInteraction); svg.removeEventListener('load', imageLoaded, true); instance.destroy(); map.current = null; };
  }, [transformed, svg, mapRetry, courseId, lessonId]);
  useEffect(() => {
    visibilityChanged.current();
    if (view !== 'map' || !mapVisible.current) return;
    const frame = requestAnimationFrame(() => { const instance = map.current; if (instance && dataReady.current && pendingInitialFit.current && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0) { pendingInitialFit.current = false; void instance.renderData().then(() => savedLayout.current ? instance.fit() : initialFit(instance)).then(() => baseline.current()).catch((error: unknown) => setFailure(String(error))); } });
    return () => cancelAnimationFrame(frame);
  }, [view, fullscreen, svg]);
  useEffect(() => { if (fullscreen) wasFullscreen.current = true; else if (wasFullscreen.current) { wasFullscreen.current = false; requestAnimationFrame(() => { const trigger = fullscreenTrigger.current; if (trigger && getComputedStyle(trigger).display !== 'none') trigger.focus(); else mapMenuTrigger.current?.focus(); }); } }, [fullscreen]);
  const run = (action: (instance: Markmap) => Promise<void>) => { interacted.current = true; if (map.current) void action(map.current).catch((error: unknown) => setFailure(error instanceof Error ? error.message : 'Map rendering failed')); };
  const fold = (expanded: boolean) => run(async (instance) => {
    const visit = (node: INode, depth: number) => { node.payload = { ...node.payload, fold: expanded || depth < 1 ? 0 : 1 }; node.children.forEach((child) => visit(child, depth + 1)); };
    if (instance.state.data) { visit(instance.state.data, 0); changed.current(); await instance.renderData(); if (expanded) await focusExpandedBranch(instance, instance.state.data); }
  });
  const fitAll = () => run(async (instance) => {
    const visit = (node: INode) => { node.payload = { ...node.payload, fold: 0 }; node.children.forEach(visit); };
    if (instance.state.data) { visit(instance.state.data); changed.current(); await instance.renderData(); await instance.fit(); }
  });
  const reset = () => run(async (instance) => { const resume = resetViewport.current(); try { resetState.current(); await instance.setData(structuredClone(transformed.root)); savedLayout.current = false; await initialFit(instance); } finally { resume(); } });
  const actions = <Group gap="xs" wrap="wrap" className="map-recall-actions" role="region" aria-label="Map actions" tabIndex={0}>
      <IconButton label="Zoom out" icon={<IconZoomOut size={20} aria-hidden="true" />} onClick={() => run((m) => m.rescale(0.8))} />
      <IconButton label="Zoom in" icon={<IconZoomIn size={20} aria-hidden="true" />} onClick={() => run((m) => m.rescale(1.25))} />
      <IconButton label="Fit visible" icon={<IconFocusCentered size={20} aria-hidden="true" />} onClick={() => run((m) => m.fit())} />
      {!fullscreen && <IconButton className="map-fullscreen-direct" ref={fullscreenTrigger} label="Fullscreen" icon={<IconMaximize size={20} aria-hidden="true" />} onClick={() => { interacted.current = true; setFullscreen(true); }} />}
      <Menu withinPortal={!fullscreen} zIndex="var(--ir-z-popover)"><Menu.Target><IconButton ref={mapMenuTrigger} label="More map actions" icon={<IconMenu2 size={20} aria-hidden="true" />} /></Menu.Target><Menu.Dropdown>
        {!fullscreen && <Menu.Item className="map-fullscreen-menu" mih={44} onClick={() => { interacted.current = true; setFullscreen(true); }}>Fullscreen</Menu.Item>}
        <Menu.Item mih={44} onClick={() => fold(true)}>Expand all</Menu.Item>
        <Menu.Item mih={44} onClick={() => fold(false)}>Collapse all</Menu.Item>
        <Menu.Item mih={44} onClick={fitAll}>Fit all</Menu.Item>
        <Menu.Item mih={44} disabled={!mapReady} onClick={reset}>Reset view</Menu.Item>
      </Menu.Dropdown></Menu>
    </Group>;
  const canvas = <div className="map-recall-canvas" tabIndex={-1} role="region" aria-label={`${title} map`}>
    {!mapReady && !failure && <Text size="sm" role="status">Loading map…</Text>}
    <div className="map-recall-svg" aria-busy={!mapReady && !failure} ref={(host) => { if (host && svg.parentNode !== host) host.appendChild(svg); }} />
    {highlights.selectionLayer}
  </div>;
  return <Stack gap="sm" className="map-recall-surface">
    <div className="map-recall-header">
      <div className="map-recall-title"><Title order={1}>{title}</Title><Text>{completion ? 'Reference · counts as a drill' : 'Reference · not counted'}</Text></div>
      {!fullscreen && <div className="map-recall-controls" role="region" aria-label="Map controls" tabIndex={0}>{view === 'map' && actions}{completion}<SegmentedControl aria-label="Reference view" className="map-recall-view" classNames={{ label: 'map-recall-view-label' }} value={view} onFocus={(event) => { if (event.target instanceof HTMLInputElement) setFocusedView(event.target.value); }} onBlur={() => setFocusedView('')} onChange={(value) => { setView(value); try { localStorage.setItem('map-recall-view', value); } catch { /* view remains available for this session */ } }} data={[{ label: <Tooltip label="Map" opened={focusedView === 'map' || undefined}><span><VisuallyHidden>Map</VisuallyHidden><IconSitemap size={20} aria-hidden="true" /></span></Tooltip>, value: 'map' }, { label: <Tooltip label="Text outline" opened={focusedView === 'outline' || undefined}><span><VisuallyHidden>Text outline</VisuallyHidden><IconListDetails size={20} aria-hidden="true" /></span></Tooltip>, value: 'outline' }]} />{highlights.button && <div className="map-highlight-control">{highlights.button}</div>}</div>}
    </div>
    {!fullscreen && <>{highlights.status}{highlights.announcer}</>}
    {failure && <Alert color="red" role="alert" className="map-recall-error" title="Map rendering failed">{failure} <Button variant="secondary" onClick={() => { setFailure(''); setMapRetry((value) => value + 1); }}>Retry</Button> The text outline remains available.</Alert>}
    <div className="map-recall-map" style={{ display: view === 'map' && !fullscreen ? 'flex' : 'none' }}>{!fullscreen && canvas}</div>
    {view === 'outline' && <nav ref={setOutlineElement} aria-label="Text outline" className="map-recall-outline"><ul><OutlineBranch node={transformed.root} depth={0} /></ul></nav>}
    <Modal.Root opened={fullscreen} onClose={() => setFullscreen(false)} closeOnEscape={!highlights.opened && !floatingControlsOpened} fullScreen returnFocus zIndex="var(--ir-z-modal)" transitionProps={{ duration: 0 }}>
      <Modal.Overlay />
      <Modal.Content className="map-recall-fullscreen-content">
        <Modal.Header role="presentation" className="map-recall-fullscreen-header"><div className="map-recall-fullscreen-title"><Modal.Title className="map-recall-fullscreen-heading">{title} · Fullscreen</Modal.Title>{fullscreen && <div className="map-recall-controls">{actions}{highlights.button && <div className="map-highlight-control">{highlights.button}</div>}</div>}</div><IconButton variant="subtle" label="Exit fullscreen" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={() => setFullscreen(false)} /></Modal.Header>
        <Modal.Body className="map-recall-fullscreen-body">{fullscreen && <>{highlights.status}{highlights.announcer}{canvas}{floatingControls}</>}</Modal.Body>
      </Modal.Content>
    </Modal.Root>
  </Stack>;
}

function OutlineBranch({ node, depth }: { node: IPureNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const id = `outline-${useId().replaceAll(':', '')}`;
  return <li><Group wrap="nowrap" align="start" gap="xs">{node.children.length > 0 && <Button variant="subtle" size="sm" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.content.replace(/<[^>]*>/g, '')}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? '−' : '+'}</Button>}<div style={{ paddingBlock: 10, overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: node.content }} /></Group>{node.children.length > 0 && <ul id={id} hidden={!open}>{open && node.children.map((child, index) => <OutlineBranch key={index} node={child} depth={depth + 1} />)}</ul>}</li>;
}

function RecallQuestions({ lesson, hasStoredChecks, onProgress, onNext }: { lesson: RecallLesson; hasStoredChecks: boolean; onProgress?: (lessonId: string, value: { checked: number; total: number }) => void; onNext?: () => void }) {
  const [checks, setChecks] = useState<Record<string, { checked?: boolean }>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [failure, setFailure] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [failedSave, setFailedSave] = useState<{ id: string; checked: boolean }>();
  const progressCallback = useRef(onProgress); progressCallback.current = onProgress;
  const path = `/api/outline-state/${encodeURIComponent(lesson.courseId)}/${encodeURIComponent(lesson.drillId)}`;
  useEffect(() => {
    let active = true;
    fetch(path).then(async (response) => { if (!response.ok) throw new Error(`State request failed (${response.status})`); return response.json() as Promise<Record<string, { checked?: boolean }>>; }).then((data) => { if (active) { setChecks(data); setLoaded(true); setFailure(''); } }).catch((error: unknown) => { if (active) setFailure(error instanceof Error ? error.message : 'Recall state unavailable'); });
    return () => { active = false; };
  }, [path, retry]);
  const save = async (id: string, checked: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFailure(''); setFailedSave(undefined);
    try { const response = await fetch(`${path}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked }) }); if (!response.ok) throw new Error(`Save failed (${response.status})`); setChecks(await response.json() as Record<string, { checked?: boolean }>); if (id === 'bulk') { setRevealed({}); setResetOpen(false); } }
    catch (error) { if (id === 'bulk') setResetOpen(false); setFailure(error instanceof Error ? error.message : 'Save failed'); setFailedSave({ id, checked }); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const checked = lesson.questions.filter((q) => checks[q.id]?.checked).length;
  useEffect(() => { if (loaded) progressCallback.current?.(lesson.drillId, { checked, total: lesson.questions.length }); }, [loaded, lesson.drillId, checked, lesson.questions.length]);
  const complete = lesson.questions.length > 0 && checked === lesson.questions.length;
  return <Stack maw="72ch" w="100%" mx="auto">
    <Panel label="Recall progress" padding="md" style={{ position: 'sticky', top: 0, zIndex: 'var(--ir-z-sticky)', background: 'var(--ir-color-canvas)' }}>
      <Group justify="space-between" wrap="wrap"><Title order={1}>{lesson.title}</Title><Menu><Menu.Target><Button mih={44} variant="subtle">Lesson actions</Button></Menu.Target><Menu.Dropdown><Menu.Item mih={44} disabled={!loaded || busy || (checked === 0 && !hasStoredChecks)} onClick={() => setResetOpen(true)}>Reset to re-test</Menu.Item></Menu.Dropdown></Menu></Group>
      <Text aria-live="polite">{loaded ? complete ? `All ${lesson.questions.length} questions marked recalled` : `${checked} of ${lesson.questions.length} recalled` : 'Loading recall progress…'}</Text>
      <Progress value={lesson.questions.length ? checked / lesson.questions.length * 100 : 0} aria-label="Recall progress" />
      {complete && onNext && <Button mt="sm" variant="secondary" onClick={onNext}>Next lesson</Button>}
    </Panel>
    <Text>Try answering from memory, then reveal the answer and assess your recall.</Text>
    {failure && <Alert color="red" role="alert" title={failedSave ? 'Recall check not saved' : 'Recall state unavailable'}><Text>{failure}</Text><Button mih={44} onClick={() => failedSave ? void save(failedSave.id, failedSave.checked) : setRetry((x) => x + 1)}>Retry</Button></Alert>}
    {lesson.questions.length === 0 && <Text>No recall questions available</Text>}
    {lesson.questions.map((q, index) => <Panel key={q.id} padding="md" role="group" labelledBy={`question-${q.id}`}>
      <Text c="dimmed" size="sm">{index + 1}</Text>
      <Title id={`question-${q.id}`} tabIndex={-1} order={2} size="h5">{hasJapanesePronunciation(q.prompt) ? <Markdown components={{ a: JapaneseLink, p: 'span' }}>{q.prompt}</Markdown> : q.prompt}</Title>
      <Button variant="secondary" aria-expanded={Boolean(revealed[q.id])} aria-controls={`answer-${q.id}`} onClick={() => setRevealed((current) => ({ ...current, [q.id]: !current[q.id] }))}>{revealed[q.id] ? 'Hide answer' : 'Show answer'}</Button>
      <div id={`answer-${q.id}`}>{revealed[q.id] && (hasJapanesePronunciation(q.answer) ? <Markdown components={{ a: JapaneseLink }}>{q.answer}</Markdown> : <Text>{q.answer}</Text>)}</div>
      <div style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}><Checkbox label="I recalled this correctly" checked={Boolean(checks[q.id]?.checked)} disabled={!loaded || (!revealed[q.id] && !checks[q.id]?.checked)} aria-disabled={busy || undefined} onChange={(event) => void save(q.id, event.currentTarget.checked)} /></div>
      {!revealed[q.id] && !checks[q.id]?.checked && <Text size="sm" c="dimmed">Reveal the answer to assess your recall.</Text>}
      {index < lesson.questions.length - 1 && <Button variant="subtle" mih={44} onClick={() => document.getElementById(`question-${lesson.questions[index + 1].id}`)?.focus()}>Next question</Button>}
    </Panel>)}
    <Modal.Root opened={resetOpen} onClose={() => setResetOpen(false)} centered><Modal.Overlay /><Modal.Content><Modal.Header role="presentation"><Modal.Title>Reset to re-test?</Modal.Title><IconButton variant="subtle" label="Close reset confirmation" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={() => setResetOpen(false)} /></Modal.Header><Modal.Body><Text>Clear all {lesson.questions.length} recall checks in this lesson? Answers will be hidden. Other lessons are unchanged.</Text><Group justify="flex-end" mt="md"><Button variant="secondary" onClick={() => setResetOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} onClick={() => void save('bulk', false)}>Clear checks</Button></Group></Modal.Body></Modal.Content></Modal.Root>
  </Stack>;
}
