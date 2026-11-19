import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SandboxWorkspaceShell from './SandboxWorkspaceShell';
import { CourseRunnerHotkeysProvider, SANDBOX_HOTKEY_EVENT } from './appHotkeys';

const result = { status: 'passed', diagnostics: [], tests: [{ name: 'works', status: 'passed' }] } as const;

describe('completed sandbox workspace', () => {
  beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => { const url = String(input); if (url.includes('/course-hints/')) return new Response(JSON.stringify({ courseId: 'course', drills: {} })); if (url.endsWith('/hints')) return new Response(JSON.stringify({ revealed: [] })); return new Response(JSON.stringify({ submissions: [{ id: 1, submittedAt: new Date().toISOString(), result, commitSha: 'abcdef0123456789' }] })); })); });
  it('shows each output chunk under its test name or Outside tests', async () => {
    const watcherResult = { status: 'failed', updatedAt: '2026-01-01', tests: [{ name: 'alpha same', status: 'passed' }, { name: 'beta same', status: 'failed' }, { name: 'silent', status: 'passed' }], output: { entries: [{ stream: 'stdout' as const, text: 'module log' }, { stream: 'stdout' as const, text: 'alpha log', testName: 'logs.test.ts > alpha > same' }, { stream: 'stdout' as const, text: 'beta log', testName: 'logs.test.ts > beta > same' }, { stream: 'stdout' as const, text: '', testName: 'silent' }] } };
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" watcherResult={watcherResult} runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    await userEvent.click(screen.getByRole('radio', { name: /Results/ })); const output = screen.getByLabelText('Console output');
    for (const [label, text] of [['Outside tests', 'module log'], ['logs.test.ts > alpha > same', 'alpha log'], ['logs.test.ts > beta > same', 'beta log']]) {
      const heading = within(output).getByText(label); expect(heading.parentElement).toHaveTextContent(text); expect(heading.compareDocumentPosition(within(output).getByText(text)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(within(output).getByRole('region', { name: `${label} stdout output` })).toHaveTextContent(text);
    }
    expect(within(output).queryByText('silent')).not.toBeInTheDocument();
  });
  it.each(['run', 'submit'])('shows a test timeout from %s without marking the drill done', async (action) => {
    const message = 'Tests stopped after 15s. Your code may have an infinite loop.'; const done = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => { const url = String(input); if (url.endsWith(`/${action}`)) return new Response(JSON.stringify({ status: 'error', diagnostics: [], tests: [{ name: 'Test execution error', status: 'failed', message }] }), { status: action === 'submit' ? 409 : 200 }); if (url.includes('/course-hints/')) return new Response(JSON.stringify({ courseId: 'course', drills: {} })); if (url.endsWith('/hints')) return new Response(JSON.stringify({ revealed: [] })); return new Response(JSON.stringify({ submissions: [], draftTimeline: [] })); }));
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={done} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    await userEvent.click(screen.getByRole('button', { name: action === 'run' ? 'Run tests' : 'Submit' }));
    expect(fetch).toHaveBeenCalledWith(`/api/sandboxes/sandbox/${action}`, expect.objectContaining({ body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }));
    await screen.findByText(message, { selector: '.code-runner-live' }); await userEvent.click(screen.getByRole('radio', { name: /Results/ }));
    expect(within(screen.getByRole('region', { name: 'Results' })).getByText(message)).toBeVisible(); expect(done).not.toHaveBeenCalled();
  });
  it('submits successfully without fetching history for an active workspace', async () => {
    const done = vi.fn(); const fetchMock = vi.fn(async (input: string | URL | Request) => { const url = String(input); if (url.endsWith('/submit')) return new Response(JSON.stringify(result)); if (url.endsWith('/hints')) return new Response(JSON.stringify({ revealed: [] })); if (url.includes('/course-hints/')) return new Response(JSON.stringify({ courseId: 'course', drills: {} })); throw new Error(`Unexpected request: ${url}`); }); vi.stubGlobal('fetch', fetchMock);
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={done} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByText('Submitted. All tests passed and the drill is done.'); expect(done).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/submissions'))).toBe(false);
  });
  it('reports a completed submission loading failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => { const url = String(input); if (url.endsWith('/submissions')) return new Response(JSON.stringify({ error: 'Result unavailable' }), { status: 503 }); if (url.endsWith('/hints')) return new Response(JSON.stringify({ revealed: [] })); return new Response(JSON.stringify({ courseId: 'course', drills: {} })); }));
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {}, completed: true }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    expect(await screen.findByText('Result unavailable')).toBeVisible();
  });
  it('does not execute forwarded run or submit hotkeys while controls are disabled', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {}, completed: true, controlsDisabled: true }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    act(() => { window.dispatchEvent(new CustomEvent(SANDBOX_HOTKEY_EVENT, { detail: { id: 'runner.runTests' } })); window.dispatchEvent(new CustomEvent(SANDBOX_HOTKEY_EVENT, { detail: { id: 'runner.submit' } })); });
    expect(fetchMock.mock.calls.some(([url]) => /\/sandboxes\/sandbox\/(run|submit)$/.test(String(url)))).toBe(false);
  });
  it('keeps the submission result and points to Git history after submit', async () => {
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="## Milestone 1\nDo it" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {}, aiCoding: true, completed: true, controlsDisabled: true }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    expect(await screen.findByText('Attempt submitted')).toBeInTheDocument();
    expect(screen.getByText('Interview mode').closest('.mantine-Switch-root')).toHaveStyle({ minHeight: '44px' });
    expect(document.querySelector('.question-pane')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Run tests' })).toHaveStyle({ minHeight: 'calc(2.75rem * var(--mantine-scale))' });
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveStyle({ minHeight: 'calc(2.75rem * var(--mantine-scale))' });
    const toolbar = screen.getByRole('region', { name: 'Sandbox editor workspace' }).querySelector<HTMLElement>('.workspace-toolbar')!; expect(toolbar.style.getPropertyValue('--group-wrap')).toBe('wrap'); expect(toolbar.querySelector<HTMLElement>('.mantine-Group-root')!.style.getPropertyValue('--group-wrap')).toBe('wrap');
    expect(screen.queryByRole('radio', { name: 'History' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Results/ }));
    expect(await screen.findByText('Submitted result')).toBeVisible(); expect(within(screen.getByRole('region', { name: 'Results' })).getByText('works')).toBeVisible();
  });
  it('fully hides and inerts inactive compact panes without remounting the editor iframe', async () => {
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="## Milestone 1\nDo it" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} questionControls={<button>Question control</button>} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const iframe = screen.getByTitle('Sandbox editor'); const editorWrapper = screen.getByRole('region', { name: 'Sandbox editor workspace' }).parentElement!; expect(editorWrapper.hidden).toBe(false); expect(editorWrapper).not.toHaveAttribute('inert');
    await userEvent.click(screen.getByRole('radio', { name: 'Question' })); const questionRegion = screen.getByRole('region', { name: 'Question' }); expect(within(questionRegion).getByRole('button', { name: 'Question control' })).toBeVisible(); expect(Array.from(document.querySelectorAll('style')).some((style) => style.textContent?.includes('container:question-pane/inline-size'))).toBe(true); const questionWrapper = questionRegion.parentElement!; expect(questionWrapper.hidden).toBe(false); expect(questionWrapper).not.toHaveAttribute('inert'); expect(editorWrapper.hidden).toBe(true); expect(editorWrapper).toHaveAttribute('inert'); expect(screen.getByTitle('Sandbox editor')).toBe(iframe);
    await userEvent.click(screen.getByRole('radio', { name: 'Editor' })); expect(screen.getByTitle('Sandbox editor')).toBe(iframe); expect(editorWrapper.hidden).toBe(false); expect(editorWrapper).not.toHaveAttribute('inert'); expect(questionWrapper.hidden).toBe(true); expect(questionWrapper).toHaveAttribute('inert');
  });
  it('preserves the iframe across compact and wide layouts', async () => {
    let width = 1000; let resize: ResizeObserverCallback = () => {}; const originalObserver = globalThis.ResizeObserver;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON: () => ({}) }) as DOMRect);
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} unobserve() {} disconnect() {} });
    const view = render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const iframe = screen.getByTitle('Sandbox editor'); const loads = vi.fn(); iframe.addEventListener('load', loads); fireEvent.load(iframe);
    for (const next of [1300, 1000]) { width = next; act(() => resize([], {} as ResizeObserver)); expect(screen.getByTitle('Sandbox editor')).toBe(iframe); expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument(); expect(screen.queryByRole('radio', { name: 'History' })).not.toBeInTheDocument(); }
    expect(loads).toHaveBeenCalledTimes(1); view.unmount(); bounds.mockRestore(); vi.stubGlobal('ResizeObserver', originalObserver);
  });
  it('constrains the results scroller in the wide layout and keeps its controls sticky', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1300, bottom: 800, width: 1300, height: 800, toJSON: () => ({}) } as DOMRect);
    const watcherResult = { status: 'passed', updatedAt: '2026-01-01', tests: Array.from({ length: 35 }, (_, index) => ({ name: `case ${index + 1}`, status: 'passed' })) };
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" watcherResult={watcherResult} runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const results = screen.getByRole('region', { name: 'Results' });
    expect(await within(results).findByText('case 35')).toBeInTheDocument();
    expect(results).toHaveStyle({ height: '100%', minHeight: '0', overflow: 'auto' });
    expect(results.parentElement).toHaveStyle({ minHeight: '0' });
    expect(within(results).getByRole('heading', { name: 'Results' }).parentElement?.parentElement).toHaveStyle({ position: 'sticky', top: '0' });
    expect(within(results).getByRole('button', { name: 'Toggle Test results' })).toHaveAttribute('aria-expanded', 'true');
    bounds.mockRestore();
  });
  it('discards hidden collapse measurements when switching to compact results', async () => {
    let width = 1300; let resize: ResizeObserverCallback = () => {}; const originalObserver = globalThis.ResizeObserver;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON: () => ({}) }) as DOMRect);
    vi.stubGlobal('ResizeObserver', class { callback: ResizeObserverCallback; constructor(callback: ResizeObserverCallback) { this.callback = callback; } observe(element: Element) { if (element.getAttribute('aria-label') === 'Code practice workspace') resize = this.callback; } unobserve() {} disconnect() {} });
    const watcherResult = { status: 'passed', updatedAt: '2026-01-01', tests: Array.from({ length: 35 }, (_, index) => ({ name: `case ${index + 1}`, status: 'passed' })), output: { entries: [{ stream: 'stdout' as const, text: 'console output' }] } };
    const workspace = (collapsed: boolean) => <MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" watcherResult={watcherResult} runnerCollapsed={collapsed} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>;
    const view = render(workspace(false)); const iframe = screen.getByTitle('Sandbox editor');
    await screen.findByText('case 35'); view.rerender(workspace(true));
    width = 390; act(() => resize([], {} as ResizeObserver)); await userEvent.click(screen.getByRole('radio', { name: /Results/ }));
    const results = screen.getByRole('region', { name: 'Results' }); const list = within(results).getByLabelText('Test list'); const output = within(results).getByLabelText('Console output');
    expect(list.parentElement?.parentElement?.style.height).toBe(''); expect(list.parentElement?.parentElement).not.toHaveAttribute('aria-hidden');
    expect(output.parentElement?.style.height).toBe(''); expect(output.parentElement).not.toHaveAttribute('aria-hidden'); expect(within(results).getByText('case 35')).toBeVisible(); expect(screen.getByTitle('Sandbox editor', { hidden: true })).toBe(iframe);
    width = 1300; act(() => resize([], {} as ResizeObserver)); expect(screen.getByRole('button', { name: 'Toggle Test results' })).toHaveAttribute('aria-expanded', 'false'); expect(screen.getByTitle('Sandbox editor')).toBe(iframe);
    view.unmount(); bounds.mockRestore(); vi.stubGlobal('ResizeObserver', originalObserver);
  });
  it('uses accessible 44px icon controls in a narrow editor toolbar', () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 800, width: 320, height: 800, toJSON: () => ({}) } as DOMRect);
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    expect(screen.getByRole('switch', { name: 'Interview mode' })).toBeVisible(); expect(screen.getByRole('button', { name: 'Run tests' })).toHaveStyle({ '--ai-size': 'calc(2.75rem * var(--mantine-scale))' }); expect(screen.getByRole('button', { name: 'Submit' })).toHaveStyle({ '--ai-size': 'calc(2.75rem * var(--mantine-scale))' }); bounds.mockRestore();
  });
  it('identifies review in the editor and keeps review controls in the Question tab', async () => {
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} questionControls={<button>Close submitted workspace</button>} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {}, completed: true, review: true, controlsDisabled: true }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    expect(screen.getByText('Read-only workspace')).toBeVisible(); await userEvent.click(screen.getByRole('radio', { name: 'Question' })); expect(within(screen.getByRole('region', { name: 'Question' })).getByRole('button', { name: 'Close submitted workspace' })).toBeVisible();
  });
  it('distinguishes specification links without relying on color', async () => {
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="## Milestone 1\nRead [the source](https://example.test)." estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={() => {}} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    await userEvent.click(screen.getByRole('radio', { name: 'Question' }));
    expect(screen.getByRole('link', { name: 'the source' })).toHaveAttribute('data-underline', 'always');
  });
  it('resizes the question/editor split by pointer and keyboard while shielding the iframe', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1300, bottom: 800, width: 1300, height: 800, toJSON: () => ({}) } as DOMRect);
    const onChange = vi.fn();
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxWorkspaceShell courseId="course" drillId="drill" sourcePath="src/index.ts" instructions="Question" estMinutes={30} colorScheme="light" runnerCollapsed={false} onToggleRunner={() => {}} editorPercent={65} onEditorPercentChange={onChange} onSubmitPassed={() => {}} sandbox={{ id: 'sandbox', url: '/sandbox/sandbox/', onRetry: () => {} }} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const separator = await screen.findByRole('separator', { name: 'Resize question and editor' }); expect(separator).toHaveAttribute('aria-valuemin', '45'); expect(separator).toHaveAttribute('aria-valuemax', '80'); expect(separator).toHaveAttribute('aria-valuenow', '65'); expect(screen.getByTestId('coding-workspace-columns').style.getPropertyValue('--ir-split-first')).toBe('35fr'); expect(screen.getByTestId('coding-workspace-columns').style.getPropertyValue('--ir-split-second')).toBe('65fr');
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 845 }); expect(screen.getByTestId('workspace-resize-overlay')).toBeInTheDocument(); expect(screen.getByTitle('Sandbox editor').closest('[data-resizing=true]')).toBeTruthy();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 520 }); expect(onChange).toHaveBeenLastCalledWith(expect.closeTo(60.08, 2)); fireEvent.pointerUp(window, { pointerId: 1 }); expect(screen.queryByTestId('workspace-resize-overlay')).not.toBeInTheDocument();
    fireEvent.pointerDown(separator, { pointerId: 2, clientX: 845 }); expect(screen.getByTestId('workspace-resize-overlay')).toBeInTheDocument(); fireEvent.lostPointerCapture(separator, { pointerId: 2 }); expect(screen.queryByTestId('workspace-resize-overlay')).not.toBeInTheDocument();
    fireEvent.keyDown(separator, { key: 'ArrowLeft' }); expect(onChange).toHaveBeenLastCalledWith(67); fireEvent.keyDown(separator, { key: 'End' }); expect(onChange).toHaveBeenLastCalledWith(80); fireEvent.doubleClick(separator); expect(onChange).toHaveBeenLastCalledWith(65); bounds.mockRestore();
  });
});
