// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseIrResult } from './apiPlugin';

describe('sandbox result envelope', () => {
  it('accepts one bounded, validated IR_RESULT line', () => {
    const value = { status: 'passed', diagnostics: [], tests: [{ name: 'works', status: 'passed' }] };
    expect(parseIrResult(`noise\nIR_RESULT ${JSON.stringify(value)}\n`).status).toBe('passed');
  });
  it('validates and sanitizes optional output test names without changing legacy entries', () => {
    const result = { status: 'passed', diagnostics: [], tests: [{ name: 'works', status: 'passed' }], output: { entries: [{ stream: 'stdout', text: 'setup' }, { stream: 'stdout', text: '/workspace/debug', testName: '/workspace/logs.test.ts > group > works' }] } };
    expect(parseIrResult(`IR_RESULT ${JSON.stringify(result)}`, ['/workspace/']).output?.entries).toEqual([{ stream: 'stdout', text: 'setup' }, { stream: 'stdout', text: 'debug', testName: 'logs.test.ts > group > works' }]);
    for (const testName of [42, '', 'x'.repeat(2001)]) { const bad = { ...result, output: { entries: [{ stream: 'stdout', text: 'x', testName }] } }; expect(() => parseIrResult(`IR_RESULT ${JSON.stringify(bad)}`)).toThrow('invalid test result'); }
  });

  it('rejects arbitrary and duplicate envelopes', () => {
    fc.assert(fc.property(fc.string(), (value) => { if (!value.startsWith('IR_RESULT ')) expect(() => parseIrResult(value)).toThrow(); }), { numRuns: 100 });
    const line = 'IR_RESULT {"status":"passed","diagnostics":[],"tests":[]}'; expect(() => parseIrResult(`${line}\n${line}`)).toThrow('invalid result envelope');
    expect(() => parseIrResult('x'.repeat(4 * 1024 * 1024 + 1))).toThrow('4 MiB');
  });
});
