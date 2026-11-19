// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { anchorMapHighlight, highlightSnippet, mapNodeIndex } from './mapHighlightAnchors';
import type { MapHighlight } from '../../shared/mapHighlights';

describe('map highlight anchors', () => {
  it('survives unrelated branches but keeps a removed or renamed node orphaned', () => {
    const index = (source: string) => mapNodeIndex(new Transformer().transform(source).root);
    const original = index('# Root\n## Branch\n- A quoted note\n');
    const node = original.find((entry) => entry.text === 'A quoted note')!;
    const highlight: MapHighlight = { id: 'a'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'quoted', prefix: 'A ', suffix: ' note', offset: 2, captureAmbiguous: false };
    const unrelated = index('# Root\n## New branch\n- Unrelated\n## Branch\n- A quoted note\n');
    expect(anchorMapHighlight(highlight, unrelated)?.text).toBe('A quoted note');
    expect(anchorMapHighlight(highlight, index('# Root\n## Branch\n- Renamed note\n'))).toBeUndefined();
    expect(anchorMapHighlight(highlight, index('# Root\n## Branch\n'))).toBeUndefined();
    expect(highlight.quote).toBe('quoted');
  });
  it('does not silently anchor to indistinguishable duplicate siblings', () => {
    const entries = mapNodeIndex(new Transformer().transform('# Root\n- Note\n- Note\n').root);
    const node = entries.find((entry) => entry.text === 'Note')!;
    const highlight: MapHighlight = { id: 'a'.repeat(32), nodeKey: node.key, nodeText: node.text, lineage: node.lineage, quote: 'Note', prefix: '', suffix: '', offset: 0, captureAmbiguous: node.ambiguous };
    expect(anchorMapHighlight(highlight, entries)).toBeUndefined();
    const surviving = mapNodeIndex(new Transformer().transform('# Root\n- Note\n').root);
    expect(anchorMapHighlight(highlight, surviving)).toBeUndefined();
    const { captureAmbiguous: _captureAmbiguous, ...legacy } = highlight;
    expect(anchorMapHighlight(legacy, surviving)).toBeUndefined();
  });
});

describe('highlight snippets', () => {
  const record = (nodeText: string, quote: string): MapHighlight => {
    const offset = nodeText.indexOf(quote);
    return { id: 'a'.repeat(32), nodeKey: 'b'.repeat(16), nodeText, quote, offset, prefix: nodeText.slice(Math.max(0, offset - 128), offset), suffix: nodeText.slice(offset + quote.length, offset + quote.length + 128), lineage: [] };
  };
  it('truncates both sides on boundaries and preserves whitespace around the exact quote', () => {
    const item = record(`${'before '.repeat(15)}chosen${' after'.repeat(15)}`, 'chosen');
    const snippet = highlightSnippet(item, item.nodeText);
    expect(snippet.before).toMatch(/^….* $/u);
    expect(snippet.after).toMatch(/^ .*…$/u);
    expect(snippet.quote).toBe('chosen');
    expect(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(snippet.before.slice(1))).length).toBeLessThanOrEqual(60);
  });
  it('does not add ellipses at node boundaries', () => {
    expect(highlightSnippet(record('chosen tail', 'chosen'))).toEqual({ before: '', quote: 'chosen', after: ' tail' });
    expect(highlightSnippet(record('head chosen', 'chosen'))).toEqual({ before: 'head ', quote: 'chosen', after: '' });
  });
  it('uses the captured node for orphans, with prefix/suffix fallback', () => {
    const item = record('captured before chosen captured after', 'chosen');
    expect(highlightSnippet(item)).toEqual({ before: 'captured before ', quote: 'chosen', after: ' captured after' });
    expect(highlightSnippet({ ...item, nodeText: 'unavailable' })).toEqual({ before: item.prefix, quote: 'chosen', after: item.suffix });
  });
  it('never splits grapheme clusters in context', () => {
    const family = '👩‍👩‍👧‍👦';
    const snippet = highlightSnippet(record(`${family.repeat(70)}chosen${family.repeat(70)}`, 'chosen'));
    expect(snippet.before).toBe(`…${family.repeat(60)}`);
    expect(snippet.after).toBe(`${family.repeat(60)}…`);
  });
});
