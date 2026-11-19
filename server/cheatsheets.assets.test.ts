// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import apiPlugin from './apiPlugin';
import * as courses from './courses';
import * as repos from './courseRepos';
import { readCheatsheetDocument } from './cheatsheets';

describe('cheatsheet asset middleware', () => {
  it('serves nested runtime assets directly in Vite dev middleware', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheatsheet-assets-'));
    await mkdir(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'assets'), { recursive: true });
    await mkdir(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'sections'), { recursive: true });
    await mkdir(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'diagrams', 'mindmaps'), { recursive: true });
    await mkdir(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'diagrams', 'mermaid'), { recursive: true });
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'diagrams', 'mindmaps', 'map-001.md'), '# Safe map');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'assets', 'private.md'), 'not a map');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'assets', 'private.mmd'), 'not a diagram');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'diagrams', 'mermaid', 'flow-001.mmd'), 'flowchart TD\nA-->B');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'assets', 'sample.js'), 'window.sample = true;');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'sections', 'one.html'), '<p>Section</p>');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'assets', 'sample.png'), png);
    const sheet = { type: 'cheatsheet' as const, id: 'system-design-patterns-cheatsheet', title: 'Test', repo: 'test/repo', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'one', title: 'One', contentType: 'cheatsheet' as const, headingLevel: 2, sourcePath: 'cheatsheets/system-design-patterns-cheatsheet/sections/one.html' }] }] };
    const loadSheet = vi.spyOn(courses, 'loadCheatsheet').mockResolvedValue(sheet);
    vi.spyOn(repos, 'requireRepoForCourse').mockReturnValue({ id: 'test/repo', name: 'repo', root });
    let handler: ((request: any, response: any, next: () => void) => Promise<void>) | undefined;
    const plugin = apiPlugin({ watcherFactory: vi.fn(() => ({ close: vi.fn(), on: vi.fn() }) as any), runner: vi.fn(async () => {}) });
    (plugin.configureServer as any)({ middlewares: { use: (value: typeof handler) => { handler ??= value; } } });
    expect(handler).toBeDefined();
    const response = { statusCode: 0, headers: {} as Record<string, string>, body: undefined as Buffer | undefined,
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
      end(value?: Buffer) { this.body = value; } };
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/sections/one.html', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(response.body?.toString()).toBe('<p>Section</p>');
    const firstEtag = response.headers.etag; expect(firstEtag).toMatch(/^"[a-f0-9]{64}"$/);
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/sections/one.html', method: 'GET', headers: { 'if-none-match': firstEtag } }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(304); expect(response.body).toBeUndefined();
    expect((await readCheatsheetDocument(sheet)).sections[0].html).toBe('<p>Section</p>');
    const digest = createHash('sha256').update('one\0').update('<p>Section</p>').update('\0').digest('hex');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'page.html'), `<!-- interview-runner-sections-sha256:${digest} -->\n<h2>Whole page</h2>`);
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/page.html', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(200); expect(response.body?.toString()).toContain('Whole page');
    await writeFile(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'sections', 'one.html'), '<p>Edited section</p>');
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/sections/one.html', method: 'GET', headers: { 'if-none-match': firstEtag } }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(200); expect(response.headers.etag).not.toBe(firstEtag);
    expect((await readCheatsheetDocument(sheet)).sections[0].html).toBe('<p>Edited section</p>');
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/page.html', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(404);
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/diagrams/mermaid/flow-001.mmd', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toMatch(/^text\/plain/); expect(response.body?.toString()).toContain('flowchart TD');
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/assets/private.mmd', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(404);
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/assets/sample.png', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toEqual(png);
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/diagrams/mindmaps/map-001.md', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toMatch(/^text\/plain/); expect(response.body?.toString()).toBe('# Safe map');
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/assets/private.md', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(404);
    await writeFile(join(root, 'outside.png'), 'secret');
    await symlink(join(root, 'outside.png'), join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'assets', 'escape.png'));
    await rm(join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'sections', 'one.html'));
    await symlink(join(root, 'outside.png'), join(root, 'cheatsheets', 'system-design-patterns-cheatsheet', 'sections', 'one.html'));
    await expect(readCheatsheetDocument(sheet)).rejects.toThrow('escapes its directory');
    for (const path of ['/cheatsheets/system-design-patterns-cheatsheet/assets/sample.js', '/cheatsheets/system-design-patterns-cheatsheet/assets/escape.png', '/cheatsheets/system-design-patterns-cheatsheet/sections/one.html', '/cheatsheets/system-design-patterns-cheatsheet/page.html', '/cheatsheets/system-design-patterns-cheatsheet/%2e%2e/outside.png', '/cheatsheets/system-design-patterns-cheatsheet/assets%2fsample.png', '/cheatsheets/system-design-patterns-cheatsheet/index.html']) {
      await handler!({ url: path, method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
      expect(response.statusCode).toBe(404);
    }
    loadSheet.mockRejectedValueOnce(new Error('Invalid cheatsheet manifest'));
    await handler!({ url: '/cheatsheets/system-design-patterns-cheatsheet/assets/sample.png', method: 'GET' }, response, () => { throw new Error('asset route fell through'); });
    expect(response.statusCode).toBe(400); expect(response.body?.toString()).toContain('Invalid cheatsheet manifest');
    plugin.closeBundle?.();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
});
