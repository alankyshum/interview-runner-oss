import { describe, expect, it } from 'vitest';
import { validateOutline } from './outlines';

const root = (nodes: unknown[]) => ({ courseId: 'book', drillId: 'chapter', title: 'Chapter', nodes });
const node = (id: string, children?: unknown[]) => ({ id, type: 'claim', text: id, ...(children ? { children } : {}) });

describe('outline validation', () => {
  it('rejects duplicate ids across branches', () => expect(() => validateOutline('chapter.json', root([node('same'), node('branch', [node('same')])]), 'book', 'chapter')).toThrow('duplicate node id "same"'));
  it('hard-stops at L5 and rejects unknown fields', () => {
    const deep = node('l1', [node('l2', [node('l3', [node('l4', [node('l5')])])])]);
    expect(() => validateOutline('chapter.json', root([deep]), 'book', 'chapter')).toThrow('depth exceeds L4 at node "l5"');
    expect(() => validateOutline('chapter.json', root([{ ...node('ok'), extra: true }]), 'book', 'chapter')).toThrow('unknown field "extra"');
  });
});
