import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEffect, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import RecallWhiteboard from './RecallWhiteboard';

const mockCanvas = vi.hoisted(() => ({ change: undefined as ((elements: any[], appState: any, files: any) => void) | undefined, updateScene: vi.fn(), exportSvg: vi.fn(async () => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); return svg; }) }));
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'NEVER' },
  hashElementsVersion: (elements: Array<{ id: string; versionNonce?: number }>) => elements.reduce((hash, e) => (hash * 33 + (e.versionNonce ?? [...e.id].reduce((n, c) => n + c.charCodeAt(0), 0))) >>> 0, 5381),
  Excalidraw: ({ initialData, onChange, excalidrawAPI }: { initialData?: { elements: Array<{ id: string }>; appState?: object; files?: Record<string, unknown> }; onChange: (elements: unknown[], appState: any, files: unknown) => void; excalidrawAPI?: (api: any) => void }) => {
    const [elements, setElements] = useState(initialData?.elements ?? []);
    const files = useRef(initialData?.files ?? {}); const appState = useRef(initialData?.appState ?? {});
    useEffect(() => { mockCanvas.change = onChange; excalidrawAPI?.({ addFiles: (items: Array<{ id: string }>) => { for (const item of items) files.current[item.id] = item; }, updateScene: (value: { elements?: Array<{ id: string }>; appState?: object }) => { mockCanvas.updateScene(value); const next = value.elements ?? []; appState.current = value.appState ?? {}; setElements(next); onChange(next, appState.current, files.current); } }); onChange(elements.map((item: any) => item.boundElements === null ? { ...item, boundElements: [] } : item), appState.current, files.current); }, [excalidrawAPI, onChange]);
    return <><span data-testid="scene">{elements.map((element) => element.id).join(',')}</span><button onClick={() => { const next = [...elements, { id: 'drawn', x: 0, y: 0, width: 10, height: 10, isDeleted: false }]; setElements(next); onChange(next, appState.current, files.current); }}>Draw</button></>;
  },
  getCommonBounds: (elements: Array<{ x: number; y: number; width: number; height: number }>) => [Math.min(...elements.map((e) => e.x)), Math.min(...elements.map((e) => e.y)), Math.max(...elements.map((e) => e.x + e.width)), Math.max(...elements.map((e) => e.y + e.height))],
  exportToSvg: mockCanvas.exportSvg,
}));

const lesson = { courseId: 'sample', drillId: 'lesson', title: 'Recall', questions: [{ id: 'one', prompt: 'First prompt?', answer: 'First answer' }, { id: 'two', prompt: 'Second prompt?', answer: 'Second answer' }] };
const legacyKey = (id: string) => `recall-whiteboard:${JSON.stringify(['sample', 'lesson', id])}`;
const drillKey = `recall-whiteboard:${JSON.stringify(['sample', 'lesson'])}`;
const snapshot = (id: string, updatedAt: number) => ({ scene: { elements: [{ id, type: 'rectangle', x: 10, y: 20, width: 100, height: 50, groupIds: [], isDeleted: false }], appState: {}, files: {} }, svg: '<svg></svg>', updatedAt });
const element = <MantineProvider><RecallWhiteboard lesson={lesson} questionsCollapsed={false} /></MantineProvider>;
afterEach(() => { cleanup(); localStorage.clear(); mockCanvas.change = undefined; mockCanvas.updateScene.mockClear(); mockCanvas.exportSvg.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('allows mobile timer and conflict recovery controls to wrap without wrapping their labels', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/reader/recallWhiteboard.css'), 'utf8');
  expect(css).toContain('.recall-whiteboard-actions > .ir-timer { flex: 1 0 100%; flex-wrap: wrap; }');
  expect(css).toContain('.whiteboard-status[data-conflict] button { width: auto; padding-inline: var(--mantine-spacing-sm); }');
  expect(css).not.toContain('.whiteboard-status[data-conflict] .mantine-Button-label { white-space: normal');
});

it('combines the newer local and server question scenes once, preserving the old records', async () => {
  const now = Date.now(); const local = snapshot('local-newer', now - 100); const old = snapshot('server-older', now - 200); const second = snapshot('second', now - 150);
  localStorage.setItem(legacyKey('one'), JSON.stringify(local)); let saved: any = null;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved = JSON.parse(String(init.body)); return { ok: true, json: async () => ({ updatedAt: saved.updatedAt }) }; }
    return { ok: true, json: async () => ({ questions: lesson.questions.map(({ id, prompt }) => ({ id, prompt })), snapshot: saved, legacy: [{ id: 'one', snapshot: old }, { id: 'two', snapshot: second }] }) };
  });
  vi.stubGlobal('fetch', fetcher); const first = render(element);
  expect(await screen.findByTestId('scene')).toHaveTextContent('legacy-0-element-local-newer,legacy-1-element-second');
  await waitFor(() => expect(saved?.scene.elements).toHaveLength(2));
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!;
  expect(put.headers).toMatchObject({ 'If-None-Match': '*' }); expect(saved.svg).toContain('<svg');
  expect(JSON.parse(localStorage.getItem(legacyKey('one'))!).scene.elements[0].id).toBe('local-newer');
  await waitFor(() => expect(JSON.parse(localStorage.getItem(drillKey)!).migrationPending).toBeUndefined());
  expect(JSON.parse(localStorage.getItem(drillKey)!)).toMatchObject({ legacySources: { one: local.updatedAt, two: second.updatedAt }, scene: { elements: expect.any(Array) } });
  expect(saved).not.toHaveProperty('migrationPending'); expect(saved).not.toHaveProperty('legacySources');
  first.unmount(); render(element); expect(await screen.findByTestId('scene')).toHaveTextContent('legacy-1-element-second');
  expect(screen.queryByText('First answer')).not.toBeInTheDocument();
});

