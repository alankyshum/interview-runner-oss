import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transformer } from 'markmap-lib';
import { MapRecall } from './MapRecall';
import * as navigation from './mapNavigation';
import { MAP_MAX_WIDTH } from './mapWidth';
import { mapNodeIndex } from './mapHighlightAnchors';
import type { MapHighlight } from '../../shared/mapHighlights';

const mock = vi.hoisted(() => ({ instance: null as any, options: null as null | { maxWidth: number }, wide: false, delaySetData: false, failSetData: false, finishSetData: null as null | (() => void), delayFit: false, finishFit: null as null | (() => void) }));
vi.mock('markmap-view', () => {
  class Transform {
    constructor(public k = 1, public x = 0, public y = 0) {}
    translate(x: number, y: number) { return new Transform(this.k, this.x + this.k * x, this.y + this.k * y); }
    scale(k: number) { return new Transform(this.k * k, this.x, this.y); }
  }
  return { Markmap: class {
  state: any = {};
  options = { fitRatio: 0.9, maxInitialScale: 1, maxWidth: 0 };
  svg: any;
  transform = new Transform();
  filter: (event: any) => boolean = () => true;
  listeners: Record<string, (event: any) => void> = {};
  zoom = { filter: (fn: (event: any) => boolean) => { this.filter = fn; return this.zoom; }, on: (name: string, handler: (event: any) => void) => { this.listeners[name] = handler; return this.zoom; }, transform: (_selection: unknown, value: Transform) => { this.transform = value; } };
  constructor(element: SVGElement, options: { maxWidth: number }) { mock.options = options; this.options = { ...this.options, ...options }; this.svg = { on: () => this.svg, node: () => element, property: () => this.transform, call: (fn: (selection: unknown, value: Transform) => void, value: Transform) => { fn(this.svg, value); return this.svg; } }; mock.instance = this; }
  moveViewport = (k: number, x: number, y: number) => { this.transform = new Transform(k, x, y); const event = { transform: this.transform, sourceEvent: { type: 'wheel' } }; this.listeners['zoom.viewport']?.(event); this.listeners['end.viewport']?.(event); };
  programmaticViewport = (k: number, x: number, y: number, end = true) => { this.transform = new Transform(k, x, y); this.listeners['zoom.viewport']?.({ transform: this.transform, sourceEvent: null }); if (end) this.listeners['end.viewport']?.({ transform: this.transform }); };
  setData = async (data: any) => { if (mock.failSetData) { mock.failSetData = false; throw new Error('layout failed'); } this.state.data = data; const visit = (node: any) => { node.state = { rect: { x: 0, y: 0, width: mock.wide ? 10000 : 10, height: 10 } }; node.children.forEach(visit); }; visit(data); if (mock.delaySetData) { mock.delaySetData = false; await new Promise<void>((resolve) => { mock.finishSetData = resolve; }); } };
  toggleNode = async (node: any) => { node.payload = { ...node.payload, fold: node.payload?.fold ? 0 : 1 }; };
  renderData = vi.fn(async () => {});
  fit = vi.fn(async () => { if (mock.delayFit) { mock.delayFit = false; await new Promise<void>((resolve) => { mock.finishFit = resolve; }); } });
  centerNode = vi.fn(async () => {});
  rescale = async () => {};
  destroy = () => {};
} };
});

let intersection: (visible: boolean) => void;
let fetcher: ReturnType<typeof vi.fn>;
let responseState: unknown;
let failSave: boolean;
let source: string;
let highlights: MapHighlight[];
const puts = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); responseState = null; failSave = false; mock.wide = false; mock.delaySetData = false; mock.failSetData = false; mock.finishSetData = null; mock.delayFit = false; mock.finishFit = null; source = '# Root\n\n## Branch\n\n### Child'; highlights = [];
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, _options: unknown, callback: (lock: unknown) => unknown) => { if (held.has(name)) return Promise.resolve(callback(null)); held.add(name); return Promise.resolve(callback({ name })).finally(() => held.delete(name)); } } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersection = (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    observe() {} disconnect() {} unobserve() {}
  });
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => ({ source }) };
    if (url.startsWith('/api/map-highlights/')) return { ok: true, json: async () => ({ highlights }) };
    if (init?.method === 'PUT') return { ok: !failSave, json: async () => ({ applied: true, sequence: JSON.parse(String(init.body)).sequence }) };
    return responseState === 'fail' ? { ok: false } : { ok: true, json: async () => ({ folds: responseState }) };
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); delete (navigator as any).locks; delete (document as any).visibilityState; });

