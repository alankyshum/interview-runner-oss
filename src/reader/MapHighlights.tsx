import { Alert, Group, Menu, Popover, Stack, Text, Title } from '@mantine/core';
import { Button, IconButton } from '../ui';
import { IconHighlight, IconTrash, IconX } from '@tabler/icons-react';
import type { INode, IPureNode } from 'markmap-common';
import type { Markmap } from 'markmap-view';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MAP_HIGHLIGHT_MAX_RECORDS, validMapHighlight, type MapHighlight } from '../../shared/mapHighlights';
import { anchorMapHighlight, highlightSnippet, mapNodeIndex, type MapNodeEntry } from './mapHighlightAnchors';

type PendingOperation = { key: string; method: 'PUT' | 'DELETE'; highlight: MapHighlight };
type Selection = { entry: MapNodeEntry<IPureNode>; start: number; end: number; rect?: DOMRect };
// Storage can be full or denied. Keep operations in this document across lesson
// navigation and warn before closing until the server has acknowledged them.
const volatileOperations = new Map<string, PendingOperation>();
function warnVolatile(event: BeforeUnloadEvent) { if (volatileOperations.size) { event.preventDefault(); event.returnValue = ''; } }

export function highlightButtonPosition(selection: DOMRect, bounds: DOMRect, width: number, height: number) {
  const padding = 4;
  const left = Math.max(bounds.left + padding, Math.min(selection.left, bounds.right - width - padding));
  const above = selection.top - height - padding;
  const desiredTop = above >= bounds.top + padding ? above : selection.bottom + padding;
  const top = Math.max(bounds.top + padding, Math.min(desiredTop, bounds.bottom - height - padding));
  return { left, top };
}