it('uses the newer drill snapshot and does not resurrect legacy drawings after migration', async () => {
  const newer = snapshot('local', 2); localStorage.setItem(drillKey, JSON.stringify(newer)); localStorage.setItem(legacyKey('one'), JSON.stringify(snapshot('old', 1)));
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: true, json: async () => ({ updatedAt: JSON.parse(String(init.body)).updatedAt }) } : { ok: true, json: async () => ({ snapshot: snapshot('server', 1), questions: [], legacy: [{ id: 'one', snapshot: snapshot('old', 1) }, { id: 'two', snapshot: null }] }) });
  vi.stubGlobal('fetch', fetcher); render(element);
  expect(await screen.findByTestId('scene')).toHaveTextContent('local'); expect(screen.getByTestId('scene')).not.toHaveTextContent('old');
});

it('does not overwrite a board created concurrently with the one-time migration', async () => {
  const now = Date.now(); const old = snapshot('old', now - 1000); const winner = snapshot('winner', now + 1); let raced = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { raced = true; return { ok: false, status: 409, json: async () => ({ snapshot: winner }) }; }
    return { ok: true, json: async () => ({ snapshot: raced ? winner : null, legacy: [{ id: 'one', snapshot: old }, { id: 'two', snapshot: null }] }) };
  });
  vi.stubGlobal('fetch', fetcher); const first = render(element);
  const failed = await screen.findByText('Changed elsewhere');
  expect(failed.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
  expect(failed.closest('.whiteboard-status')?.parentElement).toHaveClass('recall-whiteboard-canvas');
  expect(failed.closest('.whiteboard-status')).toContainElement(screen.getByRole('button', { name: 'Keep mine' }));
  expect(JSON.parse(localStorage.getItem(drillKey)!).migrationPending).toBe(true);
  first.unmount(); render(element); expect(await screen.findByTestId('scene')).toHaveTextContent('legacy-0-element-old');
  fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').length).toBeGreaterThan(1));
  expect(fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]?.headers).toMatchObject({ 'If-None-Match': '*' });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)?.[1]?.headers).toMatchObject({ 'If-Match': `"${winner.updatedAt}"` });
});

it('keeps the overlay and Retry available when the canvas cannot load', async () => {
  let unavailable = true;
  const reveal = vi.spyOn(Element.prototype, 'scrollIntoView');
  vi.stubGlobal('fetch', vi.fn(async () => unavailable ? { ok: false, status: 503 } : { ok: true, json: async () => ({ snapshot: null, legacy: lesson.questions.map((q) => ({ id: q.id, snapshot: null })) }) }));
  render(element);
  const status = await screen.findByText('Whiteboard unavailable');
  expect(status.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
  const overlay = status.closest('.whiteboard-status');
  expect(overlay?.parentElement).toHaveClass('recall-whiteboard-canvas');
  expect(overlay).toContainElement(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(reveal.mock.contexts).toContain(overlay));
  const count = reveal.mock.calls.length; fireEvent(window, new Event('resize'));
  await waitFor(() => expect(reveal.mock.calls.length).toBeGreaterThan(count));
  expect(screen.queryByText('Draw')).not.toBeInTheDocument();
  unavailable = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Draw')).toBeInTheDocument();
  expect(screen.getByText('Ready to draw')).toHaveAttribute('aria-live', 'polite');
});

it('preserves local legacy drawings from another device when the drill board already exists', async () => {
  localStorage.setItem(legacyKey('one'), JSON.stringify(snapshot('local-unsynced', 3)));
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: snapshot('board', 4), legacy: [{ id: 'one', snapshot: snapshot('server-old', 2) }, { id: 'two', snapshot: null }] }) }));
  vi.stubGlobal('fetch', fetcher); render(element);
  expect(await screen.findByText(/unmigrated local question drawings/)).toBeInTheDocument();
  expect(screen.queryByText('Draw')).not.toBeInTheDocument(); expect(localStorage.getItem(legacyKey('one'))).not.toBeNull();
  expect(fetcher.mock.calls).toHaveLength(1);
});

