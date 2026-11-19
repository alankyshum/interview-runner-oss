import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MapRecall, sanitizeMapNode } from './MapRecall';
vi.mock('./RecallWhiteboard', () => ({ default: () => <div>Whiteboard canvas</div> }));

const lesson = { courseId: 'sample', drillId: 'first', title: 'Recall', questions: [{ id: 'one', prompt: 'First prompt?', answer: 'First secret answer.' }, { id: 'two', prompt: 'Second prompt?', answer: 'Second secret answer.' }] };
afterEach(() => vi.unstubAllGlobals());

describe('recall reader', () => {
  it('keeps the sticky map header on the page surface with balanced spacing', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/mapRecall.css'), 'utf8');
    const header = css.match(/\.map-recall-header\s*\{([^}]*)\}/)?.[1];
    expect(header).toContain('position: sticky');
    expect(header).toContain('padding-block: var(--mantine-spacing-xs)');
    expect(header).toContain('background: light-dark(var(--ir-color-canvas), var(--ir-color-surface))');
    const actions = css.match(/\.map-recall-actions\s*\{([^}]*)\}/)?.[1];
    expect(actions).not.toMatch(/overflow|nowrap/);
    expect(readFileSync(resolve(process.cwd(), 'src/reader/MapRecall.tsx'), 'utf8')).toContain('wrap="wrap" className="map-recall-actions"');
  });
  it('announces map loading without rendering a pan or selection hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/map-recall/') ? { source: '# Root\n- A note' } : { highlights: [], folds: null } })));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading map…');
    expect(document.querySelector('.map-recall-hint')).toBeNull();
    expect(screen.queryByText(/Drag to pan|Select node text/)).not.toBeInTheDocument();
  });
  it('keeps unflagged recall lessons as the original questions list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/map-recall/') ? lesson : {} })));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" /></MantineProvider>);
    const group = await screen.findByRole('group', { name: 'First prompt?' });
    fireEvent.click(within(group).getByRole('button', { name: 'Show answer' }));
    expect(screen.getByText('First secret answer.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Whiteboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('Whiteboard canvas')).not.toBeInTheDocument();
  });
  it('hides answers until revealed, persists across remount, allows hidden uncheck and scopes reset', async () => {
    let checks: Record<string, { checked: boolean }> = {};
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => lesson };
      if (init?.method === 'PUT') {
        const id = url.split('/').at(-1)!; const data = JSON.parse(String(init.body)) as { checked: boolean };
        checks = id === 'bulk' ? { one: { checked: false }, two: { checked: false } } : { ...checks, [id]: data };
      }
      return { ok: true, json: async () => ({ ...checks }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const element = <MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" /></MantineProvider>;
    const first = render(element);
    const group = await screen.findByRole('group', { name: 'First prompt?' });
    const checkbox = within(group).getByRole('checkbox', { name: 'I recalled this correctly' });
    expect(checkbox).toBeDisabled(); expect(screen.queryByText('First secret answer.')).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'Next question' }));
    expect(screen.getByRole('heading', { name: 'Second prompt?' })).toHaveFocus();
    expect(screen.queryByText('Second secret answer.')).not.toBeInTheDocument();
    const reveal = within(group).getByRole('button', { name: 'Show answer' });
    fireEvent.click(reveal); expect(screen.getByText('First secret answer.')).toBeInTheDocument();
    await waitFor(() => expect(checkbox).toBeEnabled()); fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    first.unmount(); render(element);
    const reopened = await screen.findByRole('group', { name: 'First prompt?' });
    await waitFor(() => expect(within(reopened).getByRole('checkbox')).toBeChecked());
    expect(screen.queryByText('First secret answer.')).not.toBeInTheDocument();
    fireEvent.click(within(reopened).getByRole('checkbox')); await waitFor(() => expect(within(reopened).getByRole('checkbox')).not.toBeChecked());
    fireEvent.click(within(reopened).getByRole('button', { name: 'Show answer' })); fireEvent.click(within(reopened).getByRole('checkbox'));
    await waitFor(() => expect(within(reopened).getByRole('checkbox')).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Lesson actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset to re-test' }));
    expect(await screen.findByText('Clear all 2 recall checks in this lesson? Answers will be hidden. Other lessons are unchanged.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close reset confirmation' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear checks' }));
    await waitFor(() => expect(within(reopened).getByRole('checkbox')).not.toBeChecked());
    expect(screen.queryByText('First secret answer.')).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/first/bulk'))).toBe(true);
  });
  it('reports a failed save and retries it without claiming success', async () => {
    let failed = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => lesson };
      if (init?.method === 'PUT' && !failed) { failed = true; return { ok: false, status: 503 }; }
      return { ok: true, json: async () => init?.method === 'PUT' ? { one: { checked: true } } : {} };
    }));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" /></MantineProvider>);
    const group = await screen.findByRole('group', { name: 'First prompt?' });
    fireEvent.click(within(group).getByRole('button', { name: 'Show answer' }));
    const checkbox = within(group).getByRole('checkbox'); await waitFor(() => expect(checkbox).toBeEnabled()); fireEvent.click(checkbox);
    expect(await screen.findByRole('alert')).toHaveTextContent('Recall check not saved'); expect(checkbox).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(checkbox).toBeChecked());
  });
  it.each([true, false])('keeps keyboard focus on the checkbox during and after a save (success=%s)', async (success) => {
    let finish!: (value: { ok: boolean; status?: number; json?: () => Promise<unknown> }) => void;
    const pending = new Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>((resolve) => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => lesson };
      if (init?.method === 'PUT') return pending;
      return { ok: true, json: async () => ({}) };
    }));
    const user = userEvent.setup();
    render(<MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" /></MantineProvider>);
    const group = await screen.findByRole('group', { name: 'First prompt?' });
    const reveal = within(group).getByRole('button', { name: 'Show answer' });
    const checkbox = within(group).getByRole('checkbox');
    await user.click(reveal); await waitFor(() => expect(checkbox).toBeEnabled());
    await user.tab(); expect(checkbox).toHaveFocus();
    await user.keyboard(' '); expect(checkbox).toHaveFocus(); expect(checkbox).toHaveAttribute('aria-disabled', 'true');
    finish(success ? { ok: true, json: async () => ({ one: { checked: true } }) } : { ok: false, status: 503 });
    await waitFor(() => expect(checkbox).not.toHaveAttribute('aria-disabled'));
    expect(checkbox).toHaveFocus();
    if (!success) expect(screen.getByRole('alert')).toHaveTextContent('Recall check not saved');
  });
  it('does not pull focus back after the user navigates during a pending save', async () => {
    let finish!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const pending = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url.startsWith('/api/map-recall/') ? { ok: true, json: async () => lesson } : init?.method === 'PUT' ? pending : { ok: true, json: async () => ({}) }));
    const user = userEvent.setup();
    render(<MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" /></MantineProvider>);
    const group = await screen.findByRole('group', { name: 'First prompt?' });
    await user.click(within(group).getByRole('button', { name: 'Show answer' }));
    const checkbox = within(group).getByRole('checkbox'); await waitFor(() => expect(checkbox).toBeEnabled());
    await user.click(checkbox); await user.click(within(group).getByRole('button', { name: 'Next question' }));
    const heading = screen.getByRole('heading', { name: 'Second prompt?' }); expect(heading).toHaveFocus();
    finish({ ok: true, json: async () => ({ one: { checked: true } }) });
    await waitFor(() => expect(checkbox).toBeChecked()); expect(heading).toHaveFocus();
  });
  it('reports question-load failure and retries', async () => {
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/map-recall/') && first) { first = false; return { ok: false, status: 503 }; }
      return { ok: true, json: async () => url.startsWith('/api/map-recall/') ? lesson : {} };
    }));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" /></MantineProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Questions unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'First prompt?' })).toBeInTheDocument();
  });
  it('allows reset when only an orphaned stored check remains', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/map-recall/') ? lesson : {} })));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" hasStoredChecks /></MantineProvider>);
    expect(await screen.findByText('0 of 2 recalled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lesson actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Reset to re-test' })).toBeEnabled();
  });
  it('reports map-load failure and exposes a retry', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 503 })); vi.stubGlobal('fetch', fetcher);
    render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Map unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});

