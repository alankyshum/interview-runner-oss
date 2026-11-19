import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateCheatsheetMermaid } from './cheatsheetMermaid';

const calls = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 640 400" onload="alert(1)"><style>@import url(https://attacker.test)</style><script>alert(1)</script><foreignObject>unsafe</foreignObject><text>Searchable label</text></svg>' })) }));
vi.mock('mermaid', () => ({ default: calls }));

describe('embedded Mermaid diagrams', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it('renders same-course sources in strict mode with sanitized searchable text and a scroll cue', async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { intersect = cb; } observe() {} disconnect() {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const fetcher = vi.fn(async () => new Response('flowchart TD\nA-->B')); vi.stubGlobal('fetch', fetcher);
    const root = document.createElement('article'); root.innerHTML = '<figure><div data-mermaid-src="diagrams/mermaid/flow-001.mmd" aria-label="Example"></div><details class="figure-transcript"><summary>Text version</summary>Fallback</details></figure>';
    const host = root.querySelector<HTMLElement>('[data-mermaid-src]')!; Object.defineProperty(host, 'clientWidth', { value: 320 });
    const stop = hydrateCheatsheetMermaid(root, 'example'); expect(fetcher).not.toHaveBeenCalled();
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(host.querySelector('svg text')).toHaveTextContent('Searchable label'));
    expect(calls.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }));
    expect(host.querySelector('script,style,foreignObject,[onload]')).toBeNull();
    expect(host.querySelector('.embedded-mermaid-scroll-hint')).toHaveTextContent('Scroll horizontally');
    const original = document.documentElement.getAttribute('data-mantine-color-scheme');
    try {
      document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
      await vi.waitFor(() => expect(calls.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: 'strict', theme: 'dark' })));
    } finally { stop(); if (original === null) document.documentElement.removeAttribute('data-mantine-color-scheme'); else document.documentElement.setAttribute('data-mantine-color-scheme', original); }
  });
  it('rejects unsafe paths and opens the text alternative', async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { intersect = cb; } observe() {} disconnect() {} });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = document.createElement('article'); root.innerHTML = '<figure><div data-mermaid-src="../../other.mmd"></div><details class="figure-transcript"><summary>Text version</summary>Fallback</details></figure>';
    const stop = hydrateCheatsheetMermaid(root, 'example'); intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(root.querySelector<HTMLDetailsElement>('details')?.open).toBe(true));
    expect(fetcher).not.toHaveBeenCalled(); stop(); log.mockRestore();
  });
});