it('does not silently ignore later legacy edits on a device that already migrated', async () => {
  localStorage.setItem(drillKey, JSON.stringify({ ...snapshot('board', 5), legacySources: { one: 2 } }));
  localStorage.setItem(legacyKey('one'), JSON.stringify(snapshot('later-old-tab', 3)));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: snapshot('board', 5), legacy: [{ id: 'one', snapshot: snapshot('old', 2) }, { id: 'two', snapshot: null }] }) })));
  render(element); expect(await screen.findByText(/unmigrated local question drawings/)).toBeInTheDocument();
  expect(screen.queryByText('Draw')).not.toBeInTheDocument(); expect(localStorage.getItem(legacyKey('one'))).not.toBeNull();
});

it('keeps unsaved drawings in memory and warns on unload when local storage fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: false, status: 503 } : { ok: true, json: async () => ({ snapshot: null, legacy: lesson.questions.map((q) => ({ id: q.id, snapshot: null })) }) }));
  const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
  try {
    const first = render(element); fireEvent.click(await screen.findByText('Draw'));
    expect(await screen.findByText('Not saved locally', {}, { timeout: 2500 })).toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    first.unmount(); render(element); expect(await screen.findByTestId('scene')).toHaveTextContent('drawn');
    storage.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Saved locally · Sync failed');
    const safe = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(safe); expect(safe.defaultPrevented).toBe(false);
  } finally { storage.mockRestore(); }
});

it('fails closed on an invalid legacy snapshot rather than overwriting it', async () => {
  localStorage.setItem(legacyKey('one'), '');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: null, legacy: lesson.questions.map((q) => ({ id: q.id, snapshot: null })) }) })));
  render(element); expect(await screen.findByText(/Invalid local whiteboard/)).toBeInTheDocument();
  expect(screen.queryByText('Draw')).not.toBeInTheDocument(); expect(localStorage.getItem(legacyKey('one'))).toBe('');
});

it('shows both prompts and reveals each answer with the coding hold-for-hint control', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: null, legacy: lesson.questions.map((q) => ({ id: q.id, snapshot: null })) }) })));
  render(element); await screen.findByText('Draw');
  expect(screen.getByText('First prompt?')).toBeInTheDocument(); expect(screen.getByText('Second prompt?')).toBeInTheDocument(); expect(screen.queryByText('First answer')).not.toBeInTheDocument();
  vi.useFakeTimers(); try { fireEvent.keyDown(screen.getByRole('button', { name: 'Hold 3s for hint · Milestone 1 (hold for 3 seconds)' }), { key: 'Enter' }); act(() => vi.advanceTimersByTime(3000)); expect(screen.getByText('First answer')).toBeInTheDocument(); expect(screen.queryByText('Second answer')).not.toBeInTheDocument(); } finally { vi.useRealTimers(); }
});

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const emit = (elements: any[], appState: any = {}, files: any = {}) => { act(() => mockCanvas.change!(elements, appState, files)); };
const puts = (fetcher: any) => fetcher.mock.calls.filter(([, init]: any[]) => init?.method === 'PUT');

it('baselines restore normalization and saves viewport changes only locally', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10, boundElements: null };
  remote.scene.elements = [shape] as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: true, json: async () => ({ updatedAt: JSON.parse(String(init.body)).updatedAt }) } : { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
  vi.stubGlobal('fetch', fetcher); const view = render(element); await screen.findByTestId('scene');
  expect(localStorage.getItem(drillKey)).toBeNull(); vi.useFakeTimers();
  emit([{ ...shape, boundElements: [] }], { scrollX: 120, scrollY: 40, zoom: { value: 1.5 } });
  await tick(13000); expect(puts(fetcher)).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem(drillKey)!).scene.appState.scrollX).toBe(120);
  view.unmount(); await tick(1); expect(puts(fetcher)).toHaveLength(0);
});

