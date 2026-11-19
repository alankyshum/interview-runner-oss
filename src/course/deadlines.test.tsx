import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DeadlineCalendar from './DeadlineCalendar';
import { compactDeadline, DeadlineLine } from './DeadlineLine';
import { absoluteDeadline, activeDeadlines, calendarDays, deadlineCopy, deadlineDate, nextDeadline } from './deadlines';
import LibraryPanel, { persistedMoveIndex, sortUpNext, type LibraryItem } from './LibraryPanel';

const item = (id: string, deadline: string, position = 0, repo = 'example/one'): LibraryItem => ({ kind: 'course', id, repo, deadline, title: id, manifestTitle: id, status: 'active', statusExplicit: true, categoryId: 'uncategorized', position, tags: [], doneDrills: 0, totalDrills: 1, remainingMinutes: 0, inProgress: false });
const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute);

describe('deadlines', () => {
  it('renders compact local sidebar pills while preserving full tooltips and heading copy', () => {
    const now = local(2026, 11, 2, 10), future = local(2026, 11, 12, 10).toISOString();
    const { container, rerender } = render(<DeadlineLine value={future} active now={now} />);
    const pill = () => container.querySelector('.deadline-pill')!;
    const suffix = () => container.querySelector('.deadline-row-relative');
    expect(pill()).toHaveTextContent('Thu 11/12 10:00'); expect(suffix()).toHaveTextContent('in 10d');
    expect(readFileSync(resolve(process.cwd(), 'src/course/DeadlineLine.css'), 'utf8')).toContain('border:1px solid var(--ir-color-control-border)');
    expect(container.querySelector('.deadline-row-line')).toHaveAttribute('title', `${absoluteDeadline(future)} · in 10 days`);
    rerender(<DeadlineLine value={local(2026, 11, 12, 13).toISOString()} active now={now} />);
    expect(pill().textContent).toBe('Thu 11/12 13:00');
    rerender(<DeadlineLine value="2026-11-12" active now={now} />);
    expect(pill()).toHaveTextContent('Thu 11/12'); expect(suffix()).toHaveTextContent('in 10d');
    rerender(<DeadlineLine value="2026-11-02" active now={now} />);
    expect(suffix()).toHaveTextContent('today'); expect(pill()).toHaveAttribute('data-tone', 'soon');
    rerender(<DeadlineLine value="2026-11-03" active now={now} />);
    expect(suffix()).toHaveTextContent('tomorrow'); expect(pill()).toHaveAttribute('data-tone', 'soon');
    rerender(<DeadlineLine value={new Date(now.getTime() + 120 * 60_000).toISOString()} active now={now} />);
    expect(suffix()).toHaveTextContent('in 2h');
    rerender(<DeadlineLine value={new Date(now.getTime() + 30 * 60_000).toISOString()} active now={now} />);
    expect(suffix()).toHaveTextContent('in 30m');
    rerender(<DeadlineLine value="2026-11-01" active now={now} />);
    expect(suffix()).toHaveTextContent('1d overdue'); expect(pill()).toHaveAttribute('data-tone', 'overdue');
    rerender(<DeadlineLine value={new Date(now.getTime() - 120 * 60_000).toISOString()} active now={now} />);
    expect(suffix()).toHaveTextContent('2h overdue');
    rerender(<DeadlineLine value={future} active={false} now={now} />);
    expect(pill()).toHaveTextContent('Thu 11/12 10:00'); expect(suffix()).toBeNull();
    rerender(<DeadlineLine value={future} active now={now} heading />);
    expect(container.querySelector('.deadline-pill')).toBeNull();
    expect(container.querySelector('.deadline-line-heading')).toHaveTextContent(`${absoluteDeadline(future)} · in 10 days`);
  });
  it('uses theme-aware semantic pill colors instead of production-minified light-dark fallbacks', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/course/DeadlineLine.css'), 'utf8');
    const tokens = readFileSync(resolve(process.cwd(), 'src/ui/tokens.css'), 'utf8');
    expect(css).toContain('.metadata-pill{'); expect(css).toContain('background:var(--ir-color-raised);color:var(--ir-color-text)');
    expect(tokens).toContain('--ir-color-raised: var(--mantine-color-gray-1)');
    expect(tokens).toContain('--ir-color-raised: var(--mantine-color-dark-6)');
    for (const rule of css.matchAll(/[^{}]*\.deadline-pill[^{}]*\{([^}]*)\}/g)) expect(rule[1]).not.toContain('light-dark(');
  });
  it('assigns distinct semantic tier roles independently of deadline tones', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/course/DeadlineLine.css'), 'utf8');
    expect(css).toContain('.tier-pill[data-tier="1"]{background:var(--ir-color-info-bg);color:var(--ir-color-info);border-color:var(--ir-color-info)}');
    expect(css).toContain('.tier-pill[data-tier="2"]{background:var(--ir-color-warning-bg);color:var(--ir-color-warning);border-color:var(--ir-color-control-border)}');
    expect(css).toContain('.tier-pill[data-tier="3"]{background:var(--ir-color-raised);color:var(--ir-color-text-secondary)}');
  });
  it('uses calendar fields across DST, month and year boundaries', () => {
    vi.useFakeTimers(); vi.setSystemTime(local(2026, 11, 2));
    const days = calendarDays(new Date());
    expect(days).toHaveLength(28); expect(days.map((date) => `${date.getMonth() + 1}-${date.getDate()}`)).toEqual(Array.from({ length: 28 }, (_, i) => `11-${i + 1}`));
    expect(calendarDays(local(2026, 12, 31)).at(-1)?.getFullYear()).toBe(2027);
    expect(deadlineDate('2026-11-12').getDate()).toBe(12);
    vi.useRealTimers();
  });
  it('formats relative and absolute values, including completed and overdue', () => {
    const now = local(2026, 11, 2, 10);
    expect(deadlineCopy('2026-11-12', now)).toMatchObject({ absolute: 'Thu Nov 12', relative: 'in 10 days' });
    expect(deadlineCopy('2026-11-02', now).relative).toBe('Today');
    expect(deadlineCopy('2026-11-03', now).relative).toBe('Tomorrow');
    expect(deadlineCopy('2026-11-01', now).relative).toBe('1 day overdue');
    expect(deadlineCopy('2026-11-01', now, false).relative).toBe('');
    const instant = new Date('2026-11-12T10:00:00-08:00');
    const localTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(instant);
    expect(absoluteDeadline('2026-11-12T10:00:00-08:00')).toContain(localTime);
    const timed = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
    expect(deadlineCopy(timed(120), now).relative).toBe('in 2 hours');
    expect(deadlineCopy(timed(30), now).relative).toBe('in 30 minutes');
    expect(deadlineCopy(timed(0), now).relative).toBe('Due now');
    expect(deadlineCopy(timed(-30), now).relative).toBe('30 minutes overdue');
    expect(deadlineCopy(timed(-120), now).relative).toBe('2 hours overdue');
    expect(deadlineCopy(local(2026, 11, 1, 23, 30).toISOString(), local(2026, 11, 2, 0, 30)).relative).toBe('1 hour overdue');
  });
  it('sorts deadlines and maps undated moves through hidden persisted rows', () => {
    const dated = item('dated', '2026-11-12', 1), earlier = item('earlier', '2026-11-03', 3), first = { ...item('first', '', 0), deadline: undefined }, second = { ...item('second', '', 4), deadline: undefined };
    const done = { ...item('done', '2026-11-01', 2), status: 'done' as const };
    expect(sortUpNext([first, dated, earlier, second], []).map((x) => x.id)).toEqual(['earlier', 'dated', 'first', 'second']);
    expect(sortUpNext([item('midnight', local(2026, 11, 4).toISOString(), 0), item('prior-day', '2026-11-03', 1)], []).map((x) => x.id)).toEqual(['prior-day', 'midnight']);
    expect(persistedMoveIndex([first, dated, done, earlier, second], second, 'uncategorized', 0)).toBe(0);
    expect(persistedMoveIndex([first, dated, done, earlier, second], first, 'uncategorized', 1)).toBe(4);
    const hidden = { ...item('hidden', '', 1, 'example/two'), deadline: undefined }, last = { ...second, position: 2 };
    expect(persistedMoveIndex([first, hidden, last], first, 'uncategorized', 1)).toBe(2);
  });
  it('selects only active courses from all repositories, including beyond the grid', () => {
    const now = local(2026, 11, 2), one = item('one', '2026-12-30'), two = item('two', '2026-11-03', 1, 'example/two');
    const values = [one, two, { ...item('done', '2026-11-02'), status: 'done' as const }, { ...item('sheet', '2026-11-02'), kind: 'cheatsheet' as const }];
    expect(activeDeadlines(values)).toEqual([one, two]); expect(nextDeadline(values, now)).toEqual(two);
    expect(nextDeadline([one], now)).toEqual(one);
  });
});

