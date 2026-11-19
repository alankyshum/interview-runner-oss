import { MantineProvider, Menu } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Button, IconButton, Panel, PanelHeader, SaveStatus, SplitPane, StatusBadge, TimerDisplay } from './index';
import DesignSystemGallery from './DesignSystemGallery';
import { readFileSync } from 'node:fs';

afterEach(cleanup);
const renderUI = (node: React.ReactNode) => render(<MantineProvider>{node}</MantineProvider>);

describe('shared UI', () => {
  it('passes button attributes, refs and accessible icon labels to the actual button', () => {
    const ref = vi.fn();
    renderUI(<><Button ref={ref} variant="danger" disabled>Delete</Button><IconButton label="Open options" icon={<span aria-hidden="true">⋯</span>} aria-expanded={false} aria-controls="options" /></>);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(ref).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Open options' })).toHaveAttribute('aria-controls', 'options');
  });

  it('works as a Mantine menu target without nested buttons', async () => {
    renderUI(<Menu transitionProps={{ duration: 0 }}><Menu.Target><IconButton label="Open options" icon={<span>⋯</span>} /></Menu.Target><Menu.Dropdown><Menu.Item>Retry</Menu.Item></Menu.Dropdown></Menu>);
    const target = screen.getByRole('button', { name: 'Open options' });
    expect(target.querySelector('button')).toBeNull();
    fireEvent.click(target);
    expect(await screen.findByRole('menuitem', { name: 'Retry' })).toBeVisible();
  });

  it('offers the filled accent action in the shared gallery', () => {
    const css = readFileSync('src/ui/components.css', 'utf8');
    expect(css).toContain(".ir-button[data-ir-variant='accent'] { background: var(--ir-color-primary-hover); border-color: transparent; color: var(--ir-color-primary-text); }");
    expect(css).toContain(".ir-button[data-ir-variant='accent']:not(:disabled):hover { background: var(--ir-color-primary); }");
    renderUI(<DesignSystemGallery />);
    const row = screen.getByText('accent').parentElement!;
    expect(row.querySelectorAll("button[data-ir-variant='accent']")).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'accent options' })).toHaveAttribute('data-ir-variant', 'accent');
  });

  it('suppresses an icon tooltip while its related overlay is open', async () => {
    const view = renderUI(<IconButton label="Settings" icon={<span>⋯</span>} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('tooltip', { name: 'Settings' })).toBeVisible();
    view.rerender(<MantineProvider><IconButton label="Settings" tooltipDisabled icon={<span>⋯</span>} /></MantineProvider>);
    await waitFor(() => expect(screen.queryByRole('tooltip', { name: 'Settings' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Settings' })).toBeEnabled();
  });

  it('documents shared light and dark overlay elevation in the gallery', async () => {
    const css = readFileSync('src/ui/tokens.css', 'utf8');
    expect(css).toContain('--ir-shadow-overlay: 0 0 0 1px var(--ir-color-border), var(--mantine-shadow-md)');
    expect(css).toContain('--ir-shadow-overlay: 0 0 0 1px var(--ir-color-border), var(--mantine-shadow-lg)');
    expect(css).toContain('.mantine-Popover-dropdown, .mantine-Menu-dropdown { box-shadow: var(--ir-shadow-overlay); }');
    renderUI(<DesignSystemGallery />);
    fireEvent.click(screen.getByRole('button', { name: 'Open popover' }));
    await waitFor(() => expect(screen.getByText('Elevated popover surface')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Menu action' })).toBeVisible());
  });

  it('labels panels, toggle state and polite recovery status', () => {
    const toggle = vi.fn();
    renderUI(<Panel label="Results"><PanelHeader title="Results" toggle={{ expanded: true, onToggle: toggle, controlsId: 'results-body' }} /><StatusBadge tone="success">Passed</StatusBadge><SaveStatus state="conflict" text="Newer version exists" actions={<Button variant="secondary">Keep mine</Button>} /></Panel>);
    expect(screen.getByRole('region', { name: 'Results' })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Toggle Results' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button); expect(toggle).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Newer version exists');
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeEnabled();
  });

  it('makes a scrollable panel keyboard-focusable by default', () => {
    renderUI(<Panel label="Scrollable notes" scrollable>Notes</Panel>);
    expect(screen.getByRole('region', { name: 'Scrollable notes' })).toHaveAttribute('tabindex', '0');
  });

  it('keeps the gallery question scrollable and restores its usable split', () => {
    renderUI(<DesignSystemGallery />);
    const question = screen.getByRole('region', { name: 'Question' });
    const divider = screen.getByRole('separator', { name: 'Resize question and editor' });
    expect(question).toHaveAttribute('data-ir-scrollable', 'true');
    expect(question).toHaveAttribute('tabindex', '0');
    expect(divider).toHaveAttribute('aria-valuenow', '65');
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider).toHaveAttribute('aria-valuenow', '20');
    fireEvent.doubleClick(divider);
    expect(divider).toHaveAttribute('aria-valuenow', '65');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Question' }));
    expect(question.querySelector('#gallery-question')).not.toBeVisible();
  });

  it('resizes with keyboard and reset without remounting pane contents', () => {
    const unmount = vi.fn();
    function Stateful() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}>Count {count}</button>; }
    function Example() { const [value, setValue] = useState(40); return <SplitPane value={value} onChange={setValue} min={20} max={80} resetValue={40} label="Resize panes">{[<Stateful key="first" />, <iframe key="second" title="Editor" onLoad={unmount} />]}</SplitPane>; }
    renderUI(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    const frame = screen.getByTitle('Editor'); const separator = screen.getByRole('separator', { name: 'Resize panes' });
    fireEvent.keyDown(separator, { key: 'End' }); expect(separator).toHaveAttribute('aria-valuenow', '80');
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true }); expect(separator).toHaveAttribute('aria-valuenow', '72');
    fireEvent.doubleClick(separator); expect(separator).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeInTheDocument();
    expect(screen.getByTitle('Editor')).toBe(frame);
  });

  it('resizes vertical panes with up/down keys and identifies the controlled pane', () => {
    function Example() { const [value, setValue] = useState(50); return <SplitPane value={value} onChange={setValue} min={25} max={75} resetValue={50} orientation="vertical" label="Resize editor and results" controlsId="editor">{[<div id="editor" key="editor">Editor</div>, <div key="results">Results</div>]}</SplitPane>; }
    renderUI(<Example />);
    const separator = screen.getByRole('separator', { name: 'Resize editor and results' });
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    expect(separator).toHaveAttribute('aria-controls', 'editor');
    fireEvent.keyDown(separator, { key: 'ArrowDown' }); expect(separator).toHaveAttribute('aria-valuetext', '52%');
    fireEvent.keyDown(separator, { key: 'Home' }); expect(separator).toHaveAttribute('aria-valuenow', '25');
  });

  it.each(['first', 'second'] as const)('maps the divider center to 50% for the %s pane', (valueSide) => {
    const change = vi.fn();
    const view = renderUI(<SplitPane value={50} valueSide={valueSide} onChange={change} min={0} max={100} resetValue={50} label="Resize">{[<div key="first">First</div>, <div key="second">Second</div>]}</SplitPane>);
    const root = view.container.querySelector('.ir-split')!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 0, width: 1000, height: 500 } as DOMRect);
    const separator = screen.getByRole('separator', { name: 'Resize' });
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 600, button: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 600 });
    expect(change).toHaveBeenLastCalledWith(50);
    fireEvent.pointerUp(window, { pointerId: 1 });
  });

  it('keeps both panes mounted when switching between split and explicit tab layouts', () => {
    function Example() { const [visible, setVisible] = useState<'first' | 'second' | undefined>(); return <><button onClick={() => setVisible(visible === 'second' ? undefined : 'second')}>Change layout</button><SplitPane value={65} valueSide="second" onChange={() => {}} min={45} max={80} resetValue={65} visiblePane={visible} label="Resize">{[<div key="first">Question</div>, <iframe key="second" title="Stable editor" />]}</SplitPane></>; }
    renderUI(<Example />); const editor = screen.getByTitle('Stable editor');
    fireEvent.click(screen.getByRole('button', { name: 'Change layout' })); expect(screen.getByTitle('Stable editor')).toBe(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Change layout' })); expect(screen.getByTitle('Stable editor')).toBe(editor);
  });

  it('announces timer milestones, not each tick', () => {
    const view = renderUI(<TimerDisplay remaining={301000} state="running" label="Time remaining" />);
    const live = screen.getByRole('status'); expect(live).toHaveTextContent('');
    view.rerender(<MantineProvider><TimerDisplay remaining={300000} state="running" label="Time remaining" /></MantineProvider>);
    expect(live).toHaveTextContent('Finishing soon');
    view.rerender(<MantineProvider><TimerDisplay remaining={299000} state="running" label="Time remaining" /></MantineProvider>);
    expect(live).toHaveTextContent('Finishing soon');
    view.rerender(<MantineProvider><TimerDisplay remaining={0} state="expired" label="Time remaining" /></MantineProvider>);
    expect(live).toHaveTextContent("Time's up");
  });
  it('uses the owner-provided announcement without duplicating timer state messages', () => {
    const view = renderUI(<TimerDisplay remaining={600000} state="running" label="Time remaining" announcement="Timer started" />);
    view.rerender(<MantineProvider><TimerDisplay remaining={590000} state="paused" label="Time remaining" announcement="Timer paused at 09:50" /></MantineProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Timer paused at 09:50');
  });
});