it('keeps the Excalidraw change handler stable across parent rerenders', async () => {
  const remote = snapshot('initial', Date.now() - 1000);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) })));
  const view = render(element); await screen.findByTestId('scene'); const original = mockCanvas.change;
  view.rerender(<MantineProvider><RecallWhiteboard lesson={lesson} questionsCollapsed={false} editorPercent={75} /></MantineProvider>);
  expect(mockCanvas.change).toBe(original);
});

it('debounces one content edit and shows Syncing only while the PUT is in flight', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  let resolvePut!: (value: any) => void; let sent: any;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => { if (init?.method === 'PUT') { sent = JSON.parse(String(init.body)); return new Promise((resolve) => { resolvePut = resolve; }); } return Promise.resolve({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }); });
  vi.stubGlobal('fetch', fetcher); const view = render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, versionNonce: 11 }]); await tick(1000);
  expect(screen.getByText('Saved locally')).toBeInTheDocument(); expect(puts(fetcher)).toHaveLength(0);
  await tick(1499); expect(puts(fetcher)).toHaveLength(0); expect(screen.queryByText(/Syncing/)).not.toBeInTheDocument();
  await tick(1); expect(puts(fetcher)).toHaveLength(1); expect(screen.getByText('Saved locally · Syncing…')).toBeInTheDocument();
  expect(puts(fetcher)[0][1].headers).toMatchObject({ 'If-Match': `"${remote.updatedAt}"` });
  await act(async () => { resolvePut({ ok: true, json: async () => ({ updatedAt: sent.updatedAt }) }); });
  expect(screen.getByText('Saved locally · Synced')).toBeInTheDocument();
  view.unmount(); await tick(1); expect(puts(fetcher)).toHaveLength(1);
});

it('treats background and file IDs as content while ignoring file-key order', async () => {
  let remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  remote.scene.appState = { viewBackgroundColor: '#ffffff' }; remote.scene.files = { a: { id: 'a' }, b: { id: 'b' } } as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'PUT') { remote = JSON.parse(String(init.body)); return { ok: true, json: async () => ({ updatedAt: remote.updatedAt }) }; } return { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }; });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([shape], { viewBackgroundColor: '#ffffff' }, { b: { id: 'b' }, a: { id: 'a' } }); await tick(13000); expect(puts(fetcher)).toHaveLength(0);
  emit([shape], { viewBackgroundColor: '#ffffff' }, { b: { id: 'b' }, a: { id: 'a' }, c: { id: 'c' } }); await tick(2500); expect(puts(fetcher)).toHaveLength(1);
  emit([shape], { viewBackgroundColor: '#000000' }, { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } }); await tick(2500); expect(puts(fetcher)).toHaveLength(2);
});

it('flushes continuous content edits at maxWait and again after the final debounce', async () => {
  let remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'PUT') { remote = JSON.parse(String(init.body)); return { ok: true, json: async () => ({ updatedAt: remote.updatedAt }) }; } return { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }; });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  for (let i = 1; i <= 12; i++) { emit([{ ...shape, versionNonce: 10 + i }]); await tick(1000); if (i < 12) expect(puts(fetcher)).toHaveLength(0); }
  expect(puts(fetcher)).toHaveLength(1);
  emit([{ ...shape, versionNonce: 99 }]); await tick(2500); expect(puts(fetcher)).toHaveLength(2);
});

it('sends edits made during an in-flight save against the acknowledged base', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  let resolveFirst!: (value: any) => void; let firstTimestamp = 0;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Promise.resolve({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
    const body = JSON.parse(String(init.body));
    if (!firstTimestamp) { firstTimestamp = body.updatedAt; return new Promise((resolve) => { resolveFirst = resolve; }); }
    return Promise.resolve({ ok: true, json: async () => ({ updatedAt: body.updatedAt }) });
  });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, versionNonce: 11 }]); await tick(2500); expect(puts(fetcher)).toHaveLength(1);
  emit([{ ...shape, versionNonce: 12 }]); await tick(1000);
  await act(async () => { resolveFirst({ ok: true, json: async () => ({ updatedAt: firstTimestamp }) }); });
  expect(screen.getByText('Saved locally')).toBeInTheDocument(); expect(screen.queryByText(/Syncing/)).not.toBeInTheDocument();
  await tick(2500); expect(puts(fetcher)).toHaveLength(2);
  expect(puts(fetcher)[1][1].headers).toMatchObject({ 'If-Match': `"${firstTimestamp}"` });
  expect(JSON.parse(puts(fetcher)[1][1].body).scene.elements[0].versionNonce).toBe(12);
  expect(screen.getByText('Saved locally · Synced')).toBeInTheDocument();
});

