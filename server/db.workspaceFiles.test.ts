// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { validateWorkspaceFiles } from './db';

const files = (path = 'drills/course/drill/src/index.ts', content = 'export const value = 1;\n') => ({ files: [{ path, content, size: Buffer.byteLength(content), mode: 0o644 }], totalBytes: Buffer.byteLength(content) });

describe('workspace file validation', () => {
  it('rejects unsafe paths and files over every limit', () => {
    fc.assert(fc.property(fc.constantFrom('../escape', '/absolute', 'a\\b', 'src/../x', 'node_modules/pkg.js'), (path) => {
      expect(() => validateWorkspaceFiles(files(path))).toThrow();
    }));
    expect(() => validateWorkspaceFiles({ files: Array.from({ length: 2_001 }, (_, index) => ({ path: `f${index}`, content: '', size: 0, mode: 0o644 })), totalBytes: 0 })).toThrow();
    expect(() => validateWorkspaceFiles(files('large', 'x'.repeat(1024 * 1024 + 1)))).toThrow();
    expect(() => validateWorkspaceFiles({ files: [{ path: 'binary', binary: true, content: 'bad', size: 3, mode: 0o644, sha256: '0'.repeat(64) }], totalBytes: 3 })).toThrow();
  });
});
