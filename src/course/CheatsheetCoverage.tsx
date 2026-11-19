import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode, type RefObject } from 'react';
import { Group, Text } from '@mantine/core';
import { Button } from '../ui';
import { COVERAGE_REGION_ID, COVERAGE_SIGNALS, COVERAGE_WRITER, coverageScore, relativeCoverage, emptyCoverageSignals, type CoverageSignals, type CoverageSnapshot } from '../../shared/cheatsheetCoverage';

type Heading = { index: number; title: string; level: number; sectionId?: string };
type Region = { id: string; title: string; index: number; element: HTMLElement; top: number; height: number };
type Props = { courseId: string; root: RefObject<HTMLElement | null>; headings: Heading[]; hidden: boolean; onJump: (index: number) => void };
type Batch = { generation: number; writer: string; sequence: number; createdAt: number; events: Record<string, CoverageSignals> };
type WriterState = { writer: string; sequence: number; retry: Batch | null };
const empty = (): CoverageSnapshot => ({ generation: 0, revision: 0, regions: {} });

function parseSnapshot(value: unknown): CoverageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid coverage response');
  const data = value as CoverageSnapshot;
  if (!Number.isSafeInteger(data.generation) || data.generation < 0 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !data.regions || typeof data.regions !== 'object' || Array.isArray(data.regions)) throw new Error('Invalid coverage response');
  for (const [id, record] of Object.entries(data.regions)) if (!COVERAGE_REGION_ID.test(id) || !record || typeof record !== 'object' || !Number.isSafeInteger(record.updatedAt) || COVERAGE_SIGNALS.some((key) => !Number.isSafeInteger(record[key]) || record[key] < 0)) throw new Error('Invalid coverage response');
  return data;
}
function colorStep(score: number) { return score >= 0.7 ? 'high' : score >= 0.3 ? 'medium' : score > 0 ? 'low' : 'unvisited'; }
function statusHint(score: number) { const step = colorStep(score); return step === 'high' ? 'Most attention relative to this sheet' : step === 'medium' ? 'Moderate attention relative to this sheet' : step === 'low' ? 'Less attention relative to this sheet' : 'Unvisited'; }

function reportCoverageError(error: unknown) { console.error('Cheatsheet coverage failed', error); }
function guarded<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  return (...args) => { try { fn(...args); } catch (error) { reportCoverageError(error); } };
}
function runCoverage(promise: Promise<void>) { void promise.catch(reportCoverageError); }
function newWriter(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID().replaceAll('-', '');
    if (typeof globalThis.crypto?.getRandomValues === 'function') return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) { reportCoverageError(error); }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

class CoverageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { reportCoverageError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}
export function CheatsheetCoverage(props: Props) {
  return <CoverageBoundary><CoverageContent {...props} /></CoverageBoundary>;
}
function CoverageContent({ courseId, root, headings, hidden, onJump }: Props) {
  const [snapshot, setSnapshot] = useState<CoverageSnapshot>(empty);
  const [regions, setRegions] = useState<Region[]>([]);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [hint, setHint] = useState('Coverage map');
  const [hintTop, setHintTop] = useState<number | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeUntil = useRef(0);
  const latest = useRef(snapshot); latest.current = snapshot;
  const regionRef = useRef<Region[]>([]); regionRef.current = regions;
  const pending = useRef<Record<string, CoverageSignals>>({});
  const generation = useRef<number | null>(null);
  const writer = useRef<WriterState | null>(null);
  const writerStorage = useRef<Storage | null>(null);
  const writerKey = useRef('');
  const writerLocked = useRef(false);
  const localOnly = useRef(false);
  const localRecord = useRef<(events: Record<string, CoverageSignals>) => void>(() => {});
  const prepareWriterRef = useRef<(generation: number) => Promise<void>>(async () => {});
  const inFlight = useRef<Promise<void> | null>(null);
  const failure = useRef(false);
  const resetting = useRef(false);
  const retryBatch = useRef<Batch | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endpoint = `/api/cheatsheet-coverage/${encodeURIComponent(courseId)}`;
  const flushRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => guarded(() => { if (hintTimer.current) clearTimeout(hintTimer.current); }), []);

  useEffect(() => {
    try {
    let mounted = true;
    const applyLocal = (events: Record<string, CoverageSignals>) => {
      const regions = { ...latest.current.regions };
      for (const [id, signals] of Object.entries(events)) {
        const previous = regions[id] ?? { ...emptyCoverageSignals(), updatedAt: 0 };
        const next = { ...previous, updatedAt: Date.now() };
        for (const key of COVERAGE_SIGNALS) next[key] += signals[key];
        regions[id] = next;
      }
      latest.current = { ...latest.current, regions }; if (mounted) setSnapshot(latest.current);
    };
    localRecord.current = applyLocal;
    const readWriter = (): WriterState | null => {
      const raw = writerStorage.current?.getItem(writerKey.current); if (!raw) return writer.current;
      const value = JSON.parse(raw) as WriterState;
      if (!COVERAGE_WRITER.test(value.writer) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || (value.retry !== null && (!value.retry || value.retry.writer !== value.writer || value.retry.generation !== generation.current || value.retry.sequence !== value.sequence))) throw new Error('Invalid stored coverage writer');
      return value;
    };
    const saveWriter = (value: WriterState) => { writerStorage.current?.setItem(writerKey.current, JSON.stringify(value)); writer.current = value; };
    const prepareWriter = async (gen: number) => {
      writerKey.current = `interview-runner-coverage-writer:${encodeURIComponent(courseId)}:${gen}`;
      writer.current = null; writerStorage.current = null; writerLocked.current = false;
      // Web Locks serialize shared localStorage writers across tabs. Without it,
      // sessionStorage isolates concurrent tabs rather than risking lost writes.
      const kinds = navigator.locks ? ['localStorage', 'sessionStorage'] as const : ['sessionStorage'] as const;
      for (const kind of kinds) {
        try { const storage = window[kind]; const probe = `${writerKey.current}:probe`; storage.setItem(probe, '1'); storage.removeItem(probe); writerStorage.current = storage; writerLocked.current = kind === 'localStorage'; break; }
        catch (error) { console.debug('Coverage storage unavailable', error); }
      }
      const init = () => {
        try { writer.current = readWriter(); } catch (error) { console.debug('Coverage writer storage invalid', error); writerStorage.current = null; writerLocked.current = false; }
        if (!writer.current) saveWriter({ writer: newWriter(), sequence: 0, retry: null });
      };
      if (writerLocked.current) await navigator.locks.request(writerKey.current, init); else init();
    };
    prepareWriterRef.current = prepareWriter;
    const flush = async (): Promise<void> => {
      if (inFlight.current) { await inFlight.current; return; }
      if (generation.current === null || failure.current || (!retryBatch.current && !Object.keys(pending.current).length)) return;
      const request = (async () => {
        try {
          const send = async () => {
          const state = readWriter(); if (!state || generation.current === null) throw new Error('Coverage writer unavailable');
          const events = Object.fromEntries(Object.entries(pending.current).slice(0, 128));
          // Another tab can have completed our persisted retry while we waited.
          if (!state.retry && retryBatch.current && state.sequence >= retryBatch.current.sequence) retryBatch.current = null;
          if (!state.retry && !retryBatch.current && !Object.keys(events).length) return;
          const batch = state.retry ?? retryBatch.current ?? { generation: generation.current, writer: state.writer, sequence: state.sequence + 1, createdAt: Date.now(), events };
          if (!state.retry && !retryBatch.current) for (const id of Object.keys(events)) delete pending.current[id];
          retryBatch.current = batch; saveWriter({ writer: state.writer, sequence: batch.sequence, retry: batch });
          const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), keepalive: true });
          if (response.status === 429) {
            console.debug('Coverage is local-only for this session (writer limit or rate limit).');
            // Keep the durable retry: a prior attempt may have committed before losing its response.
            localOnly.current = true; if (mounted) setPaused(true); applyLocal(batch.events); applyLocal(pending.current); pending.current = {}; retryBatch.current = null; return;
          }
          if (response.status === 409) {
            const body = await response.json() as { error?: string };
            if (body.error === 'Coverage writer expired') { console.debug('Coverage writer expired; retaining activity locally for this session.'); localOnly.current = true; applyLocal(batch.events); applyLocal(pending.current); pending.current = {}; retryBatch.current = null; writerStorage.current?.removeItem(writerKey.current); writer.current = null; return; }
            throw new Error('Coverage was reset elsewhere. Refresh to discard unsaved activity.');
          }
          if (!response.ok) throw new Error(response.status === 409 ? 'Coverage was reset elsewhere. Refresh to discard unsaved activity.' : `Coverage could not be saved (${response.status}).`);
          const result = await response.json() as { snapshot?: unknown };
          const value = parseSnapshot(result.snapshot); saveWriter({ writer: state.writer, sequence: batch.sequence, retry: null }); retryBatch.current = null; generation.current = value.generation;
          latest.current = value; if (mounted) { setSnapshot(value); setError(''); }
          };
          if (writerLocked.current) await navigator.locks.request(writerKey.current, send); else await send();
        } catch (reason) {
          failure.current = true;
          if (mounted) setError(reason instanceof Error ? reason.message : 'Coverage could not be saved.');
        }
      })();
      inFlight.current = request;
      await request; inFlight.current = null;
      if (!failure.current && Object.keys(pending.current).length) await flush();
    };
    flushRef.current = flush;
    const load = async () => {
      try {
        const response = await fetch(endpoint); if (!response.ok) throw new Error(`Coverage unavailable (${response.status}).`);
        const value = parseSnapshot(await response.json()); if (!mounted) return;
        generation.current = value.generation; await prepareWriter(value.generation); if (!mounted) return; latest.current = value; setSnapshot(value); failure.current = false; setError('');
        if (writer.current?.retry) retryBatch.current = writer.current.retry;
        runCoverage(flush());
      } catch (reason) { if (mounted) { failure.current = true; setError(reason instanceof Error ? reason.message : 'Coverage unavailable.'); } }
    };
    loadRef.current = load; runCoverage(load());
    const pagehide = guarded(() => { runCoverage(flush()); });
    window.addEventListener('pagehide', pagehide);
    return guarded(() => { mounted = false; window.removeEventListener('pagehide', pagehide); if (timer.current) clearTimeout(timer.current); runCoverage(flush()); });
    } catch (error) { reportCoverageError(error); }
  }, [endpoint, courseId]);

  useEffect(() => {
    try {
    const content = root.current; const main = content?.closest('main');
    if (!content || !main) return;
    let frame = 0; let observer: IntersectionObserver | undefined; let markers: HTMLElement[] = [];
    const visible = new Set<string>(); const dwell = new Map<string, number>();
    const regionFor = (node: Node | null) => {
      if (!node || !content.contains(node)) return undefined;
      const ordered = regionRef.current; let current: Region | undefined;
      for (const region of ordered) {
        if (region.element.contains(node)) return region;
        if (region.element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) current = region;
      }
      return current;
    };
    const record = (region: Region | undefined, key: keyof CoverageSignals, amount = 1) => {
      if (!region || resetting.current) return;
      if (localOnly.current) { const signals = emptyCoverageSignals(); signals[key] = amount; localRecord.current({ [region.id]: signals }); return; }
      const entry = pending.current[region.id] ??= emptyCoverageSignals();
      entry[key] = Math.min(key === 'dwellMs' ? 60_000 : 1000, entry[key] + amount);
      if (!timer.current) timer.current = setTimeout(guarded(() => { timer.current = null; runCoverage(flushRef.current()); }), 1200);
    };
    const updateViewport = () => {
      const total = Math.max(1, main.scrollHeight);
      setViewport({ top: main.scrollTop / total, height: Math.min(1, main.clientHeight / total) });
    };
    const layout = () => {
      frame = 0; observer?.disconnect(); markers.forEach((marker) => marker.remove()); markers = []; visible.clear();
      const bounds = content.getBoundingClientRect(); const seen = new Set<string>(); const found: Region[] = [];
      for (const element of content.querySelectorAll<HTMLElement>('[data-sheet-heading-index]')) {
        const info = headings[Number(element.dataset.sheetHeadingIndex)]; if (!info || !element.getClientRects().length) continue;
        const card = element.closest<HTMLElement>('article.card[id]'); if (info.level > 3 && !card) continue; const target = card ?? element;
        const id = card?.id || element.id || info.sectionId;
        if (!id || !COVERAGE_REGION_ID.test(id) || seen.has(id)) continue;
        seen.add(id); found.push({ id, title: info.title, index: info.index, element: target, top: Math.max(0, target.getBoundingClientRect().top - bounds.top), height: 0 });
      }
      found.sort((a, b) => a.top - b.top);
      for (let i = 0; i < found.length; i++) found[i].height = Math.max(1, (found[i + 1]?.top ?? content.scrollHeight) - found[i].top);
      regionRef.current = found; setRegions(found); updateViewport();
      try {
        observer = new IntersectionObserver(guarded((entries) => { for (const entry of entries) { const id = (entry.target as HTMLElement).dataset.coverageRegion!; if (entry.isIntersecting) visible.add(id); else visible.delete(id); } }), { root: main });
        for (const region of found) {
          const marker = document.createElement('span'); marker.dataset.coverageRegion = region.id; marker.setAttribute('aria-hidden', 'true');
          Object.assign(marker.style, { position: 'absolute', top: `${region.top}px`, height: `${region.height}px`, width: '1px', pointerEvents: 'none' });
          content.appendChild(marker); markers.push(marker); observer.observe(marker);
        }
      } catch (reason) { setError(reason instanceof Error ? `Coverage visibility unavailable: ${reason.message}` : 'Coverage visibility unavailable.'); }
    };
    const schedule = guarded(() => { if (!frame) frame = requestAnimationFrame(guarded(layout)); });
    let previousSelection: { anchor: Node | null; focus: Node | null; start: number; end: number } | undefined;
    const selection = guarded(() => {
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || !selected.toString().trim() || !content.contains(selected.anchorNode) || !content.contains(selected.focusNode)) { previousSelection = undefined; return; }
      if (previousSelection?.anchor === selected.anchorNode && previousSelection.focus === selected.focusNode && previousSelection.start === selected.anchorOffset && previousSelection.end === selected.focusOffset) return;
      previousSelection = { anchor: selected.anchorNode, focus: selected.focusNode, start: selected.anchorOffset, end: selected.focusOffset };
      record(regionFor(selected.anchorNode), 'selection');
    });
    const click = guarded((event: Event) => {
      const target = event.target instanceof Element ? event.target : null; if (!target) return;
      const region = regionFor(target);
      const summary = target.closest('summary'); const detail = summary?.parentElement;
      if (detail instanceof HTMLDetailsElement && detail.classList.contains('deep-dive') && !detail.open) record(region, 'deep');
      if (target.closest('a[href]')) record(region, 'link');
      if (target.closest('[data-markmap-src], [data-mermaid-src]')) record(region, 'map');
    });
    const mapKey = guarded((event: KeyboardEvent) => { if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('[data-markmap-src], [data-mermaid-src]')) record(regionFor(event.target), 'map'); });
    const toggle = guarded(() => schedule());
    const copy = guarded(() => { const selected = window.getSelection(); record(regionFor(selected?.anchorNode ?? document.activeElement), 'copy'); });
    const safeViewport = guarded(updateViewport);
    const resize = new ResizeObserver(schedule); resize.observe(content); resize.observe(main);
    document.addEventListener('selectionchange', selection); content.addEventListener('click', click); content.addEventListener('keydown', mapKey); content.addEventListener('toggle', toggle, true); content.addEventListener('copy', copy);
    main.addEventListener('scroll', safeViewport, { passive: true }); window.addEventListener('resize', schedule);
    const interval = setInterval(guarded(() => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      for (const id of visible) {
        const used = dwell.get(id) ?? 0; if (used >= 15_000) continue;
        dwell.set(id, used + 1000); record(regionRef.current.find((item) => item.id === id), 'dwellMs', 1000);
      }
    }), 1000);
    guarded(layout)();
    return guarded(() => { document.removeEventListener('selectionchange', selection); content.removeEventListener('click', click); content.removeEventListener('keydown', mapKey); content.removeEventListener('toggle', toggle, true); content.removeEventListener('copy', copy); main.removeEventListener('scroll', safeViewport); window.removeEventListener('resize', schedule); resize.disconnect(); clearInterval(interval); observer?.disconnect(); markers.forEach((marker) => marker.remove()); if (frame) cancelAnimationFrame(frame); });
    } catch (error) { reportCoverageError(error); }
  }, [root, headings]);

  const scrollTo = (region: Region) => onJump(region.index);
  const nextUnread = () => {
    const main = root.current?.closest('main'); const content = root.current; if (!main || !content || !regions.length) return;
    const edge = main.getBoundingClientRect().top + 100;
    let current = -1; regions.forEach((region, i) => { if (region.element.getBoundingClientRect().top <= edge) current = i; });
    for (let step = 1; step <= regions.length; step++) { const region = regions[(current + step) % regions.length]; if (coverageScore(snapshot.regions[region.id]) < 1) { scrollTo(region); return; } }
  };
  const reset = async () => {
    resetting.current = true;
    try {
      await flushRef.current();
      if (failure.current || retryBatch.current || Object.keys(pending.current).length) { setError('Resolve unsaved coverage before resetting.'); return; }
      let current: CoverageSnapshot;
      const get = await fetch(endpoint); if (!get.ok) throw new Error(`Coverage unavailable (${get.status}).`); current = parseSnapshot(await get.json());
      if (!window.confirm('Reset all coverage for this cheatsheet? This cannot be undone.')) return;
      const response = await fetch(endpoint, { method: 'DELETE', headers: { 'if-match': `"${current.revision}"` } });
      if (!response.ok) throw new Error(response.status === 409 ? 'Coverage changed while confirming. Try resetting again.' : `Coverage reset failed (${response.status}).`);
      const value = parseSnapshot(await response.json()); generation.current = value.generation; await prepareWriterRef.current(value.generation); localOnly.current = false; setPaused(false); latest.current = value; setSnapshot(value); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Coverage reset failed.'); } finally { resetting.current = false; }
  };
  const retry = () => { failure.current = false; setError(''); if (generation.current === null) { runCoverage(loadRef.current()); return; } runCoverage(flushRef.current()); };
  const main = root.current?.closest('main'); const total = Math.max(1, main?.scrollHeight ?? 1);
  const relative = relativeCoverage(regions.map((region) => snapshot.regions[region.id]));
  const scores = new Map(regions.map((region, index) => [region.id, relative[index]]));
  const rootOffset = main && root.current ? root.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop : 0;
  const atPoint = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(); const position = ((event.clientY - rect.top) / rect.height) * total - rootOffset;
    return [...regions].reverse().find((region) => region.top <= position) ?? regions[0];
  };
  const describePoint = (event: React.MouseEvent<HTMLDivElement>) => {
    const region = atPoint(event); if (!region) return;
    setHint(`${region.title}: ${statusHint(scores.get(region.id) ?? 0)}`);
    const track = event.currentTarget.getBoundingClientRect();
    setHintTop(Math.max(8, Math.min(event.clientY - track.top - 16, track.height - 48)));
  };
  const hideHint = (track: HTMLDivElement) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(guarded(() => { if (document.activeElement !== track) setHintTop(null); }), Math.max(1000, noticeUntil.current - Date.now()));
  };
  return <>
    <Group gap="xs" className="coverage-actions"><Button variant="secondary" onClick={guarded(nextUnread)} disabled={!regions.length}>Next unread region</Button><Button variant="danger" onClick={guarded(() => runCoverage(reset()))} disabled={generation.current === null}>Reset coverage</Button></Group>
    {error && <Group gap="xs"><Text style={{ color: 'var(--ir-color-danger)' }} role="alert" size="sm">{error}</Text><Button variant="subtle" onClick={guarded(retry)}>Retry coverage</Button></Group>}
    <div className="coverage-track" data-paused={paused || undefined} style={{ right: Math.max(8, (main?.offsetWidth ?? 0) - (main?.clientWidth ?? 0)) }} hidden={hidden} role="slider" tabIndex={0} aria-label={paused ? 'Cheatsheet coverage map — Coverage paused: reset to continue recording' : 'Cheatsheet coverage map'} aria-description="Attention relative to this sheet: blue for unvisited, purple for less attention, orange for moderate attention, red for most attention." aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(viewport.top * 100)} aria-valuetext={paused ? 'Coverage paused: reset to continue recording' : hint} title={paused ? 'Coverage paused: reset to continue recording' : hint} onClick={guarded((event: React.MouseEvent<HTMLDivElement>) => { const region = atPoint(event); describePoint(event); noticeUntil.current = Date.now() + 3000; hideHint(event.currentTarget); if (region) scrollTo(region); })} onMouseMove={guarded((event: React.MouseEvent<HTMLDivElement>) => { if (hintTimer.current) clearTimeout(hintTimer.current); describePoint(event); })} onMouseLeave={guarded((event: React.MouseEvent<HTMLDivElement>) => hideHint(event.currentTarget))} onFocus={guarded(() => { setHintTop((top) => top ?? 16); })} onBlur={guarded((event: React.FocusEvent<HTMLDivElement>) => hideHint(event.currentTarget))} onKeyDown={guarded((event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key) || !regions.length) return;
      event.preventDefault(); const main = root.current?.closest('main'); const edge = (main?.getBoundingClientRect().top ?? 0) + 100;
      let current = -1; regions.forEach((region, index) => { if (region.element.getBoundingClientRect().top <= edge) current = index; });
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? regions.length - 1 : Math.max(0, Math.min(regions.length - 1, current + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1)));
      const region = regions[index]; setHint(`${region.title}: ${statusHint(scores.get(region.id) ?? 0)}`); scrollTo(region);
    })}>
      {hintTop !== null && <span className="coverage-tooltip" role="tooltip" style={{ top: hintTop }}>{paused ? 'Coverage paused: reset to continue recording' : hint}</span>}
      <div className="coverage-rail" aria-hidden="true">{regions.map((region) => { const step = colorStep(scores.get(region.id) ?? 0); return <span key={region.id} data-status={step} data-color-step={step} style={{ top: `${((rootOffset + region.top) / total) * 100}%`, height: `${Math.max(0.2, region.height / total * 100)}%` }} />; })}<span className="coverage-viewport" style={{ top: `${viewport.top * 100}%`, height: `${Math.max(1, viewport.height * 100)}%` }} /></div>
    </div>
  </>;
}
