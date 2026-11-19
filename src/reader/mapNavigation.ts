import type { INode } from 'markmap-common';
import type { Markmap } from 'markmap-view';
import { MAP_MAX_WIDTH } from './mapWidth';
import './mapNavigation.css';

const authoredWidth = new WeakMap<Markmap, number>();
const focusGeneration = new WeakMap<Markmap, number>();
const pendingReflows = new WeakMap<Markmap, number>();

/** Markmap's zero-duration D3 transitions still paint an intermediate frame.
 * Apply its public transition operations synchronously so entering, moving and
 * exiting nodes are never painted at their shared origin. */
export function setImmediateMapLayout(map: Markmap) {
  if (map.options) authoredWidth.set(map, map.options.maxWidth > 0 ? map.options.maxWidth : MAP_MAX_WIDTH);
  map.transition = ((selection: Parameters<Markmap['transition']>[0]) =>
    Object.assign(selection, { end: async () => {} })) as unknown as Markmap['transition'];
}

export async function expandMap(map: Markmap) {
  const visit = (node: INode) => { node.payload = { ...node.payload, fold: 0 }; node.children.forEach(visit); };
  if (map.state.data) { visit(map.state.data); await map.renderData(); }
}

export async function reflowMap(map: Markmap, width: number) {
  const svg = map.svg.node();
  const count = (pendingReflows.get(map) ?? 0) + 1; pendingReflows.set(map, count);
  svg?.classList.add('map-reflow-pending');
  try { map.options.maxWidth = width; await map.renderData(); }
  finally {
    const remaining = (pendingReflows.get(map) ?? 1) - 1;
    if (remaining) pendingReflows.set(map, remaining);
    else { pendingReflows.delete(map); svg?.classList.remove('map-reflow-pending'); }
  }
}

type Rect = { x: number; y: number; width: number; height: number };
export type MapViewport = { k: number; x: number; y: number };

/** Preserve a saved viewport unless every visible node is outside the new canvas. */
export function clampRestoredViewport(saved: MapViewport, view: { width: number; height: number }, root: INode): MapViewport {
  if (view.width <= 0 || view.height <= 0) return saved;
  const rects: Rect[] = [];
  const visit = (node: INode) => {
    const rect = node.state.rect;
    if ([rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0) rects.push(rect);
    if (!node.payload?.fold) node.children.forEach(visit);
  };
  visit(root);
  const boxes = rects.map((rect) => ({ left: rect.x * saved.k + saved.x, top: rect.y * saved.k + saved.y, width: rect.width * saved.k, height: rect.height * saved.k }));
  if (!boxes.length || boxes.some((r) => r.left < view.width && r.left + r.width > 0 && r.top < view.height && r.top + r.height > 0)) return saved;
  const shift = (start: number, size: number, limit: number) => {
    const padding = Math.min(12, limit / 4);
    if (size >= limit - padding * 2) return start > 0 ? padding - start : limit - padding - start - size;
    return start < padding ? padding - start : start + size > limit - padding ? limit - padding - start - size : 0;
  };
  const candidates = boxes.map((r) => ({ rect: r, x: shift(r.left, r.width, view.width), y: shift(r.top, r.height, view.height) }));
  candidates.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  const nearest = candidates[0]!.rect;
  return { ...saved, x: saved.x + view.width / 2 - nearest.left - nearest.width / 2, y: saved.y + view.height / 2 - nearest.top - nearest.height / 2 };
}

/** Keep the opened branch readable and show the largest fitting run of children. */
export function branchViewport(view: { width: number; height: number }, scale: number, minScale: number, parent: Rect, children: Rect[]) {
  const k = Math.max(scale, minScale);
  const bounds = (items: Rect[]) => {
    const left = Math.min(...items.map((r) => r.x)); const top = Math.min(...items.map((r) => r.y));
    const right = Math.max(...items.map((r) => r.x + r.width)); const bottom = Math.max(...items.map((r) => r.y + r.height));
    return { left, top, right, bottom };
  };
  const fits = (r: ReturnType<typeof bounds>) => (r.right - r.left) * k <= view.width - 24 && (r.bottom - r.top) * k <= view.height - 24;
  let box = bounds([parent, ...children]);
  if (!fits(box) && children.length) {
    const ordered = [...children].sort((a, b) => a.y - b.y);
    let bestCount = 0; let bestDistance = Infinity; box = bounds([parent]);
    for (let first = 0; first < ordered.length; first++) {
      let candidate = bounds([parent]);
      for (let last = first; last < ordered.length; last++) {
        const child = ordered[last]!;
        candidate = { left: Math.min(candidate.left, child.x), top: Math.min(candidate.top, child.y), right: Math.max(candidate.right, child.x + child.width), bottom: Math.max(candidate.bottom, child.y + child.height) };
        if (!fits(candidate)) break;
        const count = last - first + 1; const distance = Math.abs((candidate.top + candidate.bottom - parent.y * 2 - parent.height) / 2);
        if (count > bestCount || (count === bestCount && distance < bestDistance)) { box = candidate; bestCount = count; bestDistance = distance; }
      }
    }
  }
  return { k, x: (view.width - (box.left + box.right) * k) / 2, y: (view.height - (box.top + box.bottom) * k) / 2 };
}

export async function focusExpandedBranch(map: Markmap, node: INode) {
  const generation = (focusGeneration.get(map) ?? 0) + 1; focusGeneration.set(map, generation);
  const svg = map.svg.node();
  if (!svg || node.payload?.fold) return;
  const view = svg.getBoundingClientRect();
  if (view.width <= 0 || view.height <= 0) return;
  const zoom = map.svg.property('__zoom') as { k: number; x: number; y: number; translate: (x: number, y: number) => { scale: (k: number) => unknown } };
  const initial = { k: zoom.k, x: zoom.x, y: zoom.y };
  const fontSizes = [...svg.querySelectorAll('foreignObject *')].map((element) => parseFloat(getComputedStyle(element).fontSize)).filter((size) => Number.isFinite(size) && size > 0);
  const minScale = 12 / (fontSizes.length ? Math.min(...fontSizes) : 16);
  const width = Math.max(120, Math.floor((view.width / Math.max(initial.k, minScale) - 100) / 2));
  const maxWidth = Math.min(authoredWidth.get(map) ?? MAP_MAX_WIDTH, width);
  if (map.options.maxWidth !== maxWidth) await reflowMap(map, maxWidth);
  const current = map.svg.property('__zoom') as { k: number; x: number; y: number };
  if (focusGeneration.get(map) !== generation || node.payload?.fold || current.k !== initial.k || current.x !== initial.x || current.y !== initial.y) return;
  const target = branchViewport(view, initial.k, minScale, node.state.rect, node.children.map((child) => child.state.rect));
  const transform = zoom.translate((target.x - initial.x) / initial.k, (target.y - initial.y) / initial.k).scale(target.k / initial.k);
  map.svg.call(map.zoom.transform, transform as never);
}
