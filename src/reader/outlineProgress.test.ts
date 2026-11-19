import { describe, expect, it } from 'vitest';
import { checkedLeafCount, leafCount, outlineProgress } from './outlineProgress';

const tree = { id: 'book', type: 'claim' as const, text: 'book', children: [{ id: 'chapter', type: 'claim' as const, text: 'chapter', children: [{ id: 'a', type: 'step' as const, text: 'a' }, { id: 'b', type: 'step' as const, text: 'b' }] }] };
describe('outline progress', () => {
  it('counts checked leaves and ignores parent checks', () => {
    expect(leafCount(tree)).toBe(2);
    expect(checkedLeafCount(tree, { book: { checked: true }, a: { checked: true } })).toBe(1);
    expect(outlineProgress([tree], { a: { checked: true } })).toEqual({ checked: 1, total: 2 });
  });
});