it('resends a revert made while an earlier save was in flight with a newer revision', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  let resolveFirst!: (value: any) => void; let firstTimestamp = 0;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Promise.resolve({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
    const body = JSON.parse(String(init.body));
    if (!firstTimestamp) { firstTimestamp = body.updatedAt; return new Promise((resolve) => { resolveFirst = resolve; }); }
    return Promise.resolve({ ok: true, json: async () => ({ updatedAt: body.updatedAt }) });
  });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, versionNonce: 11 }]); await tick(2500); emit([shape]);
  await act(async () => { resolveFirst({ ok: true, json: async () => ({ updatedAt: firstTimestamp }) }); });
  await tick(2500); expect(puts(fetcher)).toHaveLength(2);
  const body = JSON.parse(puts(fetcher)[1][1].body); expect(body.scene.elements[0].versionNonce).toBe(10); expect(body.updatedAt).toBeGreaterThan(firstTimestamp);
  expect(puts(fetcher)[1][1].headers).toMatchObject({ 'If-Match': `"${firstTimestamp}"` });
});

it('does not resync a locally saved edit that was reverted before sending', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: true, json: async () => ({ updatedAt: JSON.parse(String(init.body)).updatedAt }) } : { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
  vi.stubGlobal('fetch', fetcher); const first = render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, versionNonce: 11 }]); await tick(1000); emit([shape]); await tick(1000);
  expect(JSON.parse(localStorage.getItem(drillKey)!).updatedAt).toBe(remote.updatedAt); expect(puts(fetcher)).toHaveLength(0);
  first.unmount(); render(element); await tick(13000); expect(puts(fetcher)).toHaveLength(0);
});

it('preserves local edits on conflict and uses the new base only for Keep mine', async () => {
  const remote = snapshot('initial', Date.now() - 5000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const newer = snapshot('agent', remote.updatedAt + 1000); let calls = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'PUT') { calls++; if (calls === 1) return { ok: false, status: 409, json: async () => ({ snapshot: newer }) }; const value = JSON.parse(String(init.body)); return { ok: true, json: async () => ({ updatedAt: value.updatedAt }) }; } return { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }; });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, id: 'my-edit', versionNonce: 11 }]); await tick(2500);
  expect(screen.getByText('Changed elsewhere')).toBeInTheDocument(); expect(mockCanvas.updateScene).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(drillKey)!).scene.elements[0].id).toBe('my-edit');
  fireEvent.click(screen.getByRole('button', { name: 'Keep mine' })); await tick(1);
  expect(puts(fetcher)).toHaveLength(2); expect(puts(fetcher)[1][1].headers).toMatchObject({ 'If-Match': `"${newer.updatedAt}"` });
  expect(screen.getByText('Saved locally · Synced')).toBeInTheDocument();
});

it('silently adopts a conflict if the user has reverted all unsynced edits', async () => {
  const remote = snapshot('initial', Date.now() - 5000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const newer = snapshot('agent', remote.updatedAt + 1000); let resolvePut!: (value: any) => void;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => init?.method === 'PUT' ? new Promise((resolve) => { resolvePut = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }));
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, versionNonce: 11 }]); await tick(2500); expect(puts(fetcher)).toHaveLength(1);
  emit([shape]);
  await act(async () => { resolvePut({ ok: false, status: 409, json: async () => ({ snapshot: newer }) }); });
  expect(mockCanvas.updateScene).toHaveBeenCalledOnce(); expect(screen.getByTestId('scene')).toHaveTextContent('agent');
  expect(screen.queryByText('Changed elsewhere')).not.toBeInTheDocument(); expect(screen.getByText('Saved locally · Synced')).toBeInTheDocument();
});

