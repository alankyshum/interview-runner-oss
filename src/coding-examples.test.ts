import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCodingExampleText, codingExampleTextIssues, findCodingExampleIssues } from '../scripts/coding-examples';

describe('coding example authoring convention', () => {
  it('accepts a real call and output comment in a language-tagged example fence', () => {
    expect(codingExampleTextIssues('## Examples\n```python\nlimiter = TokenBucket(2, 1)\nlimiter.allow("A", now_ms=0)  # -> True\n```', ['python'])).toEqual([]);
    expect(codingExampleTextIssues('### Example 1\n```typescript\ntwoSum([2, 7], 9); // -> [0, 1]\n```', ['typescript'])).toEqual([]);
    expect(codingExampleTextIssues('## API\nInput: integer.\n\nOutput: integer.\n\n```typescript\nfunction f(x: number): number\n```', ['typescript'])).toEqual([]);
  });
  it('rejects prose-only examples in strict migration checks', () => {
    expect(() => assertCodingExampleText('### Example 1\nInput: A at 0ms. Output: true.', ['python'])).toThrow(/requires a fenced code block/);
    expect(() => assertCodingExampleText('Input: 2 and 3. Output: 5.', ['python'])).toThrow(/example-like prose/);
    expect(() => assertCodingExampleText('Input: 2 and 3.\n\nOutput: 5.', ['python'])).toThrow(/Input\/Output prose/);
    expect(() => assertCodingExampleText('For A at 0 ms, three calls return true, true, false.', ['python'])).toThrow(/example-like prose/);
  });
  it('does not mistake generic problem contracts for concrete examples', () => {
    for (const scenario of [
      'Given a rotated strictly increasing array and target, return its index or -1 when absent, in O(log n) time.',
      'Given a nonnegative integer n, return an array of length n+1 containing the number of set bits for every integer from 0 through n.',
      'Given a 32-bit unsigned integer, return the integer represented by its bits in reverse order, including leading zeroes in the 32-bit representation.',
      'Given coin denominations and an amount, return the fewest coins needed to make that amount, or -1 if it cannot be made; each denomination is reusable.',
    ]) expect(codingExampleTextIssues(`## Scenario\n${scenario}`, ['typescript'])).toEqual([]);
    expect(codingExampleTextIssues('Given [1, 2], the function returns 3.', ['typescript'])).toEqual([expect.stringContaining('example-like prose')]);
    expect(codingExampleTextIssues('Given [4], the function returns -1.', ['typescript'])).toEqual([expect.stringContaining('example-like prose')]);
  });
  it('exempts only a blockquote labeled Original interview prompt (verbatim)', () => {
    const quote = '> **Original interview prompt (verbatim)**\n>\n> For example, input: 2 and output: 3.\n> ```text\n> Input: 2\n> Output: 3\n> ```';
    expect(codingExampleTextIssues(quote, ['typescript'])).toEqual([]);
    expect(codingExampleTextIssues(quote.replace('Original interview prompt (verbatim)', 'Interview prompt'), ['typescript'])).toEqual(expect.arrayContaining([expect.stringContaining('example-like prose')]));
    expect(codingExampleTextIssues(`> Not the label.\n${quote}`, ['typescript'])).toEqual(expect.arrayContaining([expect.stringContaining('example-like prose')]));
    expect(codingExampleTextIssues(`${quote}\n\nFor example, 2 returns 3.`, ['typescript'])).toEqual([expect.stringContaining('example-like prose')]);
  });
  it('rejects missing calls, missing outputs, wrong languages, and unclosed fences', () => {
    for (const text of ['## Examples\n```python\nvalue = 1  # -> 1\n```', '## Examples\n```python\ncall(1)\n```', '## Examples\n```typescript\ncall(1) // -> 2\n```', '## Examples\n```python\ncall(1) # -> 2']) expect(codingExampleTextIssues(text, ['python']).length).toBeGreaterThan(0);
  });
  it('requires an Examples heading for call-and-output fences', () => {
    expect(codingExampleTextIssues('## Scenario\n```typescript\nf(1) // -> 2\n```', ['typescript'])).toEqual([expect.stringContaining('under an Examples heading')]);
  });
  it('checks individual nested examples rather than accepting a later block for an earlier case', () => {
    const text = '## Examples\n### Example 1\nNo code.\n### Example 2\n```typescript\nf(1) // -> 2\n```';
    expect(codingExampleTextIssues(text, ['typescript'])).toEqual([expect.stringContaining('requires a fenced code block')]);
  });
  it('finds prose examples in a coding drill, an AI handoff and drill notes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-examples-'));
    try {
      for (const dir of ['courses', 'guides/demo', 'drills/demo/code', 'drills/demo/pair/workspace', 'drills/demo/py/workspace']) await mkdir(join(root, dir), { recursive: true });
      const coding = { id: 'code', title: 'Code', contentType: 'coding', kind: 'logic', estMinutes: 5, sourcePath: 'drills/demo/code/code.ts', testPath: 'drills/demo/code/code.test.ts', instructions: '### Example 1\nInput: 2. Output: 3.' };
      const ai = { id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 5, sourcePath: 'drills/demo/pair/workspace/main.ts', workspacePath: 'drills/demo/pair/workspace', testRunner: 'vitest', handoffPath: 'guides/demo/handoff.md', rubricPath: 'guides/demo/rubric.md', instructions: '## Milestone 1\nFirst.\n## Milestone 2\nSecond.' };
      const py = { ...ai, id: 'py', title: 'Python', sourcePath: 'drills/demo/py/workspace/main.py', workspacePath: 'drills/demo/py/workspace', testRunner: 'pytest' };
      await writeFile(join(root, 'courses/demo.json'), JSON.stringify({ id: 'demo', title: 'Demo', chapters: [{ id: 'one', title: 'One', drills: [coding, ai, py] }] }));
      await writeFile(join(root, 'guides/demo/handoff.md'), '## Examples\nNo code.');
      await writeFile(join(root, 'drills/demo/code/notes.md'), 'For example, 2 returns 3.');
      const issues = await findCodingExampleIssues(join(root, 'courses'), ['demo']);
      expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'chapters[0].drills[0].instructions' }), expect.objectContaining({ field: 'guides/demo/handoff.md' }), expect.objectContaining({ field: 'drills/demo/code/notes.md' })]));
      await writeFile(join(root, 'guides/demo/handoff.md'), '## Examples\n```typescript\nf(1) // -> 2\n```');
      expect(await findCodingExampleIssues(join(root, 'courses'), ['demo'])).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'guides/demo/handoff.md', message: expect.stringContaining('must use python') })]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
