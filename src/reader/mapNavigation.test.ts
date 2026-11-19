import { describe, expect, it, vi } from 'vitest';
import type { Markmap } from 'markmap-view';
import { branchViewport, clampRestoredViewport, expandMap, focusExpandedBranch, reflowMap, setImmediateMapLayout } from './mapNavigation';
import { MAP_MAX_WIDTH } from './mapWidth';

describe('map navigation', () => {
  it('preserves a visible saved viewport and recovers one wholly outside a smaller canvas', () => {
    const root = { state: { rect: { x: 0, y: 0, width: 120, height: 24 } }, children: [] } as never;
    const visible = { k: 1, x: -40, y: 50 };
    expect(clampRestoredViewport(visible, { width: 360, height: 600 }, root)).toBe(visible);
    const offscreen = { k: 1, x: 800, y: 100 };
    const adjusted = clampRestoredViewport(offscreen, { width: 360, height: 600 }, root);
    expect(adjusted).toEqual({ k: 1, x: 120, y: 288 });
    expect(clampRestoredViewport(offscreen, { width: 1440, height: 600 }, root)).toBe(offscreen);
  });
  it('does not count folded descendants as visible while recovering a saved viewport', () => {
    const root = { state: { rect: { x: 0, y: 0, width: 100, height: 20 } }, payload: { fold: 1 }, children: [{ state: { rect: { x: -800, y: 0, width: 100, height: 20 } }, children: [] }] } as never;
    expect(clampRestoredViewport({ k: 1, x: 800, y: 10 }, { width: 360, height: 600 }, root)).toEqual({ k: 1, x: 130, y: 290 });
  });
  it('applies layout operations synchronously rather than starting a transition', async () => {
    const map = {} as Markmap;
    setImmediateMapLayout(map);
    const selection = { attr: vi.fn(), transition: vi.fn() };
    const result = map.transition(selection as never);
    expect(result).toBe(selection);
    expect(selection.transition).not.toHaveBeenCalled();
    await expect(result.end()).resolves.toBeUndefined();
  });

  it('keeps readable scale and centers a branch that fits', () => {
    const parent = { x: 0, y: 20, width: 100, height: 20 };
    const child = { x: 130, y: 10, width: 140, height: 40 };
    const view = branchViewport({ width: 390, height: 500 }, 0.2, 0.75, parent, [child]);
    expect(view.k).toBe(0.75);
    expect(view.x + parent.x * view.k).toBeGreaterThan(0);
    expect(view.x + (child.x + child.width) * view.k).toBeLessThan(390);
    expect(view.y + child.y * view.k).toBeGreaterThan(0);
  });

  it('preserves a larger user zoom and focuses the nearest child when a branch is too large', () => {
    const parent = { x: 0, y: 500, width: 100, height: 20 };
    const children = [{ x: 120, y: 0, width: 100, height: 20 }, { x: 120, y: 500, width: 100, height: 20 }, { x: 120, y: 1000, width: 100, height: 20 }];
    const view = branchViewport({ width: 390, height: 300 }, 1, 0.75, parent, children);
    expect(view.k).toBe(1);
    expect(view.y + parent.y).toBeGreaterThan(0);
    expect(view.y + children[1]!.y + children[1]!.height).toBeLessThan(300);
  });
  it('shows the largest group of children that fits with the expanded parent', () => {
    const parent = { x: 0, y: 200, width: 100, height: 20 };
    const children = [0, 100, 200, 300, 400].map((y) => ({ x: 120, y, width: 100, height: 50 }));
    const view = branchViewport({ width: 390, height: 300 }, 1, 0.75, parent, children);
    const inside = (r: typeof parent) => view.y + r.y >= 0 && view.y + r.y + r.height <= 300;
    expect(inside(parent)).toBe(true);
    expect(children.filter(inside)).toHaveLength(3);
  });

  it('expands all descendants before rendering the overview', async () => {
    const child = { payload: { fold: 1 }, children: [] };
    const root = { payload: { fold: 1 }, children: [child] };
    const renderData = vi.fn(async () => {});
    await expandMap({ state: { data: root }, renderData } as unknown as Markmap);
    expect(root.payload.fold).toBe(0); expect(child.payload.fold).toBe(0);
    expect(renderData).toHaveBeenCalledOnce();
  });

  it('reflows an opened branch for the viewport and raises an overview zoom to readable size', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.getBoundingClientRect = () => ({ width: 390, height: 600 }) as DOMRect;
    const transformed = { scale: vi.fn(() => 'target') };
    const zoom = { k: 0.1, x: 0, y: 0, translate: vi.fn(() => transformed) };
    const call = vi.fn(); const renderData = vi.fn(async () => {});
    const map = { options: { maxWidth: 350 }, svg: { node: () => svg, property: () => zoom, call }, zoom: { transform: vi.fn() }, renderData } as unknown as Markmap;
    const node = { payload: { fold: 0 }, state: { rect: { x: 0, y: 0, width: 120, height: 24 } }, children: [{ state: { rect: { x: 140, y: 0, width: 120, height: 24 } } }] };
    setImmediateMapLayout(map);
    await focusExpandedBranch(map, node as never);
    expect(map.options.maxWidth).toBeLessThan(350);
    expect(renderData).toHaveBeenCalledOnce();
    expect(transformed.scale).toHaveBeenCalledWith(7.5);
    expect(call).toHaveBeenCalledWith(map.zoom.transform, 'target');
  });
  it.each([0, 420])('uses default or authored cap %i after narrowing and widening a branch', async (authored) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); let width = 390;
    svg.getBoundingClientRect = () => ({ width, height: 600 }) as DOMRect;
    const zoom = { k: 1, x: 0, y: 0, translate: () => ({ scale: () => 'target' }) };
    const map = { options: { maxWidth: authored }, svg: { node: () => svg, property: () => zoom, call: vi.fn() }, zoom: { transform: vi.fn() }, renderData: vi.fn(async () => {}) } as unknown as Markmap;
    const node = { payload: { fold: 0 }, state: { rect: { x: 0, y: 0, width: 120, height: 24 } }, children: [] };
    setImmediateMapLayout(map);
    await focusExpandedBranch(map, node as never);
    expect(map.options.maxWidth).toBe(145);
    width = 2400;
    await focusExpandedBranch(map, node as never);
    expect(map.options.maxWidth).toBe(authored || MAP_MAX_WIDTH);
  });
  it('uses the wide cap when focusing a map without a registered authored width', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.getBoundingClientRect = () => ({ width: 2400, height: 600 }) as DOMRect;
    const zoom = { k: 1, x: 0, y: 0, translate: () => ({ scale: () => 'target' }) };
    const map = { options: { maxWidth: 350 }, svg: { node: () => svg, property: () => zoom, call: vi.fn() }, zoom: { transform: vi.fn() }, renderData: vi.fn(async () => {}) } as unknown as Markmap;
    const node = { payload: { fold: 0 }, state: { rect: { x: 0, y: 0, width: 120, height: 24 } }, children: [] };
    await focusExpandedBranch(map, node as never);
    expect(map.options.maxWidth).toBe(MAP_MAX_WIDTH);
  });
  it('does not overwrite a pan made while branch layout was pending', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.getBoundingClientRect = () => ({ width: 390, height: 600 }) as DOMRect;
    const zoom = { k: 0.1, x: 0, y: 0, translate: vi.fn() };
    const call = vi.fn(); let finish!: () => void;
    const map = { options: { maxWidth: 350 }, svg: { node: () => svg, property: () => zoom, call }, zoom: { transform: vi.fn() }, renderData: () => new Promise<void>((resolve) => { finish = resolve; }) } as unknown as Markmap;
    setImmediateMapLayout(map);
    const node = { payload: { fold: 0 }, state: { rect: { x: 0, y: 0, width: 120, height: 24 } }, children: [] };
    const pending = focusExpandedBranch(map, node as never);
    expect(svg).toHaveClass('map-reflow-pending');
    zoom.x = 40; finish(); await pending;
    expect(svg).not.toHaveClass('map-reflow-pending');
    expect(call).not.toHaveBeenCalled();
  });
  it('keeps reflowing text hidden until concurrent layouts finish and restores it on failure', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const pending: Array<() => void> = [];
    const map = { options: { maxWidth: 350 }, svg: { node: () => svg }, renderData: () => new Promise<void>((resolve) => pending.push(resolve)) } as unknown as Markmap;
    const first = reflowMap(map, 200); const second = reflowMap(map, 150);
    expect(svg).toHaveClass('map-reflow-pending');
    pending[0]!(); await first; expect(svg).toHaveClass('map-reflow-pending');
    pending[1]!(); await second; expect(svg).not.toHaveClass('map-reflow-pending');
    map.renderData = async () => { throw new Error('layout failed'); };
    await expect(reflowMap(map, 100)).rejects.toThrow('layout failed');
    expect(svg).not.toHaveClass('map-reflow-pending');
  });
});
