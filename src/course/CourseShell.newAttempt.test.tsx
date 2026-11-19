import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CourseShell from './CourseShell';

vi.mock('./SandboxWorkspace', () => ({ default: () => <div>Completed workspace</div> }));
const attempt = { attemptNumber: 1, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:30:00.000Z', accumulatedActiveMs: 1_800_000, elapsedMs: 1_800_000, stage: 2, stageCount: 2 };
const course = { id: 'ai', title: 'AI', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 30, sourcePath: 'drills/ai/pair/workspace/src/index.ts', workspacePath: 'drills/ai/pair/workspace', testRunner: 'vitest', handoffPath: 'handoff.md', rubricPath: 'rubric.md', stageUnlock: { mode: 'manual' }, instructions: '## Milestone 1\nOne\n## Milestone 2\nTwo' }] }] };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('new attempt confirmation', () => {
  let attemptsResponse: () => Promise<Response>;
  let startResponse: () => Promise<Response>;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => { const url = String(input); if (url === '/api/courses') return json([{ id: 'ai', title: 'AI', chapterCount: 1, drillCount: 1 }]); if (url === '/api/courses/ai') return json(course); if (url === '/api/attempts/ai' && !init?.method) return attemptsResponse(); if (url === '/api/attempts/ai/pair' && init?.method === 'POST') return startResponse(); if (url.startsWith('/api/progress/') || url.startsWith('/api/book-chapter-rank/')) return json({}); if (url === '/api/test-results') return json({ available: false }); if (url === '/api/library') return json({ categories: [], items: [] }); if (url === '/api/cheatsheets' || url === '/api/books' || url === '/api/courses') return json([]); return json({}, 404); });
  beforeEach(() => { attemptsResponse = () => json({ attempts: { pair: [attempt] } }); startResponse = () => json({ attempts: [attempt, { attemptNumber: 2, startedAt: new Date().toISOString(), activeSince: new Date().toISOString(), accumulatedActiveMs: 0, elapsedMs: 0 }] }); localStorage.clear(); history.replaceState({}, '', '/?course=ai&drill=pair'); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { history.replaceState({}, '', '/'); vi.restoreAllMocks(); fetchMock.mockClear(); });

  it('uses a focus-managed Modal instead of window.confirm', async () => {
    const user = userEvent.setup(); const confirm = vi.spyOn(window, 'confirm'); render(<MantineProvider><CourseShell /></MantineProvider>);
    const trigger = await screen.findByRole('button', { name: 'Start new attempt' }); await user.click(trigger); const dialog = await screen.findByRole('dialog', { name: 'Start a new attempt?' }); expect(within(dialog).getByRole('button', { name: 'Close new attempt dialog' })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Keep current attempt' })).toHaveFocus()); await user.keyboard('{Escape}'); await waitFor(() => expect(trigger).toHaveFocus()); expect(confirm).not.toHaveBeenCalled();
    await user.click(trigger); const reopened = await screen.findByRole('dialog', { name: 'Start a new attempt?' }); await user.click(within(reopened).getByRole('button', { name: 'Start new attempt' })); await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/attempts/ai/pair', expect.objectContaining({ method: 'POST' }))); expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument(); expect(screen.getByText(/^(30:00|29:59)$/)).toBeInTheDocument();
  });

  it('restarts an existing AI attempt from full time and restores it after reload', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const activeSince = new Date(Date.now() - 10_000).toISOString();
    const active = { attemptNumber: 2, startedAt: activeSince, activeSince, accumulatedActiveMs: 600_000, elapsedMs: 610_000 };
    attemptsResponse = () => json({ attempts: { pair: [attempt, active] } });
    startResponse = () => json({ attempts: [attempt, active] });
    const user = userEvent.setup(); const view = render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByRole('button', { name: 'Pause' });
    await user.click(screen.getByRole('button', { name: 'Restart timer' }));
    await waitFor(() => expect(screen.getByText(/^(30:00|29:59)$/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('interview-runner-timer:ai/pair:reset')!).elapsedMs).toBeGreaterThanOrEqual(610_000);
    now += 3_000; await waitFor(() => expect(screen.getByText('29:57')).toBeInTheDocument());
    view.unmount(); render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('29:57')).toBeInTheDocument());
  });

  it('does not start the countdown when the server does not activate the attempt', async () => {
    startResponse = () => json({ attempts: [{ ...attempt, completedAt: undefined }] });
    const user = userEvent.setup(); render(<MantineProvider><CourseShell /></MantineProvider>);
    await user.click(await screen.findByRole('button', { name: 'Restart timer' }));
    expect(await screen.findByText('Attempt could not be started.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('surfaces an attempts fetch failure and retries it', async () => {
    attemptsResponse = () => json({ error: 'Attempt database is unavailable' }, 503); render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Attempt database is unavailable'); attemptsResponse = () => json({ attempts: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument()); expect(screen.getByText('Completed workspace')).toBeInTheDocument();
  });

  it('ignores a stale local countdown when the server has no AI-coding attempt', async () => {
    attemptsResponse = () => json({ attempts: {} }); localStorage.setItem('interview-runner-timer:ai/pair', JSON.stringify({ remainingMs: 1_000_000, endTime: Date.now() + 1_000_000 }));
    render(<MantineProvider><CourseShell /></MantineProvider>); expect(await screen.findByRole('button', { name: 'Start new attempt' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('interview-runner-timer:ai/pair')).toBeNull());
  });
});
