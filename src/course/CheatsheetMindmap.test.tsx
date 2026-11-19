import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheatsheetMindmap } from './CheatsheetMindmap';
import { MAP_MAX_WIDTH } from '../reader/mapWidth';

const calls = vi.hoisted(() => ({ init: vi.fn(), setData: vi.fn(async () => {}), fit: vi.fn(async () => {}), destroy: vi.fn(), on: vi.fn(), rescale: vi.fn(async () => {}) }));
vi.mock('markmap-view', () => ({ Markmap: class {
  constructor(_svg: SVGSVGElement, options: unknown) { calls.init(options); }
  svg = { on: calls.on }; setData = calls.setData; fit = calls.fit; destroy = calls.destroy; rescale = calls.rescale; toggleNode = vi.fn(async () => {});
} }));

describe('cheatsheet mind map hero', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Root\n- Branch', { status: 200 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  const setup = () => render(<MantineProvider><CheatsheetMindmap courseId="sheet" title="Overview" path="cheatsheets/sheet/diagrams/mindmaps/overview.md" /></MantineProvider>);
  it('disables preview zoom and opens a dialog with icon controls', async () => {
    const user = userEvent.setup(); setup();
    const card = await screen.findByRole('button', { name: 'Open Overview mind map' });
    await waitFor(() => expect(calls.setData).toHaveBeenCalled());
    expect(calls.init).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: MAP_MAX_WIDTH, autoFit: false }));
    expect(calls.on).toHaveBeenCalledWith('.zoom', null);
    fireEvent.wheel(card, { deltaY: 100 }); fireEvent.pointerDown(card); fireEvent.pointerMove(card);
    expect(calls.rescale).not.toHaveBeenCalled();
    await user.click(card);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(calls.init).toHaveBeenCalledTimes(2));
    expect(calls.init).toHaveBeenLastCalledWith(expect.objectContaining({ maxWidth: 600, autoFit: false }));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveAttribute('title', 'Zoom in');
    await user.click(screen.getByRole('button', { name: 'Zoom in' })); expect(calls.rescale).toHaveBeenCalledWith(1.25);
    await user.click(screen.getByRole('button', { name: 'Close mind map' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(card).toHaveFocus());
  });
  it('opens by keyboard and closes on Escape with focus restored', async () => {
    const user = userEvent.setup(); setup();
    const card = await screen.findByRole('button', { name: 'Open Overview mind map' }); card.focus();
    await user.keyboard('{Enter}'); expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(card).toHaveFocus());
  });
});
