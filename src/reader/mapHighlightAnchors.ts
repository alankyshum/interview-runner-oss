import type { IPureNode } from 'markmap-common';
import type { MapHighlight } from '../../shared/mapHighlights';

export function mapNodeKey(path: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(path)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

export type MapNodeEntry<T> = { node: T; key: string; text: string; lineage: string[]; ambiguous: boolean };

/** Index by the same content path used for persisted map folds. */
export function mapNodeIndex<T extends IPureNode>(root: T): MapNodeEntry<T>[] {
  const entries: MapNodeEntry<T>[] = [];
  const text = (html: string) => { const element = document.createElement('div'); element.innerHTML = html; return element.textContent ?? ''; };
  const visit = (node: T, path: string, lineage: string[], ambiguous: boolean) => {
    const nodeText = text(node.content);
    entries.push({ node, key: mapNodeKey(path), text: nodeText, lineage, ambiguous });
    const totals = new Map<string, number>(); const counts = new Map<string, number>();
    for (const child of node.children) totals.set(child.content, (totals.get(child.content) ?? 0) + 1);
    for (const child of node.children) {
      const index = counts.get(child.content) ?? 0; counts.set(child.content, index + 1);
      visit(child as T, `${path}/${JSON.stringify([child.content, index])}`, [...lineage, nodeText.trim() ? nodeText : 'Untitled node'], ambiguous || (totals.get(child.content) ?? 0) > 1);
    }
  };
  visit(root, JSON.stringify([root.content, 0]), [], false);
  return entries;
}

export function anchorMapHighlight<T extends IPureNode>(highlight: MapHighlight, entries: MapNodeEntry<T>[]): MapNodeEntry<T> | undefined {
  // A legacy or ambiguous capture cannot be distinguished from an identical
  // sibling after one sibling is deleted and its content-path index is reused.
  if (highlight.captureAmbiguous !== false) return undefined;
  const candidates = entries.filter((entry) => entry.key === highlight.nodeKey && !entry.ambiguous && entry.text === highlight.nodeText && entry.lineage.length === highlight.lineage.length && entry.lineage.every((part, index) => part === highlight.lineage[index]));
  if (candidates.length !== 1) return undefined;
  const entry = candidates[0]!;
  if (entry.text.slice(highlight.offset, highlight.offset + highlight.quote.length) !== highlight.quote) return undefined;
  if (entry.text.slice(Math.max(0, highlight.offset - highlight.prefix.length), highlight.offset) !== highlight.prefix) return undefined;
  if (entry.text.slice(highlight.offset + highlight.quote.length, highlight.offset + highlight.quote.length + highlight.suffix.length) !== highlight.suffix) return undefined;
  return entry;
}

/** Context is sliced at grapheme boundaries, without changing the saved quote. */
export function highlightSnippet(highlight: MapHighlight, currentText?: string): { before: string; quote: string; after: string } {
  const text = currentText ?? highlight.nodeText;
  const matches = text.slice(highlight.offset, highlight.offset + highlight.quote.length) === highlight.quote;
  const before = matches ? text.slice(0, highlight.offset) : highlight.prefix;
  const after = matches ? text.slice(highlight.offset + highlight.quote.length) : highlight.suffix;
  const segments = (value: string): string[] => typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (part) => part.segment)
    : Array.from(value);
  const truncate = (value: string, side: 'before' | 'after') => {
    const parts = segments(value);
    if (parts.length <= 60) return value;
    let slice = side === 'before' ? parts.slice(-60) : parts.slice(0, 60);
    // Drop a partial outer word where a whitespace boundary is available.
    if (side === 'before' && !/\s/u.test(parts[parts.length - 61]!) && !/\s/u.test(slice[0]!)) {
      const boundary = slice.findIndex((part) => /\s/u.test(part));
      if (boundary >= 0 && boundary < slice.length - 1) slice = slice.slice(boundary + 1);
    } else if (side === 'after' && !/\s/u.test(parts[60]!) && !/\s/u.test(slice[slice.length - 1]!)) {
      const boundary = slice.length - 1 - [...slice].reverse().findIndex((part) => /\s/u.test(part));
      if (boundary > 0) slice = slice.slice(0, boundary);
    }
    return side === 'before' ? `…${slice.join('')}` : `${slice.join('')}…`;
  };
  return { before: truncate(before, 'before'), quote: highlight.quote, after: truncate(after, 'after') };
}