/** Highlights use per-record requests: a stale tab cannot replace another tab's notes. */
export function useMapHighlights({ courseId, lessonId, root, svg, map, mapReady, fullscreen }: {
  courseId: string; lessonId: string; root: IPureNode; svg: SVGSVGElement; map: RefObject<Markmap | null>; mapReady: boolean; fullscreen: boolean;
}) {
  const path = `/api/map-highlights/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}`;
  const storagePrefix = `map-highlights-pending:${encodeURIComponent(courseId)}:${encodeURIComponent(lessonId)}:`;
  const [highlights, setHighlights] = useState<MapHighlight[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState(false);
  useEffect(() => { if (!opened || highlights.length) return; setOpened(false); requestAnimationFrame(() => { const canvas = svg.closest<HTMLElement>('.map-recall-canvas'); const hidden = canvas?.closest<HTMLElement>('.map-recall-map')?.style.display === 'none'; (hidden ? document.querySelector<HTMLElement>('.map-recall-controls[role=region]') : canvas)?.focus(); }); }, [highlights.length, opened, svg]);
  const [selection, setSelection] = useState<Selection>();
  const [selectionError, setSelectionError] = useState('');
  const [context, setContext] = useState<{ x: number; y: number; selection?: Selection; highlight?: MapHighlight }>();
  const [touchSelection, setTouchSelection] = useState(false);
  const [mapWidth, setMapWidth] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const pending = useRef<PendingOperation[]>([]);
  const operationSequence = useRef(0);
  const flushing = useRef(false);
  const alive = useRef(true);
  const entries = useMemo(() => mapNodeIndex(root), [root]);
  const groups = useMemo(() => {
    const result = new Map<string, { lineage: string[]; highlights: MapHighlight[] }>();
    for (const highlight of highlights) {
      const key = JSON.stringify(highlight.lineage);
      const group = result.get(key) ?? { lineage: highlight.lineage, highlights: [] };
      group.highlights.push(highlight); result.set(key, group);
    }
    return [...result.values()];
  }, [highlights]);
  const flush = useCallback(async () => {
    if (flushing.current || !loaded) return;
    flushing.current = true;
    const attempted = new Set<string>(); const failures = new Map<string, string>();
    while (true) {
      // Deletes can free capacity, and must not wait behind a rejected create.
      const operation = pending.current.find((item) => item.method === 'DELETE' && !attempted.has(item.key))
        ?? pending.current.find((item) => item.method === 'PUT' && !attempted.has(item.key) && !pending.current.some((other) => other.method === 'DELETE' && other.highlight.id === item.highlight.id));
      if (!operation) break;
      attempted.add(operation.key);
      try {
        const response = await fetch(`${path}/${operation.highlight.id}`, { method: operation.method, ...(operation.method === 'PUT' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation.highlight) } : {}) });
        if (!response.ok) {
          const conflict = operation.method === 'PUT' && response.status === 409 ? await response.json() as { removed?: unknown; error?: unknown } : null;
          if (conflict?.error === 'Too many highlights') throw new Error(`Highlight limit reached (${MAP_HIGHLIGHT_MAX_RECORDS}). Remove a saved highlight and retry.`);
          if (conflict?.removed !== true) throw new Error("Highlights couldn't be saved");
          if (alive.current) { setHighlights((items) => items.filter((item) => item.id !== operation.highlight.id)); setAnnouncement('Highlight removed on another device.'); }
        }
        if (volatileOperations.has(operation.key)) {
          volatileOperations.delete(operation.key);
          if (!volatileOperations.size) window.removeEventListener('beforeunload', warnVolatile);
        } else {
          try { localStorage.removeItem(operation.key); }
          catch { if (alive.current) setStorageWarning(true); throw new Error("Highlights couldn't be saved"); }
        }
        pending.current = pending.current.filter((item) => item.key !== operation.key); failures.delete(operation.key);
        if (operation.method === 'DELETE') {
          for (const item of pending.current) if (item.method === 'PUT') { attempted.delete(item.key); failures.delete(item.key); }
        }
      } catch (reason) { failures.set(operation.key, reason instanceof Error ? reason.message : "Highlights couldn't be saved"); }
    }
    flushing.current = false;
    if (alive.current) setError([...failures.values()].find((message) => message.startsWith('Highlight limit reached')) ?? failures.values().next().value ?? '');
  }, [loaded, path]);
  useEffect(() => {
    alive.current = true; let active = true;
    setLoaded(false); setError(''); setStorageWarning(false);
    fetch(path).then(async (response) => {
      if (!response.ok) throw new Error('Highlights unavailable');
      const data = await response.json() as { highlights?: unknown };
      if (!Array.isArray(data.highlights) || !data.highlights.every(validMapHighlight)) throw new Error('Invalid highlights');
      const queue: PendingOperation[] = [];
      try {
        const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key?.startsWith(storagePrefix))).sort();
        for (const key of keys) {
          const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
          if (!value || typeof value !== 'object' || !('method' in value) || (value.method !== 'PUT' && value.method !== 'DELETE') || !('highlight' in value) || !validMapHighlight(value.highlight)) throw new Error('Invalid pending highlights');
          queue.push({ key, method: value.method, highlight: value.highlight });
        }
      } catch { if (active) setStorageWarning(true); }
      for (const operation of volatileOperations.values()) if (operation.key.startsWith(storagePrefix) && !queue.some((item) => item.key === operation.key)) queue.push(operation);
      queue.sort((a, b) => a.key.localeCompare(b.key));
      let records = data.highlights as MapHighlight[];
      for (const operation of queue) records = operation.method === 'PUT' ? [...records.filter((h) => h.id !== operation.highlight.id), operation.highlight] : records.filter((h) => h.id !== operation.highlight.id);
      if (active) { pending.current = queue; setHighlights(records); setLoaded(true); }
    }).catch(() => { if (active) setError("Highlights couldn't be saved"); });
    return () => { active = false; alive.current = false; };
  }, [path, storagePrefix, retry]);
  useEffect(() => { if (loaded) void flush(); }, [flush, loaded]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pending.current.length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => {
    if (!opened && !context && !(touchSelection && selection)) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (context) setContext(undefined);
      else if (opened) setOpened(false);
      else { setSelection(undefined); setTouchSelection(false); window.getSelection()?.removeAllRanges(); }
      requestAnimationFrame(() => trigger.current?.focus());
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [opened, context, touchSelection, selection]);
  useEffect(() => {
    if (!opened) return;
    const update = () => {
      const container = fullscreen ? svg.closest('.map-recall-canvas') : trigger.current?.closest('.map-recall-surface')?.querySelector('.map-recall-canvas');
      setMapWidth(container?.getBoundingClientRect().width || trigger.current?.closest('.map-recall-surface')?.getBoundingClientRect().width || window.innerWidth);
    };
    update(); const observer = new ResizeObserver(update); const element = fullscreen ? svg.closest('.map-recall-canvas') : trigger.current?.closest('.map-recall-surface');
    if (element) observer.observe(element);
    window.addEventListener('resize', update); return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [opened, fullscreen, svg]);
  useLayoutEffect(() => {
    const button = selectionTrigger.current;
    if (!button || !selection?.rect) return;
    const position = () => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      button.style.maxWidth = `${Math.max(0, bounds.width - 8)}px`;
      const size = button.getBoundingClientRect();
      const current = window.getSelection();
      const rect = current && current.rangeCount > 0 && svg.contains(current.anchorNode) ? current.getRangeAt(0).getBoundingClientRect() : selection.rect!;
      const point = highlightButtonPosition(rect, bounds, size.width, size.height);
      button.style.left = `${point.left}px`; button.style.top = `${point.top}px`;
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(svg); observer.observe(button);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [selection, svg]);
  const enqueue = (operation: Omit<PendingOperation, 'key'>) => {
    setError('');
    const key = `${storagePrefix}${String(Date.now()).padStart(16, '0')}:${String(operationSequence.current++).padStart(8, '0')}:${crypto.randomUUID()}`;
    const item = { ...operation, key }; pending.current.push(item);
    try { localStorage.setItem(key, JSON.stringify(operation)); } catch { volatileOperations.set(key, item); window.addEventListener('beforeunload', warnVolatile); setStorageWarning(true); }
    void flush();
  };
  const create = (chosen: Selection) => {
    const { entry, start, end } = chosen; const quote = entry.text.slice(start, end);
    const highlight: MapHighlight = { id: crypto.randomUUID().replaceAll('-', ''), nodeKey: entry.key, nodeText: entry.text, lineage: entry.lineage, quote, prefix: entry.text.slice(Math.max(0, start - 128), start), suffix: entry.text.slice(end, end + 128), offset: start, captureAmbiguous: entry.ambiguous };
    if (!loaded || !validMapHighlight(highlight)) { setSelectionError('Select a shorter passage within one node.'); return false; }
    setHighlights((current) => [...current, highlight]); enqueue({ method: 'PUT', highlight });
    setSelection(undefined); window.getSelection()?.removeAllRanges(); setAnnouncement(`Highlight created. ${highlights.length + 1} highlights.`);
    return true;
  };
  const remove = (highlight: MapHighlight) => { setHighlights((current) => current.filter((item) => item.id !== highlight.id)); enqueue({ method: 'DELETE', highlight }); setAnnouncement(`Highlight removed. ${Math.max(0, highlights.length - 1)} highlights.`); };

  useEffect(() => {
    const select = () => {
      const selected = window.getSelection();
      if (!selected || selected.rangeCount === 0 || selected.isCollapsed) { setSelection(undefined); return; }
      const range = selected.getRangeAt(0);
      const group = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<SVGGElement>('g.markmap-node');
      const first = group(range.startContainer); const last = group(range.endContainer);
      if (!first && !last) return;
      if (!first || first !== last) { setSelection(undefined); setSelectionError('Select text within one node.'); return; }
      const content = first.querySelector('foreignObject');
      const runtime = map.current?.state.data;
      const item = runtime && mapNodeIndex(runtime).find((entry) => entry.node === (first as SVGGElement & { __data__: INode }).__data__);
      if (!content || !item || !content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
      const before = document.createRange(); before.selectNodeContents(content); before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length; const end = start + range.toString().length;
      if (content.textContent !== item.text || item.text.slice(start, end) !== range.toString()) { setSelectionError('Select text within one node.'); setSelection(undefined); return; }
      setSelectionError(''); setSelection({ entry: item, start, end, rect: range.getBoundingClientRect() });
    };
    document.addEventListener('selectionchange', select); return () => document.removeEventListener('selectionchange', select);
  }, [map]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pointer: number | undefined; let startX = 0; let startY = 0;
    let content: Element | null = null; let anchor: { node: Node; offset: number } | undefined;
    const point = (x: number, y: number) => {
      const position = document.caretPositionFromPoint?.(x, y);
      if (position && content?.contains(position.offsetNode)) return { node: position.offsetNode, offset: position.offset };
      const range = document.caretRangeFromPoint?.(x, y);
      return range && content?.contains(range.startContainer) ? { node: range.startContainer, offset: range.startOffset } : undefined;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !(event.target instanceof Element)) { setTouchSelection(false); return; }
      if (pointer !== undefined && event.pointerId !== pointer) { clearTimeout(timer); pointer = undefined; anchor = undefined; setTouchSelection(false); return; }
      setTouchSelection(true);
      content = event.target.closest('foreignObject'); if (!content) return;
      pointer = event.pointerId; startX = event.clientX; startY = event.clientY; anchor = undefined;
      timer = setTimeout(() => {
        const hit = point(startX, startY); if (!hit || hit.node.nodeType !== Node.TEXT_NODE) return;
        const text = hit.node.textContent ?? ''; let start = hit.offset; let end = hit.offset;
        while (start > 0 && !/\s/u.test(text[start - 1]!)) start--;
        while (end < text.length && !/\s/u.test(text[end]!)) end++;
        if (start === end) return;
        anchor = { node: hit.node, offset: start };
        window.getSelection()?.setBaseAndExtent(hit.node, start, hit.node, end);
      }, 450);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      if (!anchor) { if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) clearTimeout(timer); return; }
      const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest('g.markmap-node');
      if (target && target !== content?.closest('g.markmap-node')) {
        window.getSelection()?.removeAllRanges(); setSelection(undefined); setSelectionError('Select text within one node.');
        pointer = undefined; anchor = undefined; return;
      }
      const hit = point(event.clientX, event.clientY);
      if (hit) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, hit.node, hit.offset);
    };
    const up = (event: PointerEvent) => { if (event.pointerId === pointer) { clearTimeout(timer); pointer = undefined; anchor = undefined; } };
    svg.addEventListener('pointerdown', down); svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    return () => { clearTimeout(timer); svg.removeEventListener('pointerdown', down); svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); };
  }, [svg]);

  useEffect(() => {
    if (!mapReady) return;
    const decorate = () => {
      if (!highlights.length && !svg.querySelector('mark[data-highlight-id]')) return;
      const runtime = map.current?.state.data; if (!runtime) return;
      const current = mapNodeIndex(runtime);
      const byNode = new Map(current.map((entry) => [entry.node, entry]));
      const byHighlightNode = new Map<INode, MapHighlight[]>();
      for (const highlight of highlights) {
        const anchored = anchorMapHighlight(highlight, current);
        if (anchored) { const list = byHighlightNode.get(anchored.node) ?? []; list.push(highlight); byHighlightNode.set(anchored.node, list); }
      }
      for (const group of svg.querySelectorAll<SVGGElement>('g.markmap-node')) {
        const node = (group as SVGGElement & { __data__: INode }).__data__;
        const entry = byNode.get(node); const foreign = group.querySelector('foreignObject');
        if (!entry || !foreign) continue;
        const matches = byHighlightNode.get(node) ?? [];
        const signature = JSON.stringify(matches.map((h) => h.id));
        if (foreign.getAttribute('data-highlight-signature') === signature) continue;
        foreign.setAttribute('data-highlight-signature', signature);
        for (const mark of foreign.querySelectorAll('mark[data-highlight-id]')) mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
        const walker = document.createTreeWalker(foreign, NodeFilter.SHOW_TEXT); const nodes: Text[] = [];
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        let offset = 0;
        for (const textNode of nodes) {
          const value = textNode.data; const start = offset; offset += value.length;
          const points = new Set([0, value.length]);
          for (const h of matches) { const a = Math.max(0, h.offset - start); const b = Math.min(value.length, h.offset + h.quote.length - start); if (a < b) { points.add(a); points.add(b); } }
          const sorted = [...points].sort((a, b) => a - b); if (sorted.length === 2 && !matches.some((h) => h.offset <= start && h.offset + h.quote.length >= offset)) continue;
          const fragment = document.createDocumentFragment();
          for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1]!; const b = sorted[i]!; const h = matches.find((item) => item.offset <= start + a && item.offset + item.quote.length >= start + b);
            if (h) { const mark = document.createElement('mark'); mark.dataset.highlightId = h.id; mark.setAttribute('role', 'button'); mark.tabIndex = 0; mark.setAttribute('aria-label', `Remove highlight from ${h.nodeText}`); mark.textContent = value.slice(a, b); fragment.append(mark); }
            else fragment.append(document.createTextNode(value.slice(a, b)));
          }
          textNode.replaceWith(fragment);
        }
      }
    };
    decorate(); const observer = new MutationObserver(decorate); observer.observe(svg, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [highlights, map, mapReady, svg]);
  useEffect(() => {
    const open = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const mark = target?.closest<HTMLElement>('mark[data-highlight-id]');
      if (event instanceof KeyboardEvent && !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || (mark && (event.key === 'Enter' || event.key === ' ')))) return;
      const highlight = mark && svg.contains(mark) && highlights.find((item) => item.id === mark.dataset.highlightId);
      const browserSelection = window.getSelection();
      const selectionNode = browserSelection?.anchorNode;
      const selectedGroup = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)?.closest('g.markmap-node');
      const chosen = selection && browserSelection?.toString().trim() && selectedGroup && svg.contains(selectedGroup) && (!(event instanceof MouseEvent) || target?.closest('g.markmap-node') === selectedGroup) ? selection : undefined;
      if (!highlight && !chosen) return;
      if (event instanceof MouseEvent && !svg.contains(event.target as Node)) return;
      const rect = highlight ? mark!.getBoundingClientRect() : chosen?.rect;
      event.preventDefault(); event.stopPropagation();
      setContext({ x: event instanceof MouseEvent ? event.clientX : rect?.left ?? 8, y: event instanceof MouseEvent ? event.clientY : rect?.bottom ?? 8, highlight: highlight || undefined, selection: highlight ? undefined : chosen });
    };
    document.addEventListener('contextmenu', open); document.addEventListener('keydown', open);
    return () => { document.removeEventListener('contextmenu', open); document.removeEventListener('keydown', open); };
  }, [highlights, selection, svg]);

  const close = () => { setOpened(false); requestAnimationFrame(() => trigger.current?.focus()); };
  const groupItems = (items: MapHighlight[]) => items.map((highlight) => {
    const anchored = anchorMapHighlight(highlight, entries);
    const snippet = highlightSnippet(highlight, anchored?.text);
    return <li key={highlight.id} className="map-highlight-item"><Text className="map-highlight-snippet">{snippet.before}<mark>{snippet.quote}</mark>{snippet.after}</Text>{!anchored && <Text size="sm">Not found in current map</Text>}<IconButton className="map-highlight-remove" variant="subtle" label={`Remove highlight: ${highlight.quote}`} tooltipWithinPortal={!fullscreen} icon={<IconTrash size={16} aria-hidden="true" />} onClick={() => remove(highlight)} /></li>;
  });
  const boundary = fullscreen ? trigger.current?.closest<HTMLElement>('.map-recall-fullscreen-content') ?? undefined : undefined;
  const overflow = { boundary, padding: 8 };
  const button = highlights.length ? <Popover opened={opened} onChange={setOpened} withinPortal={!fullscreen} position="bottom-end" shadow="md" zIndex="var(--ir-z-popover)" middlewares={{ shift: overflow, flip: overflow, size: { ...overflow, apply: ({ availableHeight, availableWidth, elements }) => { elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`; elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`; } } }} transitionProps={{ duration: 0 }} trapFocus={false} closeOnEscape onDismiss={() => requestAnimationFrame(() => trigger.current?.focus())}>
    <Popover.Target><IconButton ref={trigger} variant="accent" className="map-highlight-trigger" label={`Highlights, ${highlights.length}`} tooltipDisabled={opened} icon={<span className="map-highlight-icon"><IconHighlight size={18} aria-hidden="true" /><span className="map-highlight-count" aria-hidden="true">{highlights.length}</span></span>} onClick={() => setOpened((value) => !value)} /></Popover.Target>
    <Popover.Dropdown className="map-highlights-popover" style={{ width: Math.min(768, Math.max(360, mapWidth / 2)) }} p="md" aria-labelledby={headingId}><Stack gap="sm"><Group justify="space-between" wrap="nowrap"><Title id={headingId} order={3} size="h5">Highlights</Title><IconButton label="Close highlights" variant="subtle" icon={<IconX size={20} aria-hidden="true" />} onClick={close} /></Group>
      {!loaded && !error && <Text>Loading highlights…</Text>}
      {loaded && highlights.length === 0 && <Text>No highlights yet. Select text in the map, then right-click and choose Highlight.</Text>}
      {highlights.length > 0 && <ul className="map-highlight-tree">{groups.map((group) => <li key={JSON.stringify(group.lineage)}><Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{group.lineage.join(' › ') || 'Map'}</Text><ul>{groupItems(group.highlights)}</ul></li>)}</ul>}
    </Stack></Popover.Dropdown>
  </Popover> : null;
  const selectionLayer = <>{selectionError && <Text role="status">{selectionError}</Text>}{touchSelection && selection?.rect && <Button ref={selectionTrigger} variant="secondary" className="map-highlight-floating" disabled={!loaded} onPointerDown={(event) => event.preventDefault()} onClick={() => { if (create(selection)) setTouchSelection(false); }}>Highlight</Button>}
    <Menu opened={Boolean(context)} onChange={(open) => { if (!open) setContext(undefined); }} withinPortal={!fullscreen} position="bottom-start" shadow="md" zIndex="var(--ir-z-popover)" transitionProps={{ duration: 0 }}>
      <Menu.Target><button type="button" tabIndex={-1} aria-hidden="true" className="map-context-anchor" style={{ left: context?.x ?? 0, top: context?.y ?? 0 }} /></Menu.Target>
      <Menu.Dropdown>{context?.highlight ? <Menu.Item mih={44} onClick={() => { remove(context.highlight!); setContext(undefined); }}>Remove highlight</Menu.Item> : <Menu.Item mih={44} disabled={!loaded} onClick={() => { if (context?.selection) create(context.selection); setContext(undefined); }}>Highlight</Menu.Item>}</Menu.Dropdown>
    </Menu>
  </>;
  const announcer = <span className="map-highlight-live" aria-live="polite">{announcement}</span>;
  const status = <>{storageWarning && <Alert color="yellow" role="status" title="Local highlight recovery unavailable">Unsaved changes may be lost if this tab closes.</Alert>}{error && <Alert color="red" role="alert" title={error}><Button mih={44} onClick={() => { setError(''); if (!loaded) setRetry((value) => value + 1); else void flush(); }}>Retry</Button></Alert>}</>;
  return { button, selectionLayer, opened: opened || Boolean(context), status, announcer };
}
