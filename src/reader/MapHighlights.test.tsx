import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transformer } from 'markmap-lib';
import type { MapHighlight } from '../../shared/mapHighlights';
import { MapRecall } from './MapRecall';
import { highlightButtonPosition, useMapHighlights } from './MapHighlights';
import { mapNodeIndex } from './mapHighlightAnchors';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Markmap } from 'markmap-view';
import { readFileSync } from 'node:fs';

function TestMap({ source }: { source: string }) {
  const root = useMemo(() => new Transformer().transform(source).root, [source]);
  const [svg] = useState(() => document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  const map = useRef({ state: { data: root } } as unknown as Markmap);
  const highlights = useMapHighlights({ courseId: 'sample', lessonId: 'map', root, svg, map, mapReady: true, fullscreen: false });
  useEffect(() => {
    for (const entry of mapNodeIndex(root)) {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.classList.add('markmap-node');
      Object.assign(group, { __data__: entry.node });
      const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      const content = document.createElement('div'); content.textContent = entry.text; foreign.append(content); group.append(foreign); svg.append(group);
    }
  }, [root, svg]);
  return <div className="map-recall-surface">{highlights.button}{highlights.status}{highlights.announcer}<div className="map-recall-canvas" tabIndex={-1} ref={(host) => { if (host && svg.parentNode !== host) host.append(svg); }}>{highlights.selectionLayer}</div></div>;
}

async function selectAndHighlight(text: string, start: number, end: number, keyboard = false) {
  const content = [...document.querySelectorAll('foreignObject div')].find((item) => item.textContent === text)!;
  expect(content).toBeTruthy(); const range = document.createRange(); range.setStart(content.firstChild!, start); range.setEnd(content.firstChild!, end);
  range.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 20, right: 40, width: 30, height: 10 } as DOMRect);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); fireEvent(document, new Event('selectionchange'));
  if (keyboard) fireEvent.keyDown(content, { key: 'F10', shiftKey: true });
  else fireEvent.contextMenu(content, { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Highlight' }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe('map highlights', () => {
  it('keeps large counts visible and named in the compact control', async () => {
    const records = Array.from({ length: 512 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), nodeKey: '0'.repeat(16), nodeText: 'Root', lineage: [], quote: 'Root', prefix: '', suffix: '', offset: 0 }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ highlights: records }) })));
    render(<MantineProvider><TestMap source="# Root" /></MantineProvider>);
    const trigger = await screen.findByRole('button', { name: 'Highlights, 512' });
    expect(trigger).toHaveTextContent('512');
    expect(trigger).toHaveAttribute('data-ir-variant', 'accent');
    const css = readFileSync('src/reader/mapRecall.css', 'utf8');
    expect(css).toContain('.map-highlight-trigger { overflow: visible; }');
    expect(trigger.querySelector('.map-highlight-count')).toHaveTextContent('512');
  });
  it('places the selection action above the excerpt, or below when above does not fit, within the map', () => {
    const bounds = { left: 100, top: 100, right: 500, bottom: 400 } as DOMRect;
    expect(highlightButtonPosition({ left: 450, top: 200, bottom: 220 } as DOMRect, bounds, 100, 44)).toEqual({ left: 396, top: 152 });
    expect(highlightButtonPosition({ left: 105, top: 110, bottom: 130 } as DOMRect, bounds, 100, 44)).toEqual({ left: 105, top: 134 });
    expect(highlightButtonPosition({ left: 80, top: 390, bottom: 410 } as DOMRect, bounds, 100, 44)).toEqual({ left: 104, top: 342 });
  });
  it('renders contextual marks in distinct lineage groups, including an orphan', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    const text = `${'before '.repeat(15)}chosen${' after'.repeat(15)}`;
    const source = `# Root\n## One\n- ${text}\n## Two\n- Another note\n`;
    const entries = mapNodeIndex(new Transformer().transform(source).root);
    const make = (nodeText: string, quote: string, id: string): MapHighlight => {
      const entry = entries.find((candidate) => candidate.text === nodeText)!;
      const offset = nodeText.indexOf(quote);
      return { id: id.repeat(32), nodeKey: entry.key, nodeText, quote, offset, prefix: nodeText.slice(Math.max(0, offset - 128), offset), suffix: nodeText.slice(offset + quote.length, offset + quote.length + 128), lineage: entry.lineage, captureAmbiguous: false };
    };
    const anchored = make(text, 'chosen', 'a');
    const orphan = { ...make('Another note', 'note', 'b'), nodeKey: '0'.repeat(16) };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/map-recall/') ? { source } : { highlights: [anchored, orphan], folds: null } })));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Highlights, 2' }));
    expect(screen.queryByRole('tooltip', { name: 'Highlights' })).not.toBeInTheDocument();
    const list = document.querySelector('.map-highlight-tree') as HTMLElement;
    expect(within(list).getByText('Root › One')).toBeInTheDocument();
    expect(within(list).getByText('Root › Two')).toBeInTheDocument();
    const mark = screen.getByText('chosen');
    expect(mark.tagName).toBe('MARK');
    expect(mark.parentElement?.textContent).toMatch(/^….*chosen.*…$/u);
    expect(screen.getByText('Not found in current map')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Remove highlight: note' });
    expect(remove).toHaveClass('ir-icon-button', 'map-highlight-remove');
    expect(remove.querySelector('svg')).toHaveClass('tabler-icon-trash');
    expect(screen.queryByRole('button', { name: /show in map: note/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /select a node/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /text in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Highlight' })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    const css = readFileSync('src/reader/mapRecall.css', 'utf8');
    expect(css).toMatch(/\.map-highlights-popover\s*\{[^}]*user-select:\s*none/);
    expect(css).toMatch(/\.map-highlight-item\s*\{[^}]*padding-inline-end:\s*48px/);
    expect(css).toMatch(/\.map-highlight-snippet\s*\{[^}]*border-inline-start:\s*2px solid var\(--ir-color-border\)/);
    expect(css).toMatch(/\.map-highlight-remove\s*\{[^}]*position:\s*absolute/);
  });
  it('opens the context menu on a mark and deletes it, while background keeps its native menu', async () => {
    const source = '# Root\n- A note\n';
    const node = mapNodeIndex(new Transformer().transform(source).root).find((entry) => entry.text === 'A note')!;
    const highlight: MapHighlight = { id: 'd'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'note', prefix: 'A ', suffix: '', offset: 2, captureAmbiguous: false };
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => ({ highlights: init?.method === 'DELETE' ? [] : [highlight] }) }));
    vi.stubGlobal('fetch', fetcher);
    render(<MantineProvider><TestMap source={source} /></MantineProvider>);
    await screen.findByRole('button', { name: 'Highlights, 1' });
    await waitFor(() => expect(document.querySelector('mark[data-highlight-id]')).toBeTruthy());
    const mark = document.querySelector('mark[data-highlight-id]')!;
    fireEvent.contextMenu(mark, { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove highlight' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true));
    const background = document.querySelector('svg')!;
    expect(fireEvent.contextMenu(background)).toBe(true);
    expect(screen.queryByRole('menuitem', { name: /highlight/i })).not.toBeInTheDocument();
  });
  it('bounds the popover width and keeps it scrollable', () => {
    const css = readFileSync('src/reader/mapRecall.css', 'utf8');
    expect(css).toContain('max-width: calc(100vw - 16px)'); expect(css).toContain('max-height: calc(100dvh - 16px)'); expect(css).toContain('overflow: auto');
    const source = readFileSync('src/reader/MapHighlights.tsx', 'utf8');
    expect(source).toContain('Math.min(768, Math.max(360, mapWidth / 2))');
  });
  it.each([[400, 360], [1000, 500], [2000, 768]])('sizes the list for a %ipx map to %ipx', async (width, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ highlights: [{ id: 'a'.repeat(32), nodeKey: '0'.repeat(16), nodeText: 'Root', lineage: [], quote: 'Root', prefix: '', suffix: '', offset: 0 }] }) })));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { width: this.classList.contains('map-recall-canvas') ? width : 0, height: 600, left: 0, top: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) };
    });
    render(<MantineProvider><TestMap source={'# Root\n- A note'} /></MantineProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Highlights, 1' }));
    expect(await screen.findByText('Not found in current map')).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>('.map-highlights-popover')?.style.width).toBe(`${expected}px`);
  });
  it('creates with keyboard selection, groups by lineage, persists, orphans after a rename, and removes', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    let source = '# Root\n## Branch\n- A quoted note\n';
    let stored: MapHighlight[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source }) };
      if (url.startsWith('/api/map-highlights/')) {
        if (init?.method === 'PUT') stored = [...stored, JSON.parse(String(init.body)) as MapHighlight];
        if (init?.method === 'DELETE') stored = stored.filter((h) => !url.endsWith(h.id));
        return { ok: true, json: async () => ({ highlights: stored }) };
      }
      return { ok: true, json: async () => ({ folds: null }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const element = (value: string) => <MantineProvider><TestMap source={value} /></MantineProvider>;
    const first = render(element(source));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.startsWith('/api/map-highlights/'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Highlights, 0' })).not.toBeInTheDocument();
    await selectAndHighlight('A quoted note', 2, 8, true);
    fireEvent.click(screen.getByRole('button', { name: 'Highlights, 1' }));
    expect(await screen.findByRole('button', { name: 'Highlights, 1' })).toBeInTheDocument();
    await waitFor(() => expect(stored).toHaveLength(1));
    const list = document.querySelector('.map-highlight-tree > li') as HTMLElement;
    expect(within(list).getByText('Root › Branch')).toBeInTheDocument();
    expect(within(list).getByText('quoted').tagName).toBe('MARK');
    expect(within(list).getByText('quoted').parentElement).toHaveTextContent('A quoted note');
    expect(stored[0]).toMatchObject({ quote: 'quoted', lineage: ['Root', 'Branch'] });
    first.unmount();
    source = '# Root\n## Branch\n- Renamed note\n';
    render(element(source));
    fireEvent.click(await screen.findByRole('button', { name: 'Highlights, 1' }));
    expect(await screen.findByText('Not found in current map')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show in map/i })).not.toBeInTheDocument();
    expect(stored).toHaveLength(1);
    expect(screen.getByText('quoted').parentElement).toHaveTextContent('A quoted note');
    fireEvent.click(screen.getByRole('button', { name: 'Remove highlight: quoted' }));
    await waitFor(() => expect(stored).toHaveLength(0));
    expect(screen.queryByRole('button', { name: 'Highlights, 0' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.map-recall-canvas')).toHaveFocus());
  });
  it.each([false, true])('retains a failed save after leaving the lesson (storage failure: %s)', async (storageFailure) => {
    localStorage.setItem('map-recall-view', 'outline');
    if (storageFailure) vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    let stored: MapHighlight[] = []; let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source: '# Root\n- A note\n' }) };
      if (url.startsWith('/api/map-highlights/')) {
        if (init?.method === 'PUT') { if (fail) return { ok: false, status: 503 }; stored = [JSON.parse(String(init.body)) as MapHighlight]; }
        return { ok: true, json: async () => ({ highlights: stored }) };
      }
      return { ok: true, json: async () => ({ folds: null }) };
    }));
    const element = <MantineProvider><TestMap source={'# Root\n- A note\n'} /></MantineProvider>;
    const first = render(element);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/map-highlights/'))).toBe(true));
    await selectAndHighlight('A note', 2, 6);
    expect(await screen.findByText("Highlights couldn't be saved")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Highlights, 1' })).toBeInTheDocument();
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some((key) => key?.startsWith('map-highlights-pending:'))).toBe(!storageFailure);
    first.unmount();
    if (storageFailure) { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); }
    fail = false; render(element);
    await waitFor(() => expect(stored).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Highlights, 1' })).toBeInTheDocument();
    expect(stored[0]?.quote).toBe('note');
  });
  it('honors an explicit removal on another device when replaying a stale create', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    const source = '# Root\n- A note\n';
    const node = mapNodeIndex(new Transformer().transform(source).root).find((entry) => entry.text === 'A note')!;
    const highlight = { id: 'a'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'note', prefix: 'A ', suffix: '', offset: 2 };
    const key = 'map-highlights-pending:sample:map:0001';
    localStorage.setItem(key, JSON.stringify({ method: 'PUT', highlight }));
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source }) };
      if (init?.method === 'PUT') return { ok: false, status: 409, json: async () => ({ removed: true }) };
      return { ok: true, json: async () => ({ highlights: [] }) };
    });
    vi.stubGlobal('fetch', fetcher);
    render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    await waitFor(() => { expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true); expect(localStorage.getItem(key)).toBeNull(); });
    expect(screen.queryByRole('button', { name: 'Highlights, 0' })).not.toBeInTheDocument();
    expect(screen.getByText('Highlight removed on another device.')).toBeInTheDocument();
  });
  it('lets a delete free capacity even when a rejected create is pending across remount', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    const source = '# Root\n- A note\n';
    const node = mapNodeIndex(new Transformer().transform(source).root).find((entry) => entry.text === 'A note')!;
    const original: MapHighlight = { id: 'b'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'note', prefix: 'A ', suffix: '', offset: 2, captureAmbiguous: false };
    let stored = [original]; let full = true;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source }) };
      if (url.startsWith('/api/map-highlights/')) {
        if (init?.method === 'PUT') {
          if (full) return { ok: false, status: 409, json: async () => ({ error: 'Too many highlights' }) };
          stored = [...stored, JSON.parse(String(init.body)) as MapHighlight];
        }
        if (init?.method === 'DELETE') { stored = stored.filter((item) => !url.endsWith(item.id)); full = false; }
        return { ok: true, json: async () => ({ highlights: stored }) };
      }
      return { ok: true, json: async () => ({ folds: null }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const element = <MantineProvider><TestMap source={source} /></MantineProvider>;
    const first = render(element);
    await screen.findByRole('button', { name: 'Highlights, 1' });
    await selectAndHighlight('A note', 0, 1);
    expect(await screen.findByText('Highlight limit reached (512). Remove a saved highlight and retry.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Highlights, 2' })).toBeInTheDocument();
    first.unmount(); render(element);
    expect(await screen.findByText('Highlight limit reached (512). Remove a saved highlight and retry.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Highlights, 2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove highlight: note' }));
    await waitFor(() => { expect(stored).toHaveLength(1); expect(stored[0]!.quote).toBe('A'); });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(screen.getByRole('button', { name: 'Highlights, 1' })).toBeInTheDocument();
    expect(screen.queryByText('Highlight limit reached (512). Remove a saved highlight and retry.')).not.toBeInTheDocument();
  });
  it('loads server highlights and permits edits when local recovery cannot be read', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    localStorage.setItem('map-highlights-pending:sample:map:unreadable', '{}');
    const originalGet = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) => { if (key.includes(':unreadable')) throw new Error('Storage denied'); return originalGet(key); });
    const source = '# Root\n- A note\n';
    const node = mapNodeIndex(new Transformer().transform(source).root).find((entry) => entry.text === 'A note')!;
    const highlight: MapHighlight = { id: 'c'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'note', prefix: 'A ', suffix: '', offset: 2, captureAmbiguous: false };
    let stored = [highlight];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source }) };
      if (init?.method === 'PUT') stored = [...stored, JSON.parse(String(init.body)) as MapHighlight];
      return { ok: true, json: async () => ({ highlights: stored, folds: null }) };
    }));
    render(<MantineProvider><TestMap source={source} /></MantineProvider>);
    expect(await screen.findByText('Local highlight recovery unavailable')).toBeInTheDocument();
    await selectAndHighlight('A note', 0, 1);
    await waitFor(() => expect(stored).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Highlights, 2' })).toBeInTheDocument();
  });
  it('persists capture ambiguity so removing an identical sibling cannot reassign the note', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    let source = '# Root\n- Note\n- Note\n'; let stored: MapHighlight[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source }) };
      if (init?.method === 'PUT') stored = [JSON.parse(String(init.body)) as MapHighlight];
      return { ok: true, json: async () => ({ highlights: stored, folds: null }) };
    }));
    const element = (value: string) => <MantineProvider><TestMap source={value} /></MantineProvider>;
    const first = render(element(source)); await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/map-highlights/'))).toBe(true));
    await selectAndHighlight('Note', 0, 4);
    await waitFor(() => expect(stored[0]?.captureAmbiguous).toBe(true));
    first.unmount(); source = '# Root\n- Note\n'; render(element(source));
    fireEvent.click(await screen.findByRole('button', { name: 'Highlights, 1' }));
    expect(await screen.findByText('Not found in current map')).toBeInTheDocument();
    expect(stored).toHaveLength(1);
  });
});
