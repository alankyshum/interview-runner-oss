type Rect = { x: number; y: number; width: number; height: number };

/** Preserve authored expansion unless first-level branches cannot fit readably. */
export function overviewNeedsFolding(viewport: { width: number; height: number }, nodes: readonly Rect[], fitRatio: number, maxInitialScale: number): boolean {
  if (!nodes.length || viewport.width <= 0 || viewport.height <= 0) return false;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  const scale = Math.min(viewport.width / Math.max(1, right - left), viewport.height / Math.max(1, bottom - top), maxInitialScale) * fitRatio;
  return scale < Math.min(0.75, maxInitialScale * fitRatio);
}
