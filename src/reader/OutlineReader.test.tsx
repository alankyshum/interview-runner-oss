import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Outline } from '../../server/outlines';
import { OutlineReader } from './OutlineReader';

vi.mock('./OutlineDiagram', () => ({
  OutlineDiagram: ({ node }: { node: { diagram?: { caption?: string } } }) => (
    <div data-testid="outline-diagram">{node.diagram?.caption}</div>
  ),
}));

const outline: Outline = {
  courseId: 'book',
  drillId: 'chapter',
  title: 'Chapter',
  nodes: [
    {
      id: 'section',
      type: 'claim',
      text: 'Section',
      children: [
        {
          id: 'leaf-a',
          type: 'term',
          text: 'Leaf A',
          term: {
            en: 'Leaf A EN',
            zh: '葉子 A',
            definition: 'A bilingual concept definition.',
            useWhen: 'When testing bilingual rendering.',
          },
        },
        { id: 'leaf-b', type: 'step', text: 'Leaf B' },
      ],
    },
  ],
};

describe('OutlineReader', () => {
  it('renders a leaf diagram without a fold control', () => {
    const leafDiagramOutline: Outline = {
      ...outline,
      nodes: [{
        id: 'leaf-diagram',
        type: 'claim',
        text: 'Leaf diagram',
        diagram: { lang: 'mermaid', src: 'flowchart LR\n A-->B', caption: 'Leaf diagram caption' },
      }],
    };

    render(
      <MantineProvider>
        <OutlineReader outline={leafDiagramOutline} />
      </MantineProvider>,
    );

    expect(screen.getByTestId('outline-diagram')).toHaveTextContent('Leaf diagram caption');
    expect(screen.queryByRole('button', { name: 'Leaf diagram' })).not.toBeInTheDocument();
  });

  it('renders external practice links as accessible links outside the fold control', () => {
    const practiceOutline: Outline = {
      ...outline,
      nodes: [{
        id: 'attempt-prompt',
        type: 'question',
        text: 'Try the problem first.',
        link: { href: 'https://neetcode.io/problems/two-integer-sum/question', label: 'Practice on NeetCode' },
        children: [{ id: 'reveal', type: 'claim', text: 'Reveal' }],
      }],
    };

    render(
      <MantineProvider>
        <OutlineReader outline={practiceOutline} />
      </MantineProvider>,
    );

    const link = screen.getByRole('link', { name: 'Practice on NeetCode' });
    expect(link).toHaveAttribute('href', 'https://neetcode.io/problems/two-integer-sum/question');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText('Reveal')).not.toBeInTheDocument();
  });

  it('folds all nodes by default, unfolds one level, and checks leaves', async () => {
    localStorage.clear();
    render(
      <MantineProvider>
        <OutlineReader outline={outline} />
      </MantineProvider>,
    );
    expect(screen.queryByText('Leaf A')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Section'));
    expect(screen.getByText('Leaf A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Leaf A' }));
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('renders bilingual term content when a term node is unfolded', async () => {
    render(
      <MantineProvider>
        <OutlineReader outline={outline} />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByText('Section'));
    expect(screen.getByText('葉子 A')).toBeInTheDocument();
    expect(screen.getByText('A bilingual concept definition.')).toBeInTheDocument();
    expect(screen.getByText(/When testing bilingual rendering\./)).toBeInTheDocument();
  });

  it('renders skeleton loading state when loading is true', () => {
    render(
      <MantineProvider>
        <OutlineReader outline={null} loading={true} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('reader-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading course outline');
    expect(screen.getByRole('status').parentElement).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('reader-skeleton')).toHaveAttribute('aria-hidden', 'true');
  });

  it('unmounts children completely when folded back (conditional rendering, not Collapse)', async () => {
    render(
      <MantineProvider>
        <OutlineReader outline={outline} />
      </MantineProvider>,
    );
    // Unfold
    fireEvent.click(screen.getByText('Section'));
    expect(screen.getByText('Leaf A')).toBeInTheDocument();
    // Fold again
    fireEvent.click(screen.getByText('Section'));
    expect(screen.queryByText('Leaf A')).not.toBeInTheDocument();
  });
});