it('loads the latest conflicting scene only after the user chooses it', async () => {
  const remote = snapshot('initial', Date.now() - 5000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const newer = snapshot('agent', remote.updatedAt + 1000);
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: false, status: 409, json: async () => ({ snapshot: newer }) } : { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, id: 'my-edit', versionNonce: 11 }]); await tick(2500);
  expect(screen.getByText('Changed elsewhere')).toBeInTheDocument(); expect(mockCanvas.updateScene).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Load latest' }));
  expect(mockCanvas.updateScene).toHaveBeenCalledOnce(); expect(screen.getByTestId('scene')).toHaveTextContent('agent');
  expect(screen.queryByText('Changed elsewhere')).not.toBeInTheDocument(); expect(screen.getByText('Saved locally · Synced')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(drillKey)!).scene.elements[0].id).toBe('agent'); await tick(13000); expect(puts(fetcher)).toHaveLength(1);
});

it('reinitializes the canvas when the latest scene replaces its files', async () => {
  const remote = snapshot('initial', Date.now() - 5000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  remote.scene.files = { old: { id: 'old', dataURL: 'data:image/png;base64,AA==' } } as any;
  const newer = snapshot('agent', remote.updatedAt + 1000); newer.scene.files = { fresh: { id: 'fresh', dataURL: 'data:image/png;base64,AQ==' } } as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: false, status: 409, json: async () => ({ snapshot: newer }) } : { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
  vi.stubGlobal('fetch', fetcher); render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, id: 'my-edit', versionNonce: 11 }], {}, remote.scene.files); await tick(2500);
  fireEvent.click(screen.getByRole('button', { name: 'Load latest' })); await tick(1);
  expect(mockCanvas.updateScene).not.toHaveBeenCalled(); expect(screen.getByTestId('scene')).toHaveTextContent('agent');
  expect(Object.keys(JSON.parse(localStorage.getItem(drillKey)!).scene.files)).toEqual(['fresh']);
});

it('keeps older local snapshots of unknown provenance on conflict instead of discarding them', async () => {
  const local = snapshot('offline', 2); localStorage.setItem(drillKey, JSON.stringify(local)); const remote = snapshot('agent', 4);
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }));
  vi.stubGlobal('fetch', fetcher); render(element); expect(await screen.findByText('Changed elsewhere')).toBeInTheDocument();
  expect(screen.getByTestId('scene')).toHaveTextContent('offline'); expect(JSON.parse(localStorage.getItem(drillKey)!).scene.elements[0].id).toBe('offline');
  expect(puts(fetcher)).toHaveLength(0);
});

it('preserves differing local and server scenes even when their timestamps are equal', async () => {
  localStorage.setItem(drillKey, JSON.stringify(snapshot('offline', 5))); const remote = snapshot('agent', 5);
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: remote, legacy: [] }) }));
  vi.stubGlobal('fetch', fetcher); render(element); expect(await screen.findByText('Changed elsewhere')).toBeInTheDocument();
  expect(screen.getByTestId('scene')).toHaveTextContent('offline'); expect(puts(fetcher)).toHaveLength(0);
});

it('sends an unsynced small pagehide immediately without exporting again', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: true, json: async () => ({ updatedAt: JSON.parse(String(init.body)).updatedAt }) } : { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
  vi.stubGlobal('fetch', fetcher); const view = render(element); await screen.findByTestId('scene'); vi.useFakeTimers(); mockCanvas.exportSvg.mockClear();
  emit([{ ...shape, versionNonce: 11 }]); fireEvent(window, new Event('pagehide'));
  expect(puts(fetcher)).toHaveLength(1); expect(puts(fetcher)[0][1]).toMatchObject({ keepalive: true, headers: { 'If-Match': `"${remote.updatedAt}"` } }); expect(mockCanvas.exportSvg).not.toHaveBeenCalled();
  view.unmount(); expect(puts(fetcher)).toHaveLength(1);
});

it('does not send an oversized keepalive and retains pending content for the next load', async () => {
  const remote = snapshot('initial', Date.now() - 1000); const shape = { ...remote.scene.elements[0], versionNonce: 10 }; remote.scene.elements = [shape] as any;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: true, json: async () => ({ updatedAt: JSON.parse(String(init.body)).updatedAt }) } : { ok: true, json: async () => ({ snapshot: remote, legacy: [] }) });
  vi.stubGlobal('fetch', fetcher); const first = render(element); await screen.findByTestId('scene'); vi.useFakeTimers();
  emit([{ ...shape, versionNonce: 11, customData: { text: 'x'.repeat(70000) } }]); fireEvent(window, new Event('pagehide'));
  expect(puts(fetcher)).toHaveLength(0); expect(JSON.parse(localStorage.getItem(drillKey)!).pendingSync).toBe(true);
  first.unmount(); render(element); await tick(1); expect(puts(fetcher)).toHaveLength(1);
});
