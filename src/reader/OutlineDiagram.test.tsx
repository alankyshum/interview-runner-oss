import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDiagramCache, OutlineDiagram } from './OutlineDiagram';

const renderMermaid = vi.fn(async (id: string, source: string) => ({ svg: `<svg id="${id}-svg" aria-label="${source}"><defs><marker id="${id}-marker" /></defs></svg>` }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderMermaid } }));

let intersection: (entries: Array<{ isIntersecting: boolean }>) => void;
beforeEach(() => {
  clearDiagramCache();
  renderMermaid.mockClear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersection) { intersection = callback; }
    observe() {}
    disconnect() {}
  });
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  }
});
afterEach(() => cleanup());

const node = { id: 'diagram-node', hash: 'diagram-v1', type: 'claim' as const, text: 'Diagram section', diagram: { lang: 'mermaid' as const, src: 'flowchart LR\n A-->B', caption: 'Healthy diagram' } };

describe('OutlineDiagram', () => {
  it('does not load or render until the node is intersecting, then caches across folding', async () => {
    const view = render(<MantineProvider><OutlineDiagram node={node} /></MantineProvider>);
    expect(renderMermaid).not.toHaveBeenCalled();
    await waitFor(() => expect(intersection).toBeTypeOf('function'));
    await act(async () => intersection([{ isIntersecting: true }]));
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));
    view.unmount();
    render(<MantineProvider><OutlineDiagram node={node} /></MantineProvider>);
    await waitFor(() => expect(intersection).toBeTypeOf('function'));
    await act(async () => intersection([{ isIntersecting: true }]));
    expect(renderMermaid).toHaveBeenCalledTimes(1);
  });

  it('shows raw source when Mermaid rejects a deliberately broken fixture', async () => {
    renderMermaid.mockRejectedValueOnce(new Error('invalid syntax'));
    const broken = { ...node, hash: 'broken-v1', diagram: { lang: 'mermaid' as const, src: 'not valid mermaid' } };
    render(<MantineProvider><OutlineDiagram node={broken} /></MantineProvider>);
    await waitFor(() => expect(intersection).toBeTypeOf('function'));
    await act(async () => intersection([{ isIntersecting: true }]));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid mermaid');
  });

  async function renderDiagram() {
    render(<MantineProvider><OutlineDiagram node={node} /></MantineProvider>);
    await waitFor(() => expect(intersection).toBeTypeOf('function'));
    await act(async () => intersection([{ isIntersecting: true }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Expand diagram: Healthy diagram' })).toBeInTheDocument());
  }

  it('opens a labelled centered dialog from click and closes with its button', async () => {
    await renderDiagram();
    const trigger = screen.getByRole('button', { name: 'Expand diagram: Healthy diagram' });
    expect(trigger).not.toHaveTextContent('Expand');
    expect(trigger).toHaveAttribute('title', 'Expand diagram');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Healthy diagram' });
    expect(dialog.className).toMatch(/diagramDialog/);
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.querySelector('svg')).toBeInTheDocument();
    const closeButton = screen.getByRole('button', { name: 'Close expanded diagram' });
    expect(closeButton).toHaveTextContent('×');
    fireEvent.click(closeButton);
    expect(dialog).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the mounted dialog closed and hidden until opened, then hides it again', async () => {
    await renderDiagram();
    const trigger = screen.getByRole('button', { name: 'Expand diagram: Healthy diagram' });
    const dialog = document.querySelector('dialog')!;

    // JSDOM does not apply the native dialog stylesheet, so use open/content
    // semantics rather than computed layout to verify the closed state.
    expect(dialog).not.toHaveAttribute('open');
    expect(dialog.className).toMatch(/diagramDialog/);
    expect(dialog.querySelector('svg')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(dialog).toHaveAttribute('open');
    expect(dialog.querySelector('svg')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close expanded diagram' }));
    expect(dialog).not.toHaveAttribute('open');
    expect(dialog.querySelector('svg')).not.toBeInTheDocument();
  });

  it('supports native keyboard activation, coordinate-based backdrop close, and cancel', async () => {
    await renderDiagram();
    const trigger = screen.getByRole('button', { name: 'Expand diagram: Healthy diagram' });
    const user = userEvent.setup();
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('open');
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 500, top: 100, bottom: 400, width: 400, height: 300, x: 100, y: 100, toJSON: () => ({}) });
    fireEvent.click(dialog, { clientX: 110, clientY: 110 });
    expect(dialog).toHaveAttribute('open');
    fireEvent.click(dialog, { clientX: 50, clientY: 200 });
    expect(dialog).not.toHaveAttribute('open');
    await user.click(trigger);
    expect(dialog).toHaveAttribute('open');
    dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }));
    expect(dialog).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(trigger);
  });

  it('falls back to an accessible label when there is no caption', async () => {
    const uncaptioned = { ...node, hash: 'no-caption', diagram: { ...node.diagram!, caption: undefined } };
    render(<MantineProvider><OutlineDiagram node={uncaptioned} /></MantineProvider>);
    await waitFor(() => expect(intersection).toBeTypeOf('function'));
    await act(async () => intersection([{ isIntersecting: true }]));
    expect(await screen.findByRole('button', { name: 'Expand diagram' })).toHaveAttribute('title', 'Expand diagram');
  });

  it('renders modal content only while open and keeps SVG IDs isolated to one copy', async () => {
    await renderDiagram();
    const trigger = screen.getByRole('button', { name: 'Expand diagram: Healthy diagram' });
    const dialog = document.querySelector('dialog')!;
    expect(dialog.querySelector('svg')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[id$="-marker"]').length).toBe(1);
    fireEvent.click(trigger);
    expect(dialog).toHaveAttribute('open');
    expect(dialog.querySelector('svg')).toBeInTheDocument();
    expect(document.querySelectorAll('[id$="-marker"]').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close expanded diagram' }));
    expect(dialog.querySelector('svg')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[id$="-marker"]').length).toBe(1);
  });
});
