import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHEATSHEET_HYDRATE_EVENT, embeddedMapSize, hydrateCheatsheetMaps } from './cheatsheetMaps';
import { MAP_MAX_WIDTH } from '../reader/mapWidth';

const calls = vi.hoisted(() => ({ init: vi.fn(), instance: vi.fn(), setData: vi.fn(async () => {}), fit: vi.fn(async () => {}), renderData: vi.fn(async () => {}), destroy: vi.fn() }));
vi.mock('markmap-view', () => ({ Markmap: class {
  constructor(svg: SVGSVGElement, options: { maxWidth: number }) { this.svg.node = () => svg; this.options = { ...this.options, ...options }; calls.init(options); calls.instance(this); }
  svg = { on: vi.fn(), node: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg') }; zoom = { filter: vi.fn(), scaleExtent: vi.fn() }; setData = calls.setData; fit = calls.fit; renderData = calls.renderData; destroy = calls.destroy;
  state = { rect: { x1: 0, y1: 0, x2: 500, y2: 900 } }; options = { fitRatio: 0.9, maxWidth: 0 }; toggleNode = vi.fn(async () => {}); setOptions = vi.fn();
  rescale = vi.fn(async () => {});
} }));
vi.mock('../reader/MapRecall', async () => {
  const DOMPurify = (await import('dompurify')).default;
  return { sanitizeMapNode: (node: { content: string; children: unknown[] }) => ({ ...node, content: DOMPurify.sanitize(node.content) }) };
});

describe('embedded cheatsheet maps', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it('reserves content-driven height and readable scale even when horizontal scrolling is needed', () => {
    const size = embeddedMapSize({ x1: 0, y1: -200, x2: 500, y2: 700 }, 320, 0.9);
    expect(size.width).toBeGreaterThan(320); expect(size.height).toBeGreaterThan(900 * 0.85 / 0.9);
    expect(() => embeddedMapSize({ x1: 0, y1: 0, x2: 0, y2: 10 }, 320, 0.9)).toThrow('Invalid map layout');
  });
  it('fetches a same-course Markdown asset lazily and fits it, then cleans up', async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { intersect = cb; } observe() {} disconnect() {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const fetcher = vi.fn(async () => new Response('# Root\n- Branch', { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const root = document.createElement('article'); root.innerHTML = '<figure><div data-markmap-src="diagrams/mindmaps/map-001.md" aria-label="Example"></div><details class="figure-transcript"><summary>Text version</summary>Fallback</details></figure>';
    Object.defineProperty(root.querySelector('[data-markmap-src]')!, 'clientWidth', { value: 320 });
    const stop = hydrateCheatsheetMaps(root, 'example'); expect(fetcher).not.toHaveBeenCalled();
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(calls.fit).toHaveBeenCalled());
    expect(calls.init).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 288, autoFit: false }));
    expect(fetcher.mock.calls[0][0]).toBe('/cheatsheets/example/diagrams/mindmaps/map-001.md');
    await vi.waitFor(() => expect(root.querySelector('[data-markmap-src]')).toHaveAttribute('data-map-ready'));
    expect(root.querySelector('svg')).toHaveAttribute('aria-label', 'Example');
    expect(root.querySelector('svg')?.style.height).toBe(`${embeddedMapSize({ x1: 0, y1: 0, x2: 500, y2: 900 }, 320, 0.9).height}px`);
    expect(root.querySelector('.embedded-map-scroll-hint')).toHaveTextContent('Scroll horizontally');
    expect(root.querySelectorAll('button')).toHaveLength(4);
    expect(root.querySelector('.embedded-map-controls')).toHaveTextContent('Fit all');
    stop(); expect(calls.destroy).toHaveBeenCalled();
  });
  it('uses the wide cap and reflows on resize while preserving supported frontmatter options', async () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { resize = cb; } observe() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('---\nmarkmap:\n  initialExpandLevel: 3\n  spacingVertical: 9\n  maxWidth: 42\n---\n# Root\n- Branch', { status: 200 })));
    const root = document.createElement('article'); root.innerHTML = '<div data-markmap-src="diagrams/mindmaps/map-001.md"></div>';
    const host = root.querySelector<HTMLElement>('[data-markmap-src]')!; let width = 1200;
    Object.defineProperty(host, 'clientWidth', { get: () => width });
    const stop = hydrateCheatsheetMaps(root, 'example'); host.dispatchEvent(new Event(CHEATSHEET_HYDRATE_EVENT));
    await vi.waitFor(() => expect(host).toHaveAttribute('data-map-ready'));
    expect(calls.init).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: MAP_MAX_WIDTH, initialExpandLevel: 3, spacingVertical: 9 }));
    width = 320; resize([], {} as ResizeObserver);
    await vi.waitFor(() => expect(calls.renderData).toHaveBeenCalled());
    expect(calls.instance.mock.calls[0][0].options.maxWidth).toBe(288);
    await vi.waitFor(() => expect(calls.fit).toHaveBeenCalledTimes(2));
    width = 80; resize([], {} as ResizeObserver);
    await vi.waitFor(() => expect(calls.renderData).toHaveBeenCalledTimes(2));
    expect(calls.instance.mock.calls[0][0].options.maxWidth).toBe(120);
    await vi.waitFor(() => expect(calls.fit).toHaveBeenCalledTimes(3));
    stop();
  });
  it('can hydrate an above-target map once without waiting for intersection', async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { intersect = cb; } observe() {} disconnect() {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const fetcher = vi.fn(async () => new Response('# Root\n- Branch', { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const root = document.createElement('article'); root.innerHTML = '<details open><summary>Go deeper</summary><figure><div data-markmap-src="diagrams/mindmaps/map-001.md"></div></figure><h4>Target</h4></details>';
    const host = root.querySelector<HTMLElement>('[data-markmap-src]')!; Object.defineProperty(host, 'clientWidth', { value: 320 });
    const stop = hydrateCheatsheetMaps(root, 'example'); host.dispatchEvent(new Event(CHEATSHEET_HYDRATE_EVENT)); host.dispatchEvent(new Event(CHEATSHEET_HYDRATE_EVENT));
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(host).toHaveAttribute('data-map-ready')); expect(fetcher).toHaveBeenCalledTimes(1); stop();
  });
  it('rejects cross-course paths and opens the transcript on failure', async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { intersect = cb; } observe() {} disconnect() {} });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = document.createElement('article'); root.innerHTML = '<details><summary>Parent</summary><figure><div data-markmap-src="../../other.md">Fallback</div><details class="figure-transcript"><summary>Text version</summary>Fallback</details></figure></details>';
    const stop = hydrateCheatsheetMaps(root, 'example'); intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(root.querySelector<HTMLDetailsElement>('.figure-transcript')?.open).toBe(true));
    expect(root.querySelector<HTMLDetailsElement>('details')?.open).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    stop(); log.mockRestore();
  });
});
