import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { MapRecall } from './MapRecall';

const { scrollToContent } = vi.hoisted(() => ({ scrollToContent: vi.fn() }));
vi.mock('./OutlineDiagram', () => ({ OutlineDiagram: ({ node }: { node: { diagram: { src: string } } }) => <div data-testid="mermaid-diagram">{node.diagram.src}</div> }));
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'NEVER' },
  hashElementsVersion: (elements: Array<{ id: string }>) => elements.reduce((hash, e) => hash + e.id.length, 0),
  Excalidraw: ({ initialData, onChange, handleKeyboardGlobally, autoFocus, excalidrawAPI }: { initialData?: { elements: Array<{ id: string }> }; onChange: (elements: unknown[], appState: unknown, files: unknown) => void; handleKeyboardGlobally?: boolean; autoFocus?: boolean; excalidrawAPI?: (api: unknown) => void }) => {
    const [elements, setElements] = useState(initialData?.elements ?? []);
    useEffect(() => { onChange(elements, {}, {}); }, [onChange]);
    useEffect(() => { excalidrawAPI?.({ scrollToContent }); }, [excalidrawAPI]);
    return <div className="excalidraw" tabIndex={0} data-global={String(handleKeyboardGlobally)} data-autofocus={String(autoFocus)}><span data-testid="scene">{elements.map((item) => item.id).join(',')}</span><button onClick={() => { const next = [...elements, { id: 'shape', x: 0, y: 0, width: 10, height: 10, isDeleted: false }]; setElements(next); onChange(next, {}, {}); }}>Draw</button></div>;
  },
  getCommonBounds: () => [0, 0, 10, 10],
  exportToSvg: async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
}));

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders first-class prompt, expectation, hint and answer through the shared whiteboard', async () => {
  const diagram = '```mermaid\nflowchart TD\n A-->B\n```';
  const lesson = { courseId: 'sample', drillId: 'board', title: 'Board', questions: [{ id: 'one', prompt: `Prompt\n\n${diagram}`, expectation: 'State the invariant', hint: `Hint\n\n${diagram}`, answer: `Answer\n\n${diagram}` }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => lesson };
    if (url.startsWith('/api/recall-whiteboards/') && init?.method !== 'PUT') return { ok: true, json: async () => ({ snapshot: null, legacy: [{ id: 'one', snapshot: null }] }) };
    return { ok: true, json: async () => ({}) };
  }));
  render(<MantineProvider><MapRecall courseId="sample" lessonId="board" title="Board" kind="whiteboard" onToggleQuestions={() => {}} /></MantineProvider>);
  expect(await screen.findByText('State the invariant')).toBeInTheDocument(); expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(1);
  vi.useFakeTimers(); const button = screen.getByRole('button', { name: 'Hold 3s for hint · Milestone 1 (hold for 3 seconds)' }); fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }); act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3); expect(screen.getByText('Hint')).toBeInTheDocument(); expect(screen.getByText('Answer')).toBeInTheDocument(); vi.useRealTimers();
});
it('opens an opted-in whiteboard directly and retains unsaved work on remount', async () => {
  const lesson = { courseId: 'sample', drillId: 'first', title: 'Recall', questions: [{ id: 'one', prompt: 'First?', answer: 'Secret' }, { id: 'two', prompt: 'Second?', answer: 'Secret' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/map-recall/')) return { ok: true, json: async () => lesson };
    if (url.startsWith('/api/recall-whiteboards/') && init?.method !== 'PUT') return { ok: true, json: async () => ({ snapshot: null, legacy: lesson.questions.map((q) => ({ id: q.id, snapshot: null })) }) };
    if (init?.method === 'PUT') return { ok: true, json: async () => ({ updatedAt: JSON.parse(String(init.body)).updatedAt }) };
    return { ok: true, json: async () => ({}) };
  }));
  const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const view = <MantineProvider><MapRecall courseId="sample" lessonId="first" title="Recall" kind="recall" whiteboard onToggleQuestions={() => {}} /></MantineProvider>;
  const first = render(view); const draw = await screen.findByText('Draw');
  const returnButton = screen.getByText('Scroll back to content').closest('button')!; expect(returnButton).toBeDisabled();
  const canvas = draw.closest('.excalidraw')!; expect(canvas).toHaveAttribute('data-global', 'true'); expect(canvas).toHaveAttribute('data-autofocus', 'true');
  const listener = vi.fn(); document.addEventListener('keydown', listener);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Hide questions' }), { key: 'ArrowRight' }); expect(listener).not.toHaveBeenCalled();
  fireEvent.keyDown(canvas, { key: 'ArrowRight' }); expect(listener).toHaveBeenCalledOnce(); document.removeEventListener('keydown', listener);
  fireEvent.click(draw);
  await waitFor(() => expect(returnButton).toBeEnabled()); fireEvent.click(returnButton); expect(scrollToContent).toHaveBeenCalledWith(undefined, { fitToContent: true, animate: true });
  expect(await screen.findByText('Not saved locally', {}, { timeout: 2500 })).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'Whiteboard' })).not.toBeInTheDocument(); expect(screen.queryByRole('checkbox', { name: /recalled/i })).not.toBeInTheDocument();
  first.unmount(); render(view); await waitFor(() => expect(screen.getByTestId('scene')).toHaveTextContent('shape'));
  storage.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Saved locally · Synced');
});
