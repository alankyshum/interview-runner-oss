import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OutlineNodeRow } from './OutlineNodeRow';

describe('outline images', () => {
  it('links an image to its full-size source without toggling its node', () => {
    const onFold = vi.fn();
    render(<MantineProvider><OutlineNodeRow node={{ id: 'one', type: 'framework', text: 'Stages', image: { src: '/images/course/stages.png', alt: 'Interview stages' }, children: [{ id: 'two', type: 'claim', text: 'Details' }] }} depth={0} folded checked={false} onFold={onFold} onCheck={() => {}} state={{}} /></MantineProvider>);
    const image = screen.getByRole('img', { name: 'Interview stages' });
    const link = screen.getByRole('link', { name: 'Open image: Interview stages (opens in a new tab)' });
    expect(link).toContainElement(image); expect(link).toHaveAttribute('href', expect.stringMatching(/\/images\/course\/stages\.png$/));
    expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(link); expect(onFold).not.toHaveBeenCalled();
  });
  it('does not turn a non-HTTP image source into an executable link', () => {
    render(<MantineProvider><OutlineNodeRow node={{ id: 'one', type: 'claim', text: 'Unsafe', image: { src: 'javascript:alert(1)', alt: 'Unsafe image' } }} depth={0} folded={false} checked={false} onFold={() => {}} onCheck={() => {}} state={{}} /></MantineProvider>);
    expect(screen.queryByRole('link', { name: /Unsafe image/ })).not.toBeInTheDocument();
  });
});