describe('deadline calendar', () => {
  it('fits seven non-overlapping day columns within the available sidebar width', () => {
    render(<MantineProvider><DeadlineCalendar items={[]} now={new Date()} onOpen={() => {}} /></MantineProvider>);
    const css = document.querySelector('.deadline-calendar style')?.textContent ?? '';
    expect(css).toContain('.deadline-grid{min-width:0;grid-template-columns:repeat(7,minmax(0,1fr))}');
    expect(css).toContain('.deadline-day{min-width:0}');
  });
  it('keeps the full deadline in the Library row accessible name and tooltip', () => {
    const course = item('Acme priority', '2099-01-03T10:00:00-08:00');
    const snapshot = { categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [course], courseRepos: [] };
    render(<MantineProvider><LibraryPanel snapshot={snapshot} onOpen={() => {}} onChange={() => {}} /></MantineProvider>);
    const copy = deadlineCopy(course.deadline!, new Date()); const full = `${copy.absolute} · ${copy.relative}`;
    const compact = compactDeadline(course.deadline!, true, new Date());
    const row = screen.getByRole('button', { name: `${compact.compact} ${compact.shortRelative} Acme priority 0/1 · 0m left, ${full}, 0 of 1 drills complete, 0 minutes left` });
    expect(within(row).getByTitle(full)).toBeInTheDocument();
    expect(within(row).getByText(/\d{2}\/\d{2} \d{2}:\d{2}/)).toHaveClass('deadline-pill');
  });
  it('shows only the absolute pill for done and archived Library rows', () => {
    const done = { ...item('Acme done', '2099-01-03'), status: 'done' as const };
    const archived = { ...item('Acme archived', '2099-01-03'), status: 'archived' as const };
    const snapshot = { categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [done, archived], courseRepos: [] };
    render(<MantineProvider><LibraryPanel snapshot={snapshot} expanded={{ 'status:done': true, 'status:archived': true }} onOpen={() => {}} onChange={() => {}} /></MantineProvider>);
    for (const course of [done, archived]) {
      const absolute = absoluteDeadline(course.deadline!);
      const compact = compactDeadline(course.deadline!, false, new Date());
      const row = screen.getByRole('button', { name: `${compact.compact} ${course.title} 0/1 · 0m left, ${absolute}, 0 of 1 drills complete, 0 minutes left` });
      expect(within(row).getByTitle(absolute)).toBeInTheDocument();
      expect(row.querySelector('.deadline-pill')).toBeInTheDocument(); expect(row.querySelector('.deadline-row-relative')).toBeNull();
    }
  });
  it('makes the entire populated caption, including Next, a 44px course button', async () => {
    const user = userEvent.setup(); const course = item('Acme upcoming', '2026-11-03'); const open = vi.fn();
    render(<MantineProvider><DeadlineCalendar items={[course]} now={local(2026, 11, 2, 10)} onOpen={open} /></MantineProvider>);
    const button = screen.getByRole('button', { name: /Next:.*Acme upcoming.*Tomorrow/ });
    expect(getComputedStyle(button).minHeight).toBe('44px'); expect(getComputedStyle(button).width).toBe('100%');
    await user.click(within(button).getByText('Next:')); expect(open).toHaveBeenCalledWith(course);
  });
  it('insets and wraps long captions without reserving a bottom strip', async () => {
    const user = userEvent.setup(), open = vi.fn();
    const course = item('A very long upcoming course title with several detailed interview preparation milestones', '2026-11-03');
    const { rerender } = render(<MantineProvider><DeadlineCalendar items={[course]} now={local(2026, 11, 2, 10)} onOpen={open} /></MantineProvider>);
    const button = screen.getByRole('button', { name: /Next:.*very long upcoming course.*Tomorrow/ });
    expect(getComputedStyle(button).whiteSpace).toBe('normal');
    expect(getComputedStyle(button).overflowWrap).toBe('anywhere');
    expect(getComputedStyle(button).minHeight).toBe('44px');
    const css = document.querySelector('.deadline-calendar style')?.textContent ?? '';
    expect(css).toContain('.deadline-caption{padding-inline-start:calc(48px + env(safe-area-inset-left, 0px));height:auto;min-height:44px;white-space:normal}');
    await user.click(button); expect(open).toHaveBeenCalledWith(course);
    rerender(<MantineProvider><DeadlineCalendar items={[]} now={local(2026, 11, 2, 10)} onOpen={open} /></MantineProvider>);
    expect(screen.getByText('No upcoming deadlines')).toHaveClass('deadline-caption');
  });
  it('emphasizes deadline numerals and keeps a larger dot beneath today', () => {
    render(<MantineProvider><DeadlineCalendar items={[item('Acme today', '2026-11-02')]} now={local(2026, 11, 2, 10)} onOpen={() => {}} /></MantineProvider>);
    const today = screen.getByRole('button', { name: /Monday, November 2, 2026, 1 deadline, today/ });
    const numeral = today.querySelector('.deadline-number')!, dot = today.querySelector('.deadline-dot')!;
    expect(getComputedStyle(numeral).fontWeight).toBe('700');
    expect(getComputedStyle(dot).width).toBe('6px'); expect(getComputedStyle(dot).height).toBe('6px');
    const calendar = screen.getByRole('region', { name: 'Deadline calendar' });
    expect(calendar.querySelector('.deadline-month')).toBeNull();
    expect(getComputedStyle(calendar).marginTop).toBe('8px'); expect(getComputedStyle(calendar).paddingTop).toBe('12px');
    expect(getComputedStyle(calendar).paddingBottom).toBe('0px');
    expect(getComputedStyle(calendar.querySelector('.deadline-caption')!).minHeight).toBe('44px');
  });
  it('distinguishes month boundaries, full accessible names and actionable past deadlines', async () => {
    const user = userEvent.setup(), open = vi.fn();
    const overdue = item('Overdue course', '2026-11-29'), a = item('Course A', '2026-12-01'), b = item('Course B', '2026-12-01');
    render(<MantineProvider><DeadlineCalendar items={[overdue, a, b]} now={local(2026, 11, 30, 10)} onOpen={open} /></MantineProvider>);
    expect(screen.getByText('Nov 29–Dec 26, 2026')).toBeInTheDocument();
    const past = screen.getByRole('button', { name: 'Sunday, November 29, 2026, 1 deadline, past, Overdue course' });
    expect(past).not.toHaveAttribute('aria-disabled'); expect(past).toHaveAttribute('data-past');
    expect(getComputedStyle(past.querySelector('.deadline-number')!).textDecoration).not.toContain('line-through');
    await user.click(past); expect(open).toHaveBeenCalledWith(overdue);
    const multi = screen.getByRole('button', { name: 'Tuesday, December 1, 2026, 2 deadlines, Course A, Course B' });
    expect(multi).toHaveAttribute('data-other-month'); expect(multi.querySelector('.deadline-mark')).toHaveTextContent('2');
    const empty = screen.getByRole('button', { name: 'Monday, November 30, 2026, 0 deadlines, today' });
    expect(empty).toHaveAttribute('aria-current', 'date'); expect(empty).toHaveAttribute('aria-disabled', 'true'); expect(empty).not.toHaveAttribute('data-other-month');
    act(() => empty.focus()); await user.keyboard('{ArrowRight}'); expect(multi).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Deadline calendar' }).querySelector('.deadline-weekend')).toBeNull();
  });
  it('shows both years across a boundary and marks today when it is the first', () => {
    const { rerender } = render(<MantineProvider><DeadlineCalendar items={[]} now={local(2026, 12, 31)} onOpen={() => {}} /></MantineProvider>);
    expect(screen.getByText('Dec 27, 2026–Jan 23, 2027')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Friday, January 1, 2027, 0 deadlines' })).toHaveAttribute('data-other-month');
    rerender(<MantineProvider><DeadlineCalendar items={[]} now={local(2026, 12, 1)} onOpen={() => {}} /></MantineProvider>);
    const today = screen.getByRole('button', { name: 'Tuesday, December 1, 2026, 0 deadlines, today' });
    expect(today).toHaveAttribute('aria-current', 'date'); expect(today).not.toHaveAttribute('data-other-month');
    expect(screen.getByRole('button', { name: 'Monday, November 30, 2026, 0 deadlines, past' })).toHaveAttribute('data-other-month');
  });
  it('keeps the today accent when a multiple-deadline day is pinned', async () => {
    const user = userEvent.setup();
    render(<MantineProvider><DeadlineCalendar items={[item('One', '2026-12-01'), item('Two', '2026-12-01')]} now={local(2026, 12, 1)} onOpen={() => {}} /></MantineProvider>);
    const today = screen.getByRole('button', { name: 'Tuesday, December 1, 2026, 2 deadlines, today, One, Two' });
    await user.click(today); expect(today).toHaveAttribute('data-pinned');
    const css = document.querySelector('.deadline-calendar style')?.textContent ?? '';
    expect(css).toContain('.deadline-day[data-today] .deadline-number{border-color:var(--ir-color-accent)');
    expect(css).not.toContain('.deadline-day[data-pinned][data-today] .deadline-number{border-color:');
  });
  it('shows the next deadline beyond the grid, or the empty caption when all are overdue', () => {
    const outside = item('Far away', '2027-01-30'), past = item('Past', '2026-11-29');
    const { rerender } = render(<MantineProvider><DeadlineCalendar items={[outside, past]} now={local(2026, 11, 30)} onOpen={() => {}} /></MantineProvider>);
    expect(screen.getByRole('button', { name: /Next:.*Far away/ })).toBeInTheDocument();
    rerender(<MantineProvider><DeadlineCalendar items={[past]} now={local(2026, 11, 30)} onOpen={() => {}} /></MantineProvider>);
    expect(screen.getByText('No upcoming deadlines')).toBeInTheDocument();
  });
  it('moves keyboard focus into a pinned list and restores the day on Escape', async () => {
    const user = userEvent.setup(); const now = local(2026, 11, 2, 10);
    render(<MantineProvider><DeadlineCalendar items={[item('Acme one', '2026-11-03'), item('Acme two', '2026-11-03')]} now={now} onOpen={() => {}} /></MantineProvider>);
    const today = screen.getByRole('button', { name: /Monday, November 2, 2026.*today/ }); today.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    const day = screen.getByRole('button', { name: /Tuesday, November 3, 2026, 2 deadlines/ });
    const choice = await screen.findByRole('button', { name: /Acme one.*example\/one/ });
    await waitFor(() => expect(choice).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(day).toHaveFocus());
    await waitFor(() => expect(day).toHaveAttribute('aria-expanded', 'false'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(day).toHaveAttribute('data-pinned'));
    day.focus(); await user.keyboard('{Escape}');
    await waitFor(() => expect(day).toHaveFocus());
    expect(day).toHaveAttribute('aria-expanded', 'false');
  });
  it('keeps focus in the library filter after an outside click dismisses a pinned list', async () => {
    const user = userEvent.setup(); const now = local(2026, 11, 2, 10);
    render(<MantineProvider><input aria-label="Filter courses" /><DeadlineCalendar items={[item('Acme one', '2026-11-03'), item('Acme two', '2026-11-03')]} now={now} onOpen={() => {}} /></MantineProvider>);
    const day = screen.getByRole('button', { name: /Tuesday, November 3, 2026, 2 deadlines/ });
    await user.click(day); await screen.findByRole('button', { name: /Acme one.*example\/one/ });
    const filter = screen.getByRole('textbox', { name: 'Filter courses' });
    await user.click(filter); await user.type(filter, 'Acme');
    await waitFor(() => expect(day).toHaveAttribute('aria-expanded', 'false'));
    expect(filter).toHaveFocus(); expect(filter).toHaveValue('Acme');
  });
  it('ignores the repository selector and text filter while hiding dated reorder controls', async () => {
    const dated = item('Acme alpha', '2099-01-03', 1, 'example/one'), other = item('Acme beta', '2099-01-02', 2, 'example/two');
    const undated = { ...item('Acme manual', '', 0, 'example/one'), deadline: undefined };
    const snapshot = { categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [dated, other, undated], courseRepos: ['example/one', 'example/two'] };
    render(<MantineProvider><LibraryPanel snapshot={snapshot} courseRepo="example/one" onOpen={() => {}} onChange={() => {}} /></MantineProvider>);
    expect(screen.queryByRole('button', { name: 'Reorder Acme alpha' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Acme manual .*drills complete/ }).closest('.library-item-row')).toHaveAttribute('data-reorderable', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: /Filter courses/ }), { target: { value: 'manual' } });
    expect(screen.getByTitle(/Acme beta ·/)).toBeInTheDocument();
  });
  it('supports roving keyboard, hover preview, multi pin and single activation', async () => {
    const now = local(2026, 11, 2, 10), a = item('Acme one', '2026-11-03'), b = item('Acme two', '2026-11-03', 1, 'example/two'), c = item('Acme three', '2026-11-04'); const onOpen = vi.fn();
    render(<MantineProvider><DeadlineCalendar items={[a, b, c]} now={now} onOpen={onOpen} /></MantineProvider>);
    const grid = screen.getByRole('grid', { name: /November 1 through November 28, 2026/ });
    const today = within(grid).getByRole('button', { name: /Monday, November 2, 2026.*today/ }); today.focus(); fireEvent.keyDown(today, { key: 'ArrowRight' });
    const multi = within(grid).getByRole('button', { name: /Tuesday, November 3, 2026, 2 deadlines/ }); expect(multi).toHaveFocus();
    fireEvent.mouseEnter(multi); await waitFor(() => expect(screen.getByText('Tuesday, November 3 · 2 deadlines')).toBeInTheDocument());
    const dropdown = screen.getByText('Tuesday, November 3 · 2 deadlines').closest('.mantine-Popover-dropdown') as HTMLElement;
    expect(dropdown.style.background).toBe('var(--ir-color-canvas)'); expect(dropdown.style.boxShadow).toBe('var(--ir-shadow-overlay)');
    fireEvent.click(multi); expect(multi).toHaveAttribute('data-pinned');
    const choice = screen.getByRole('button', { name: /Acme two.*example\/two/ }); choice.focus(); fireEvent.keyDown(choice, { key: 'Escape' });
    await waitFor(() => expect(multi).toHaveFocus()); await waitFor(() => expect(screen.queryByText('Tuesday, November 3 · 2 deadlines')).not.toBeInTheDocument());
    fireEvent.click(multi); fireEvent.click(await screen.findByRole('button', { name: /Acme two.*example\/two/ })); expect(onOpen).toHaveBeenCalledWith(b);
    const single = within(grid).getByRole('button', { name: /Wednesday, November 4, 2026, 1 deadline/ }); fireEvent.click(single); expect(onOpen).toHaveBeenCalledWith(c);
  });
});