async function openMap() {
  const result = render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
  await screen.findByText('Reference · not counted');
  usableMapSize();
  vi.useFakeTimers();
  await act(async () => { intersection(true); });
  expect(mock.instance.state.data).toBeTruthy();
  return result;
}
function usableMapSize() {
  const svg = document.querySelector<SVGSVGElement>('.map-recall-svg svg')!;
  if (!svg.getBoundingClientRect().width) svg.getBoundingClientRect = () => ({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
}
async function toggle() { await act(async () => { await mock.instance.toggleNode(mock.instance.state.data.children[0]); }); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); }

describe('map fold persistence', () => {
  it('references the map actions menu only while open', async () => {
    const result = await openMap();
    const trigger = screen.getByRole('button', { name: 'More map actions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    fireEvent.click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const id = trigger.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(screen.getByRole('menu')).toBe(document.getElementById(id!));
    fireEvent.click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    result.unmount();
  });
  it('uses the shared wide default for drill maps', async () => {
    const result = await openMap();
    expect(mock.options?.maxWidth).toBe(MAP_MAX_WIDTH);
    expect(mock.instance.options.maxWidth).toBe(268);
    result.unmount();
  });
  it('keeps an authored frontmatter maximum width', async () => {
    source = '---\nmarkmap:\n  maxWidth: 420\n---\n# Root\n\n## Branch';
    const result = await openMap();
    expect(mock.options?.maxWidth).toBe(420);
    expect(mock.instance.options.maxWidth).toBe(268);
    result.unmount();
  });
  it.each([undefined, 420])('reflows an untouched drill on resize up to its cap %s', async (authored) => {
    if (authored) source = `---\nmarkmap:\n  maxWidth: ${authored}\n---\n# Root\n\n## Branch`;
    const observers: Array<{ callback: ResizeObserverCallback; target: Element }> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { observers.push({ callback: this.callback, target }); }
      disconnect() {} unobserve() {}
    });
    const result = await openMap();
    const svg = document.querySelector<SVGSVGElement>('.map-recall-svg svg')!;
    const observer = observers.find((item) => item.target === svg)!; let width = 1800;
    svg.getBoundingClientRect = () => ({ width, height: 600 }) as DOMRect;
    await act(async () => { observer.callback([], {} as ResizeObserver); await vi.advanceTimersByTimeAsync(120); });
    expect(mock.instance.options.maxWidth).toBe(authored ?? MAP_MAX_WIDTH);
    width = 100;
    await act(async () => { observer.callback([], {} as ResizeObserver); await vi.advanceTimersByTimeAsync(120); });
    expect(mock.instance.options.maxWidth).toBe(120);
    fireEvent.pointerDown(svg); width = 1800;
    await act(async () => { observer.callback([], {} as ResizeObserver); await vi.advanceTimersByTimeAsync(120); });
    expect(mock.instance.options.maxWidth).toBe(120);
    result.unmount();
  });
  it('announces map loading until the hidden layout is ready', async () => {
    mock.delaySetData = true;
    const result = render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    await screen.findByText('Reference · not counted');
    usableMapSize();
    expect(screen.getByRole('status')).toHaveTextContent('Loading map…');
    await act(async () => { intersection(true); });
    const svg = document.querySelector('.map-recall-svg svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true'); expect(svg).toHaveStyle({ opacity: '0' });
    expect(svg.parentElement).toHaveAttribute('aria-busy', 'true');
    await act(async () => { mock.finishSetData?.(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Drag to pan · pinch or use the zoom buttons')).not.toBeInTheDocument();
    expect(svg).not.toHaveAttribute('aria-hidden'); expect(svg).not.toHaveStyle({ opacity: '0' });
    expect(svg.parentElement).toHaveAttribute('aria-busy', 'false'); result.unmount();
  });
  it('keeps the map hidden and busy until the initial fit finishes', async () => {
    mock.delayFit = true;
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const result = render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    await screen.findByText('Reference · not counted');
    act(() => { intersection(true); });
    await vi.waitFor(() => expect(mock.finishFit).toBeTypeOf('function'));
    const svg = document.querySelector('.map-recall-svg svg')!;
    expect(screen.getByRole('status')).toHaveTextContent('Loading map');
    expect(svg).toHaveAttribute('aria-hidden', 'true'); expect(svg.parentElement).toHaveAttribute('aria-busy', 'true');
    await act(async () => { mock.finishFit?.(); });
    expect(svg).not.toHaveAttribute('aria-hidden'); expect(svg.parentElement).toHaveAttribute('aria-busy', 'false');
    result.unmount(); rect.mockRestore();
  });
  it('keeps loading until a zero-sized map can be laid out and fitted', async () => {
    const observers: Array<{ callback: ResizeObserverCallback; target: Element }> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { observers.push({ callback: this.callback, target }); }
      disconnect() {} unobserve() {}
    });
    let width = 0;
    const result = render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    await screen.findByText('Reference · not counted');
    const svg = document.querySelector<SVGSVGElement>('.map-recall-svg svg')!;
    svg.getBoundingClientRect = () => ({ width, height: width, x: 0, y: 0, left: 0, top: 0, right: width, bottom: width, toJSON: () => ({}) });
    await act(async () => { intersection(true); });
    expect(mock.instance.state.data).toBeTruthy(); expect(screen.getByRole('status')).toHaveTextContent('Loading map');
    expect(svg).toHaveAttribute('aria-hidden', 'true'); expect(svg.parentElement).toHaveAttribute('aria-busy', 'true');
    width = 300;
    await act(async () => { for (const observer of observers.filter((item) => item.target === svg)) observer.callback([], {} as ResizeObserver); });
    await vi.waitFor(() => expect(svg.parentElement).toHaveAttribute('aria-busy', 'false'));
    expect(mock.instance.fit).toHaveBeenCalled(); expect(svg).not.toHaveAttribute('aria-hidden'); result.unmount();
  });
  it('pans only for an explicitly activated node, not a programmatic toggle', async () => {
    const focus = vi.spyOn(navigation, 'focusExpandedBranch').mockResolvedValue();
    const result = await openMap();
    await toggle(); expect(focus).not.toHaveBeenCalled();
    const svg = document.querySelector('.map-recall-svg svg')!;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.classList.add('markmap-node');
    (group as SVGGElement & { __data__: unknown }).__data__ = mock.instance.state.data.children[0];
    group.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'circle')); svg.appendChild(group);
    await act(async () => { await Promise.resolve(); });
    const hit = group.querySelector('rect.map-toggle-hit')!; expect(hit).toBeTruthy();
    await act(async () => { fireEvent.keyDown(hit, { key: 'Enter' }); });
    expect(focus).toHaveBeenCalledTimes(1); expect(focus).toHaveBeenCalledWith(mock.instance, mock.instance.state.data.children[0]);
    result.unmount(); focus.mockRestore();
  });
  it('replaces loading with an error and recovers on retry', async () => {
    mock.failSetData = true;
    const result = render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    await screen.findByText('Reference · not counted');
    usableMapSize();
    await act(async () => { intersection(true); });
    expect(await screen.findByRole('alert')).toHaveTextContent('layout failed');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('.map-recall-svg')).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => { intersection(true); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Drag to pan · pinch or use the zoom buttons')).not.toBeInTheDocument(); result.unmount();
  });
  it('remeasures loaded images without overriding a learner-controlled view', async () => {
    const result = await openMap();
    const svg = document.querySelector('.map-recall-svg svg')!;
    const image = document.createElement('img'); svg.appendChild(image);
    const rendered = mock.instance.renderData.mock.calls.length; const fitted = mock.instance.fit.mock.calls.length;
    await act(async () => { fireEvent.load(image); await vi.advanceTimersByTimeAsync(20); });
    expect(mock.instance.renderData.mock.calls.length).toBeGreaterThan(rendered);
    expect(mock.instance.fit.mock.calls.length).toBeGreaterThan(fitted);
    fireEvent.pointerDown(svg);
    const afterRender = mock.instance.renderData.mock.calls.length; const afterFit = mock.instance.fit.mock.calls.length;
    await act(async () => { fireEvent.load(image); await vi.advanceTimersByTimeAsync(20); });
    expect(mock.instance.renderData.mock.calls.length).toBeGreaterThan(afterRender);
    expect(mock.instance.fit.mock.calls.length).toBe(afterFit);
    result.unmount();
  });
  it('only writes a changed snapshot at the minute tick, not an undone change', async () => {
    const result = await openMap();
    await tick(); expect(puts()).toHaveLength(0);
    await toggle(); await toggle(); await tick(); expect(puts()).toHaveLength(0);
    await toggle(); await tick(); expect(puts()).toHaveLength(1);
    await tick(); expect(puts()).toHaveLength(1);
    result.unmount(); expect(puts()).toHaveLength(1);
  });
  it('flushes once on hide, stops ticks, and does not flush again on unmount', async () => {
    const result = await openMap(); await toggle();
    await act(async () => { intersection(false); });
    expect(puts()).toHaveLength(1); expect(puts()[0][1]?.keepalive).toBe(true);
    await tick(); result.unmount(); expect(puts()).toHaveLength(1);
  });
  it('flushes a dirty unmount, but never a clean one', async () => {
    const result = await openMap(); await toggle(); result.unmount(); expect(puts()).toHaveLength(1); expect(puts()[0][1]?.keepalive).toBe(true);
  });
  it('does not load or start saving until the SVG is on screen', async () => {
    const result = render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    await screen.findByText('Reference · not counted'); vi.useFakeTimers(); await tick();
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith('/api/map-fold-state/'))).toHaveLength(0);
    result.unmount();
  });
  it('sends the final snapshot even when an older save is still pending', async () => {
    const result = await openMap(); let resolveFirst!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && puts().length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { ok: true, json: async () => ({ applied: true, sequence: JSON.parse(String(init?.body)).sequence }) };
    });
    await toggle(); await tick(); expect(puts()).toHaveLength(1);
    await toggle(); await act(async () => { intersection(false); });
    expect(puts()).toHaveLength(2); expect(puts()[1][1]?.keepalive).toBe(true);
    const older = JSON.parse(String(puts()[0][1]?.body)); const newer = JSON.parse(String(puts()[1][1]?.body));
    expect(newer.writer).toBe(older.writer); expect(newer.sequence).toBeGreaterThan(older.sequence);
    await act(async () => { resolveFirst({ ok: true, json: async () => ({ applied: false, sequence: JSON.parse(String(puts()[1][1]?.body)).sequence }) }); }); result.unmount();
  });
  it('flushes with keepalive when the same snapshot has an unacknowledged tick save', async () => {
    const result = await openMap(); let resolveFirst!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && puts().length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { ok: true, json: async () => ({ applied: true, sequence: JSON.parse(String(init?.body)).sequence }) };
    });
    await toggle(); await tick(); await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(2); expect(puts()[1][1]?.keepalive).toBe(true);
    result.unmount(); expect(puts()).toHaveLength(2); await act(async () => { resolveFirst({ ok: true, json: async () => ({ applied: false, sequence: JSON.parse(String(puts()[1][1]?.body)).sequence }) }); });
  });
  it('accepts a stale acknowledgement of a newer accepted save without retrying', async () => {
    const result = await openMap(); let resolveFirst!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && puts().length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      if (init?.method === 'PUT') throw new Error('response lost');
      return { ok: true, json: async () => ({ folds: null }) };
    });
    await toggle(); await tick(); await toggle(); await tick(); expect(puts()).toHaveLength(2);
    const latest = JSON.parse(String(puts()[1][1]?.body));
    await act(async () => { resolveFirst({ ok: true, json: async () => ({ applied: false, sequence: latest.sequence }) }); });
    await tick(); expect(puts()).toHaveLength(2); result.unmount();
  });
  it('advances past an unknown server sequence instead of retrying stale numbers', async () => {
    const result = await openMap();
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => puts().length === 1 ? { applied: false, sequence: 500 } : { applied: true, sequence: JSON.parse(String(init?.body)).sequence } }));
    await toggle(); await tick(); await tick(); await tick();
    expect(puts()).toHaveLength(2); expect(JSON.parse(String(puts()[1][1]?.body)).sequence).toBe(501); result.unmount();
  });
  it('flushes when switching to text and when the page is hidden', async () => {
    const result = await openMap(); await toggle();
    fireEvent.click(screen.getByRole('radio', { name: 'Text outline' }));
    expect(puts()).toHaveLength(1); result.unmount(); expect(puts()).toHaveLength(1);
  });
  it('flushes on tab hide and resumes checks after the tab is visible', async () => {
    const result = await openMap(); await toggle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(puts()).toHaveLength(1); await tick(); expect(puts()).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await toggle(); await tick(); expect(puts()).toHaveLength(2); result.unmount();
  });
  it('flushes on pagehide only once', async () => {
    const result = await openMap(); await toggle();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(1); await tick(); result.unmount(); expect(puts()).toHaveLength(1);
  });
  it('does not save programmatic auto-folding', async () => {
    mock.wide = true;
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const result = await openMap(); expect(mock.instance.state.data.children[0].payload.fold).toBe(1);
    await tick(); result.unmount(); expect(puts()).toHaveLength(0); rect.mockRestore();
  });
  it('does not write for zoom or fit', async () => {
    const result = await openMap();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })); fireEvent.click(screen.getByRole('button', { name: 'Fit visible' }));
    await tick(); result.unmount(); expect(puts()).toHaveLength(0);
  });
  it('reserves node text for selection while allowing background pan and two-finger pinch', async () => {
    const result = await openMap();
    const svg = document.querySelector('.map-recall-svg svg')!;
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject'); svg.append(foreign);
    expect(mock.instance.filter({ type: 'mousedown', target: foreign, button: 0 })).toBe(false);
    expect(mock.instance.filter({ type: 'mousedown', target: svg, button: 0 })).toBe(true);
    expect(mock.instance.filter({ type: 'touchstart', target: foreign, touches: [{}, {}] })).toBe(true);
    expect(mock.instance.filter({ type: 'wheel', target: foreign, ctrlKey: true })).toBe(true);
    result.unmount();
  });
  it('keeps named map controls discoverable with tooltips', async () => {
    const result = await openMap();
    for (const name of ['Zoom out', 'Zoom in', 'Fit visible', 'Fullscreen']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-label', name);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Zoom in' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Zoom in'); result.unmount();
  });
  it('keeps map actions wrapping when the highlights popover opens', async () => {
    highlights = [{ id: 'a'.repeat(32), nodeKey: '0'.repeat(16), nodeText: 'Root', lineage: [], quote: 'Root', prefix: '', suffix: '', offset: 0 }];
    const result = await openMap();
    const actions = screen.getByRole('region', { name: 'Map actions' });
    const controls = screen.getByRole('region', { name: 'Map controls' });
    const highlightButton = screen.getByRole('button', { name: 'Highlights, 1' });
    expect(highlightButton).toHaveTextContent('1');
    expect(highlightButton).toHaveClass('map-highlight-trigger');
    expect(controls.lastElementChild).toHaveClass('map-highlight-control');
    expect(controls.lastElementChild).toContainElement(highlightButton);
    expect(actions).not.toContainElement(highlightButton);
    expect(actions.style.getPropertyValue('--group-wrap')).toBe('wrap');
    fireEvent.click(highlightButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByRole('button', { name: 'Close highlights' })).toBeVisible();
    expect(actions.style.getPropertyValue('--group-wrap')).toBe('wrap');
    expect(actions).not.toHaveStyle({ overflowX: 'auto' });
    result.unmount();
  });
  it('omits the highlights control and separator when no highlights exist', async () => {
    const result = await openMap();
    expect(screen.queryByRole('button', { name: /Highlights,/ })).not.toBeInTheDocument();
    expect(document.querySelector('.map-highlight-control')).toBeNull();
    result.unmount();
  });
  it('removes map actions from the text outline without saving the view switch', async () => {
    const result = await openMap();
    fireEvent.click(screen.getByRole('radio', { name: 'Text outline' }));
    expect(screen.getByRole('navigation', { name: 'Text outline' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More map actions' })).not.toBeInTheDocument();
    expect(screen.queryByText('Drag to pan · pinch or use the zoom buttons')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Map' })); await tick(); expect(puts()).toHaveLength(0); result.unmount();
  });
  it('shows highlights from outline without changing view or folded paths', async () => {
    const focus = vi.spyOn(navigation, 'focusExpandedBranch').mockResolvedValue();
    source += '\n\n## Other\n\n### Other child';
    const node = mapNodeIndex(new Transformer().transform(source).root).find((entry) => entry.text === 'Child')!;
    highlights = [{ id: 'a'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'Child', prefix: '', suffix: '', offset: 0, captureAmbiguous: false }];
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const result = await openMap();
    await act(async () => { await mock.instance.toggleNode(mock.instance.state.data.children[0]); await mock.instance.toggleNode(mock.instance.state.data.children[1]); });
    fireEvent.click(screen.getByRole('radio', { name: 'Text outline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Highlights, 1' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByRole('radio', { name: 'Text outline' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /show in map/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove highlight: Child' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Text outline' })).toBeChecked();
    expect(mock.instance.state.data.children[0].payload.fold).toBe(1);
    expect(mock.instance.state.data.children[1].payload.fold).toBe(1);
    expect(mock.instance.centerNode).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    result.unmount(); rect.mockRestore(); focus.mockRestore();
  });
  it('selects a node word on touch long-press and extends it with a drag', async () => {
    const result = await openMap(); expect(screen.queryByRole('button', { name: 'Select text' })).not.toBeInTheDocument();
    const svg = document.querySelector<SVGSVGElement>('.map-recall-svg svg')!;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.classList.add('markmap-node');
    (group as SVGGElement & { __data__: unknown }).__data__ = mock.instance.state.data.children[0].children[0];
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    const text = document.createElement('div'); text.textContent = 'Child'; foreign.appendChild(text); group.appendChild(foreign); svg.appendChild(group);
    const caret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: (x: number) => ({ offsetNode: text.firstChild, offset: x < 10 ? 1 : 4 }) });
    const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, bottom: 20 }) });
    const pointer = (type: string, x: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 5 }); Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 1 } }); fireEvent(text, event); };
    await act(async () => { pointer('pointerdown', 5); await vi.advanceTimersByTimeAsync(500); document.dispatchEvent(new Event('selectionchange')); });
    expect(window.getSelection()?.toString()).toBe('Child');
    await act(async () => { pointer('pointermove', 20); document.dispatchEvent(new Event('selectionchange')); });
    expect(window.getSelection()?.toString()).toBe('Chil');
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeEnabled();
    const other = document.createElementNS('http://www.w3.org/2000/svg', 'g'); other.classList.add('markmap-node'); svg.appendChild(other);
    const elementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => other });
    await act(async () => { pointer('pointermove', 30); });
    expect(screen.getByText('Select text within one node.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Highlight' })).not.toBeInTheDocument();
    pointer('pointerup', 20); window.getSelection()?.removeAllRanges(); result.unmount();
    if (caret) Object.defineProperty(document, 'caretPositionFromPoint', caret); else delete (document as Partial<Document>).caretPositionFromPoint;
    if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect); else delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    if (elementFromPoint) Object.defineProperty(document, 'elementFromPoint', elementFromPoint); else delete (document as Partial<Document>).elementFromPoint;
  });
  it('reparents the same SVG into fullscreen, retains one exit and restores focus without saving', async () => {
    highlights = [{ id: 'a'.repeat(32), nodeKey: '0'.repeat(16), nodeText: 'Root', lineage: [], quote: 'Root', prefix: '', suffix: '', offset: 0 }];
    const result = await openMap(); const svg = document.querySelector('.map-recall-svg svg');
    const trigger = screen.getByRole('button', { name: 'Fullscreen' }); trigger.focus(); fireEvent.click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Zoom in' })).toBeVisible();
    expect(within(dialog).getAllByRole('button', { name: 'Exit fullscreen' })).toHaveLength(1);
    expect(within(dialog).queryByRole('radio', { name: 'Text outline' })).not.toBeInTheDocument();
    expect(dialog.querySelector('.map-recall-svg svg')).toBe(svg);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Highlights, 1' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(within(dialog).getByRole('button', { name: 'Close highlights' })).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(within(dialog).queryByRole('button', { name: 'Close highlights' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Zoom in' }), { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toHaveFocus();
    expect(document.querySelector('.map-recall-svg svg')).toBe(svg); await tick(); expect(puts()).toHaveLength(0); result.unmount();
  });
  it('saves collapse, expand and reset actions on the same cadence', async () => {
    const result = await openMap();
    const action = async (name: string) => { fireEvent.click(screen.getByRole('button', { name: 'More map actions' })); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); fireEvent.click(screen.getByRole('menuitem', { name })); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); };
    await action('Collapse all');
    await tick(); expect(puts()).toHaveLength(1);
    await action('Expand all');
    await tick(); expect(puts()).toHaveLength(2);
    await toggle();
    await action('Reset view');
    await tick(); expect(puts()).toHaveLength(2);
    result.unmount();
  });
  it('offers an explicit full-tree overview without making it the expansion default', async () => {
    const result = await openMap();
    mock.instance.state.data.children[0].payload = { fold: 1 };
    const before = mock.instance.fit.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Fit all' })); });
    expect(mock.instance.state.data.children[0].payload.fold).toBe(0);
    expect(mock.instance.fit.mock.calls.length).toBe(before + 1);
    result.unmount();
  });
  it('keeps highlights when resetting the map view', async () => {
    const node = mapNodeIndex(new Transformer().transform(source).root).find((entry) => entry.text === 'Child')!;
    highlights = [{ id: 'a'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'Child', prefix: '', suffix: '', offset: 0, captureAmbiguous: false }];
    const result = await openMap();
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Reset view' })); });
    expect(screen.getByRole('button', { name: 'Highlights, 1' })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    result.unmount();
  });
  it('captures reset synchronously before setData finishes, including same-turn pagehide', async () => {
    const result = await openMap(); await toggle(); await tick();
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    mock.delaySetData = true;
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Reset view' })); window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(2); expect(puts()[1][1]?.keepalive).toBe(true);
    expect(JSON.parse(String(puts()[1][1]?.body)).folds).toBeNull();
    await act(async () => { mock.finishSetData?.(); }); result.unmount();
  });
  it.each(['Collapse all', 'Expand all'])('captures %s synchronously on pagehide', async (name) => {
    const result = await openMap();
    if (name === 'Expand all') { await toggle(); await tick(); }
    const before = puts().length;
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name })); window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(before + 1); expect(puts().at(-1)?.[1]?.keepalive).toBe(true); result.unmount();
  });
  it('does not save a reset that leaves the default unchanged', async () => {
    const result = await openMap(); fireEvent.click(screen.getByRole('button', { name: 'More map actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Reset view' })); window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(0); result.unmount();
  });
  it('uses the current viewport when resetting a saved layout', async () => {
    mock.wide = true; let width = 300;
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 300, x: 0, y: 0, left: 0, top: 0, right: width, bottom: 300, toJSON: () => ({}) }));
    const first = await openMap(); await toggle(); await tick(); await toggle(); await tick();
    responseState = JSON.parse(String(puts()[1][1]?.body)).folds; first.unmount(); vi.useRealTimers();
    const second = await openMap(); width = 20000;
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' })); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Reset view' })); window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(3); expect(JSON.parse(String(puts()[2][1]?.body)).folds).toBeNull();
    second.unmount(); rect.mockRestore();
  });
  it('does not rewrite an already saved default after a viewport change', async () => {
    mock.wide = true; let width = 300;
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 300, x: 0, y: 0, left: 0, top: 0, right: width, bottom: 300, toJSON: () => ({}) }));
    const result = await openMap(); width = 20000;
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' })); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Reset view' })); window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(0); result.unmount(); rect.mockRestore();
  });
  it('never sends a partial snapshot when a map exceeds the limit', async () => {
    source = '# Root\n' + Array.from({ length: 2048 }, (_, i) => `\n## Branch ${i}\n\n### Child ${i}\n`).join('');
    const result = await openMap(); await toggle(); await tick();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(puts()).toHaveLength(0); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); result.unmount();
  });
  it('retries failures on the next visible tick', async () => {
    const result = await openMap(); failSave = true; await toggle(); await tick(); expect(puts()).toHaveLength(1);
    failSave = false; await tick(); expect(puts()).toHaveLength(2); result.unmount(); expect(puts()).toHaveLength(2);
  });
  it('does not save after a failed state load', async () => {
    responseState = 'fail'; const result = await openMap(); await toggle(); await tick(); result.unmount(); expect(puts()).toHaveLength(0);
  });
  it('debounces the local viewport, flushes on hide and restores it without an initial fit', async () => {
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const key = 'map-viewport:sample:map'; const first = await openMap();
    act(() => mock.instance.moveViewport(1.75, -24, 93));
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ k: 1.75, x: -24, y: 93 });
    act(() => mock.instance.moveViewport(2, 42, -5));
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ k: 2, x: 42, y: -5 });
    first.unmount(); vi.useRealTimers();
    const second = await openMap();
    expect(mock.instance.transform).toMatchObject({ k: 2, x: 42, y: -5 });
    expect(mock.instance.fit).not.toHaveBeenCalled();
    expect(document.querySelector('.map-recall-svg svg')).not.toHaveAttribute('aria-hidden');
    expect(puts()).toHaveLength(0); second.unmount(); rect.mockRestore();
  });
  it('clamps a wholly offscreen restored viewport without changing the saved viewport or fitting', async () => {
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 360, height: 600, x: 0, y: 0, left: 0, top: 0, right: 360, bottom: 600, toJSON: () => ({}) });
    const focus = vi.spyOn(navigation, 'focusExpandedBranch').mockResolvedValue();
    const key = 'map-viewport:sample:map'; const saved = { k: 1, x: 800, y: 100 }; localStorage.setItem(key, JSON.stringify(saved));
    const result = await openMap();
    expect(mock.instance.transform).toMatchObject({ k: 1, x: 175, y: 295 });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
    expect(mock.instance.fit).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    result.unmount(); rect.mockRestore(); focus.mockRestore();
  });
  it('does not auto-collapse branches while restoring a saved viewport', async () => {
    mock.wide = true;
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    localStorage.setItem('map-viewport:sample:map', JSON.stringify({ k: 1, x: 20, y: 20 }));
    const result = await openMap();
    expect(mock.instance.state.data.children[0].payload?.fold).not.toBe(1);
    expect(mock.instance.transform).toMatchObject({ k: 1, x: 20, y: 20 }); expect(mock.instance.fit).not.toHaveBeenCalled();
    result.unmount(); rect.mockRestore();
  });
  it('persists Fit all without clearing the stored viewport', async () => {
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const key = 'map-viewport:sample:map'; const prior = { k: 2, x: 15, y: 40 }; localStorage.setItem(key, JSON.stringify(prior));
    const result = await openMap();
    mock.instance.fit.mockImplementation(async () => { mock.instance.programmaticViewport(0.6, 20, 30); });
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' })); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Fit all' })); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(prior);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ k: 0.6, x: 20, y: 30 });
    result.unmount(); rect.mockRestore();
  });
  it('does not save intermediate programmatic viewport frames before the end event and debounce', async () => {
    const key = 'map-viewport:sample:map'; const result = await openMap();
    mock.instance.fit.mockImplementation(async () => { mock.instance.programmaticViewport(1.2, 10, 20, false); mock.instance.programmaticViewport(1.4, 30, 40, false); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fit visible' })); await vi.advanceTimersByTimeAsync(1000); });
    expect(localStorage.getItem(key)).toBeNull();
    act(() => mock.instance.listeners['end.viewport']?.({ transform: mock.instance.transform }));
    await act(async () => { await vi.advanceTimersByTimeAsync(249); }); expect(localStorage.getItem(key)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ k: 1.4, x: 30, y: 40 }); result.unmount();
  });
  it('does not auto-fit over a viewport changed by a wheel gesture', async () => {
    const result = await openMap();
    const svg = document.querySelector('.map-recall-svg svg')!;
    const image = document.createElement('img'); svg.appendChild(image);
    act(() => mock.instance.moveViewport(2, 10, 20));
    const fits = mock.instance.fit.mock.calls.length;
    await act(async () => { fireEvent.load(image); await vi.advanceTimersByTimeAsync(20); });
    expect(mock.instance.fit.mock.calls.length).toBe(fits); result.unmount();
  });
  it('clears the stored viewport on Reset view and refits', async () => {
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const key = 'map-viewport:sample:map'; localStorage.setItem(key, JSON.stringify({ k: 2, x: 15, y: 40 }));
    const result = await openMap(); act(() => mock.instance.moveViewport(3, 10, 20));
    fireEvent.click(screen.getByRole('button', { name: 'More map actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset view' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(localStorage.getItem(key)).toBeNull(); expect(mock.instance.fit).toHaveBeenCalled();
    result.unmount(); expect(localStorage.getItem(key)).toBeNull(); rect.mockRestore();
  });
  it.each([null, 'not json', '{}', '{"k":0,"x":1,"y":2}', '{"k":1,"x":"bad","y":2}'])('falls back to fit for missing or invalid viewport %s', async (value) => {
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    if (value !== null) localStorage.setItem('map-viewport:sample:map', value);
    const result = await openMap(); expect(mock.instance.fit).toHaveBeenCalled();
    expect(mock.instance.transform).toMatchObject({ k: 1, x: 0, y: 0 }); result.unmount(); rect.mockRestore();
  });
  it('uses the normal fit when local viewport storage is unavailable', async () => {
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 300, x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, toJSON: () => ({}) });
    const original = localStorage.getItem.bind(localStorage);
    const storage = vi.spyOn(localStorage, 'getItem').mockImplementation((key) => { if (key.startsWith('map-viewport:')) throw new Error('Storage unavailable'); return original(key); });
    const result = await openMap(); expect(mock.instance.fit).toHaveBeenCalled();
    result.unmount(); storage.mockRestore(); rect.mockRestore();
  });
  it('restores a saved snapshot without writing it', async () => {
    const first = await openMap(); await toggle(); await tick();
    responseState = JSON.parse(String(puts()[0][1]?.body)).folds; first.unmount(); vi.useRealTimers();
    const second = await openMap(); expect(Boolean(mock.instance.state.data.children[0].payload?.fold)).toBe(true);
    await tick(); expect(puts()).toHaveLength(1); second.unmount();
  });
  it('keeps content-path keys stable when an unrelated sibling is inserted', async () => {
    const first = await openMap(); await toggle(); await tick();
    responseState = JSON.parse(String(puts()[0][1]?.body)).folds; first.unmount(); vi.useRealTimers();
    source = '# Root\n\n## New branch\n\n### New child\n\n## Branch\n\n### Child';
    const second = await openMap(); expect(Boolean(mock.instance.state.data.children[1].payload?.fold)).toBe(true);
    await tick(); expect(puts()).toHaveLength(1); second.unmount();
  });
  it('keeps the writer and increases its sequence across lesson remounts', async () => {
    const first = await openMap(); await toggle(); await tick();
    const previous = JSON.parse(String(puts()[0][1]?.body)); responseState = previous.folds; first.unmount(); vi.useRealTimers();
    const second = await openMap(); await toggle(); await tick();
    const next = JSON.parse(String(puts()[1][1]?.body)); expect(next.writer).toBe(previous.writer); expect(next.sequence).toBeGreaterThan(previous.sequence); second.unmount();
  });
  it('creates a new writer when a cloned tab already owns the stored writer', async () => {
    const original = 'a'.repeat(32); sessionStorage.setItem('map-fold-writer', JSON.stringify({ writer: original, sequence: 99 }));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, _options: unknown, callback: (lock: unknown) => unknown) => Promise.resolve(callback(name.endsWith(original) ? null : { name })) } });
    const result = await openMap(); await toggle(); await tick();
    const sent = JSON.parse(String(puts()[0][1]?.body)); expect(sent.writer).not.toBe(original); expect(sent.sequence).toBe(1); result.unmount();
  });
  it('does not save when per-tab ordering cannot be established', async () => {
    delete (navigator as any).locks;
    const result = await openMap(); await toggle(); await tick(); result.unmount(); expect(puts()).toHaveLength(0);
  });
});