describe('map content sanitization', () => {
  it('keeps safe inline markup but removes active HTML and unsafe links recursively', () => {
    const safe = sanitizeMapNode({ content: '<strong>Bold</strong><br><em>word</em> <code>x</code> <a href="https://example.com">link</a><img src=x onerror=alert(1)>', children: [{ content: '<a href="javascript:alert(1)" onclick="alert(1)">bad</a><script>alert(1)</script>', children: [] }] });
    expect(safe.content).toContain('<strong>Bold</strong><br><em>word</em>');
    expect(safe.content).toContain('href="https://example.com"');
    expect(sanitizeMapNode({ content: '<a href="#p2-variants">Cache</a>', children: [] }).content).toContain('href="#p2-variants"');
    expect(safe.content).not.toMatch(/img|onerror/); expect(safe.children[0].content).not.toMatch(/javascript|onclick|script/);
  });
  it('only keeps described, unambiguous local images and opens them safely at full size', () => {
    const invalid = ['https://example.com/image.png', '//host/image.png', 'javascript:alert(1)', 'data:image/png;base64,abc', '../image.png', '/images/../secret', '/images/%2e%2e/secret', '/images/file.png?x=1', '/images/file.png#x', '/images//file.png', '/images/./file.png', '/images/\\evil'];
    const content = `<img src="/images/course/interview-stages.png" alt="Interview stages" title="ignored" onerror="alert(1)" srcset="https://evil.test/image.png">${invalid.map((src) => `<img src="${src}" alt="bad">`).join('')}<img src="/images/course/empty.png"><img src="/images/course/empty.png" alt=" ">`;
    const sanitized = sanitizeMapNode({ content, children: [] });
    const element = document.createElement('div'); element.innerHTML = sanitized.content;
    const images = element.querySelectorAll('img'); expect(images).toHaveLength(1);
    expect(images[0].getAttributeNames().sort()).toEqual(['alt', 'src']);
    expect(images[0]).toHaveAttribute('src', '/images/course/interview-stages.png');
    expect(images[0]).toHaveAttribute('alt', 'Interview stages');
    expect(images[0].closest('a')).toHaveAttribute('href', '/images/course/interview-stages.png');
    expect(images[0].closest('a')).toHaveAttribute('target', '_blank');
    expect(images[0].closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
    const linked = document.createElement('div'); linked.innerHTML = sanitizeMapNode({ content: '<a href="https://example.com"><img src="/images/course/interview-stages.png" alt="Stages"></a>', children: [] }).content;
    expect(linked.querySelector('a')).toHaveAttribute('href', '/images/course/interview-stages.png');
    expect(linked.querySelector('a')).toHaveAttribute('target', '_blank');
  });
  it('renders Markdown images in the text outline', async () => {
    localStorage.setItem('map-recall-view', 'outline');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ source: '# Root\n\n## Stages\n\n![Interview stages](/images/course/interview-stages.png)' }) })));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    const image = await screen.findByRole('img', { name: 'Interview stages' });
    expect(image).toHaveAttribute('src', '/images/course/interview-stages.png');
    expect(image.closest('a')).toHaveAttribute('target', '_blank');
    localStorage.removeItem('map-recall-view');
  });
  it('keeps the map switch available in outline mode, even if SVG rendering fails', async () => {
    localStorage.removeItem('map-recall-view');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ source: '# Root\n\n## Branch' }) })));
    render(<MantineProvider><MapRecall courseId="sample" lessonId="map" title="Map" kind="map" /></MantineProvider>);
    const outline = await screen.findByRole('radio', { name: 'Text outline' });
    fireEvent.focus(outline);
    expect(await screen.findByRole('tooltip', { name: 'Text outline' })).toBeInTheDocument();
    fireEvent.blur(outline);
    fireEvent.click(outline);
    expect(screen.getByRole('navigation', { name: 'Text outline' })).toBeInTheDocument();
    const map = screen.getByRole('radio', { name: 'Map' });
    expect(document.querySelectorAll('.map-recall-view-label')).toHaveLength(2);
    fireEvent.click(map); expect(map).toBeChecked();
  });
});
