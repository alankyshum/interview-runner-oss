import { useRef } from 'react';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheatsheetCoverage } from './CheatsheetCoverage';
import { emptyCoverageSignals } from '../../shared/cheatsheetCoverage';

const headings = [{ index: 0, title: 'Building blocks', level: 2, sectionId: 'building' }, { index: 1, title: 'Cache', level: 3, sectionId: 'cache' }];
function Reader() {
  const root = useRef<HTMLElement>(null);
  return <MantineProvider><main><CheatsheetCoverage courseId="sheet" root={root} headings={headings} hidden={false} onJump={() => {}} /><article ref={root} className="cheatsheet-content"><h2 data-sheet-heading-index="0">Building blocks</h2><article className="card pattern" id="p2"><h3 data-sheet-heading-index="1">Cache</h3><p tabIndex={0}>Cache-aside reads</p><a href="#building">Related</a><details className="deep-dive"><summary>Go deeper</summary><div data-markmap-src="map"><button>Zoom</button></div></details></article></article></main></MantineProvider>;
}
describe('cheatsheet coverage reader', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  it('marks reset as destructive and does not reset when confirmation is declined', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} })));
    vi.stubGlobal('fetch', fetcher);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<Reader />);
      const reset = screen.getByRole('button', { name: 'Reset coverage' });
      await waitFor(() => expect(reset).toBeEnabled());
      expect(reset).toHaveAttribute('data-ir-variant', 'danger');
      fireEvent.click(reset);
      await waitFor(() => expect(confirm).toHaveBeenCalledWith('Reset all coverage for this cheatsheet? This cannot be undone.'));
      expect(fetcher.mock.calls.every(([, init]) => !init || init.method !== 'DELETE')).toBe(true);
    } finally { confirm.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('renders the cheatsheet when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }))));
    try { render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled()); expect(screen.getByText('Cache-aside reads')).toBeInTheDocument(); }
    finally { vi.unstubAllGlobals(); }
  });
  it.each(['500', 'malformed'])('keeps the cheatsheet visible when coverage returns %s', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => kind === '500' ? new Response('', { status: 500 }) : new Response('{bad json')));
    try { render(<Reader />); await screen.findByRole('alert'); expect(screen.getByText('Cache-aside reads')).toBeInTheDocument(); }
    finally { vi.unstubAllGlobals(); }
  });
  it('isolates a coverage render exception from the reader', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { current: { closest: () => ({}), getBoundingClientRect: () => { throw new Error('coverage render failed'); } } } as unknown as React.RefObject<HTMLElement>;
    try {
      render(<MantineProvider><main><CheatsheetCoverage courseId="sheet" root={broken} headings={headings} hidden={false} onJump={() => {}} /><article>Reader still visible</article></main></MantineProvider>);
      expect(screen.getByText('Reader still visible')).toBeInTheDocument(); expect(screen.queryByRole('slider')).not.toBeInTheDocument(); expect(errors).toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });
  it('reuses the browser writer and its sequence after a reload', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, callback: () => unknown) => callback() } });
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      requests.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ snapshot: { generation: 0, revision: requests.length, regions: {} } }));
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      const first = render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled()); fireEvent.click(screen.getByText('Related'));
      await waitFor(() => expect(requests).toHaveLength(1), { timeout: 5000 });
      first.unmount(); render(<Reader />); await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2));
      fireEvent.click(screen.getByText('Related')); await waitFor(() => expect(requests).toHaveLength(2), { timeout: 5000 });
      expect(requests[1].writer).toBe(requests[0].writer); expect(requests[1].sequence).toBe(requests[0].sequence + 1);
      expect(localStorage.getItem('interview-runner-coverage-writer:sheet:0')).toContain(requests[0].writer);
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); if (descriptor) Object.defineProperty(navigator, 'locks', descriptor); else delete (navigator as { locks?: LockManager }).locks; }
  });
  it('serializes two tabs sharing one browser writer', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks'); let queue = Promise.resolve();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_key: string, callback: () => Promise<void> | void) => { const task = queue.then(callback); queue = task.catch(() => {}); return task; } } });
    const batches: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      batches.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ snapshot: { generation: 0, revision: batches.length, regions: {} } }));
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<><Reader /><Reader /></>); await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2));
      for (const link of screen.getAllByText('Related')) fireEvent.click(link);
      await waitFor(() => expect(batches).toHaveLength(2), { timeout: 5000 });
      expect(batches[0].writer).toBe(batches[1].writer); expect(batches.map((batch) => batch.sequence)).toEqual([1, 2]);
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); if (descriptor) Object.defineProperty(navigator, 'locks', descriptor); else delete (navigator as { locks?: LockManager }).locks; }
  });
  it('keeps the reader and local coverage on 429 with a quiet paused rail', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      requests.push(init); return new Response('', { status: 429 });
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled()); fireEvent.click(screen.getByText('Related'));
      const rail = await screen.findByRole('slider', { name: /Coverage paused: reset to continue recording/ }, { timeout: 5000 });
      expect(rail).toHaveAttribute('data-paused', 'true'); expect(rail).toHaveAttribute('title', 'Coverage paused: reset to continue recording');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByText('Cache-aside reads')).toBeInTheDocument();
      expect(rail.querySelectorAll('[data-status="high"]')).toHaveLength(1);
      fireEvent.click(screen.getByText('Related')); expect(requests).toHaveLength(1); expect(debug).toHaveBeenCalled();
    } finally { rects.mockRestore(); debug.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('describes the color legend and keeps the selected region status visible after a tap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }))));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled());
      const rail = screen.getByRole('slider', { name: 'Cheatsheet coverage map' });
      expect(rail).toHaveAttribute('aria-description', 'Attention relative to this sheet: blue for unvisited, purple for less attention, orange for moderate attention, red for most attention.');
      vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 200 } as DOMRect);
      fireEvent.click(rail, { clientY: 140 });
      expect(screen.getByRole('tooltip')).toHaveTextContent('Cache: Unvisited');
      expect(screen.getByRole('tooltip')).toHaveStyle({ top: '24px' });
      fireEvent.mouseLeave(rail); expect(screen.getByRole('tooltip')).toHaveTextContent('Cache: Unvisited');
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); }
  });
  it.each([
    [0, 0, 'unvisited', 'Unvisited'],
    [1, 0, 'high', 'Most attention relative to this sheet'],
    [0, 1, 'high', 'Most attention relative to this sheet'],
  ])('maps a sole visited region with dwell %i and interaction %i', async (dwellMs, selection, step, hint) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ generation: 0, revision: 1, regions: { p2: { ...emptyCoverageSignals(), dwellMs, selection, updatedAt: 1 } } }))));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<Reader />);
      await waitFor(() => expect(document.querySelector(`.coverage-rail [data-status="${step}"][data-color-step="${step}"]`)).toBeInTheDocument());
      const rail = screen.getByRole('slider', { name: 'Cheatsheet coverage map' });
      vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect);
      fireEvent.click(rail, { clientY: 20 });
      expect(screen.getByRole('tooltip')).toHaveTextContent(`Cache: ${hint}`);
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('colors regions relative to one another and describes the selected region', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ generation: 0, revision: 1, regions: {
      building: { ...emptyCoverageSignals(), selection: 2, updatedAt: 1 },
      p2: { ...emptyCoverageSignals(), selection: 10, updatedAt: 1 },
    } }))));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<Reader />);
      await waitFor(() => expect([...document.querySelectorAll('.coverage-rail [data-color-step]')].map((element) => element.getAttribute('data-color-step'))).toEqual(['low', 'high']));
      const rail = screen.getByRole('slider', { name: 'Cheatsheet coverage map' });
      fireEvent.keyDown(rail, { key: 'End' });
      expect(rail).toHaveAttribute('aria-valuetext', 'Cache: Most attention relative to this sheet');
      fireEvent.keyDown(rail, { key: 'Home' });
      expect(rail).toHaveAttribute('aria-valuetext', 'Building blocks: Less attention relative to this sheet');
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('retains the identical uncertain batch after a 429 and retries it on reload', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) throw new Error('Connection lost');
      if (requests.length === 2) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ applied: false, snapshot: { generation: 0, revision: 1, regions: {} } }));
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const first = render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled()); fireEvent.click(screen.getByText('Related'));
      await screen.findByRole('alert', {}, { timeout: 5000 }); fireEvent.click(screen.getByRole('button', { name: 'Retry coverage' }));
      await screen.findByRole('slider', { name: /Coverage paused/ }); first.unmount();
      render(<Reader />); await waitFor(() => expect(requests).toHaveLength(3));
      expect(requests[1]).toEqual(requests[0]); expect(requests[2]).toEqual(requests[0]);
    } finally { rects.mockRestore(); debug.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('records a selection in the card, debounces it and shows the highest-attention segment', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      const batch = JSON.parse(String(init.body)); requests.push(batch);
      return new Response(JSON.stringify({ applied: true, snapshot: { generation: 0, revision: 1, regions: { p2: { ...emptyCoverageSignals(), selection: 1, updatedAt: 1 } } } }));
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<Reader />); await waitFor(() => expect(screen.getByRole('slider', { name: 'Cheatsheet coverage map' })).toBeInTheDocument());
      const text = screen.getByText('Cache-aside reads').firstChild!; const range = document.createRange(); range.selectNodeContents(text);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); fireEvent(document, new Event('selectionchange'));
      await waitFor(() => expect(requests).toHaveLength(1), { timeout: 5000 });
      expect(requests[0].events.p2.selection).toBe(1); expect(requests[0].events.p2).not.toHaveProperty('text');
      await waitFor(() => expect(document.querySelectorAll('.coverage-rail [data-status="high"]')).toHaveLength(1));
      expect(document.querySelectorAll('.coverage-rail [data-status="unvisited"]')).toHaveLength(1);
      selection.removeAllRanges();
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('records links, opening deep dives, map keyboard actions and copies', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      const batch = JSON.parse(String(init.body)); requests.push(batch);
      return new Response(JSON.stringify({ applied: true, snapshot: { generation: 0, revision: 1, regions: { p2: { ...batch.events.p2, updatedAt: 1 } } } }));
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled());
      fireEvent.click(screen.getByText('Related'));
      const detail = document.querySelector<HTMLDetailsElement>('details.deep-dive')!; fireEvent.click(detail.querySelector('summary')!);
      fireEvent.keyDown(screen.getByText('Zoom'), { key: 'Enter' });
      const text = screen.getByText('Cache-aside reads'); text.focus(); fireEvent.copy(text);
      await waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 5000 });
      expect(requests[0].events.p2).toMatchObject({ link: 1, map: 1, copy: 1 }); expect(requests[0].events.p2.deep).toBeGreaterThanOrEqual(1);
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('retries the identical uncertain batch before sending new events', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ generation: 0, revision: 0, regions: {} }));
      const batch = JSON.parse(String(init.body)); requests.push(batch);
      if (requests.length === 1) throw new Error('Connection lost');
      return new Response(JSON.stringify({ applied: requests.length !== 2, snapshot: { generation: 0, revision: requests.length - 1, regions: { p2: { ...emptyCoverageSignals(), selection: 1, link: requests.length > 2 ? 1 : 0, updatedAt: 1 } } } }));
    }));
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      render(<Reader />); await waitFor(() => expect(fetch).toHaveBeenCalled());
      const text = screen.getByText('Cache-aside reads').firstChild!; const range = document.createRange(); range.selectNodeContents(text);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); fireEvent(document, new Event('selectionchange'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection lost'), { timeout: 5000 });
      fireEvent.click(screen.getByText('Related')); fireEvent.click(screen.getByRole('button', { name: 'Retry coverage' }));
      await waitFor(() => expect(requests).toHaveLength(3), { timeout: 5000 });
      expect(requests[1]).toEqual(requests[0]); expect(requests[2].sequence).toBe(2); expect(requests[2].events.p2.link).toBe(1);
      selection.removeAllRanges();
    } finally { rects.mockRestore(); vi.unstubAllGlobals(); }
  });

});
