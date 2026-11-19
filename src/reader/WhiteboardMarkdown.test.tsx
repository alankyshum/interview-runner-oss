import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhiteboardMarkdown } from './WhiteboardMarkdown';
import { clearDiagramCache } from './OutlineDiagram';

const renderMermaid = vi.fn(async (id: string, source: string) => {
  if (source === 'bad mermaid') throw new Error('invalid syntax');
  return { svg: `<svg id="${id}" role="graphics-document" aria-label="diagram"></svg>` };
});
const initialize = vi.fn();
vi.mock('mermaid', () => ({ default: { initialize, render: renderMermaid } }));

beforeEach(() => {
  clearDiagramCache(); renderMermaid.mockClear(); initialize.mockClear();
  vi.stubGlobal('IntersectionObserver', class {
    callback: (entries: Array<{ isIntersecting: boolean }>) => void;
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { this.callback = callback; }
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders Mermaid in prompt, hint and answer while retaining accessible source and ordinary text diagrams', async () => {
  const block = (label: string) => `${label}\n\n\`\`\`mermaid\nflowchart TD\n A-->${label}\n\`\`\``;
  render(<MantineProvider><WhiteboardMarkdown source={block('Prompt')} /></MantineProvider>);
  await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));
  render(<MantineProvider><WhiteboardMarkdown source={block('Hint')} /></MantineProvider>);
  await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
  render(<MantineProvider><WhiteboardMarkdown source={`${block('Answer')}\n\n\`\`\`text\n[A] -> [B]\n\`\`\``} /></MantineProvider>);
  await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(3));
  expect(screen.getAllByRole('button', { name: 'Expand diagram' })).toHaveLength(3);
  expect(screen.getAllByText('Diagram source / text alternative')).toHaveLength(3);
  expect(screen.getByText('[A] -> [B]')).toBeInTheDocument();
});

it('shows invalid Mermaid as readable source instead of crashing', async () => {
  render(<MantineProvider><WhiteboardMarkdown source={'```mermaid\nbad mermaid\n```'} /></MantineProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('bad mermaid');
  expect(screen.getByText('Diagram source / text alternative')).toBeInTheDocument();
});

it('uses the active theme for the shared Mermaid renderer', async () => {
  const view = render(<MantineProvider forceColorScheme="dark"><WhiteboardMarkdown source={'```mermaid\nflowchart TD\n A-->B\n```'} /></MantineProvider>);
  await waitFor(() => expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })));
  view.rerender(<MantineProvider forceColorScheme="light"><WhiteboardMarkdown source={'```mermaid\nflowchart TD\n A-->B\n```'} /></MantineProvider>);
  await waitFor(() => expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'default' })));
});
