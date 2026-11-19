import type { OutlineNode } from '../../server/outlines';

export type ReaderNodeState = { folded?: boolean; checked?: boolean };
export const leafCount = (node: OutlineNode): number => node.children?.length ? node.children.reduce((sum, child) => sum + leafCount(child), 0) : 1;
export const checkedLeafCount = (node: OutlineNode, state: Record<string, ReaderNodeState>): number => node.children?.length ? node.children.reduce((sum, child) => sum + checkedLeafCount(child, state), 0) : state[node.id]?.checked ? 1 : 0;
export function outlineProgress(nodes: OutlineNode[], state: Record<string, ReaderNodeState>): { checked: number; total: number } {
  return nodes.reduce((result, node) => ({ checked: result.checked + checkedLeafCount(node, state), total: result.total + leafCount(node) }), { checked: 0, total: 0 });
}
