import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CourseShell from './CourseShell';

vi.mock('./SandboxWorkspaceShell', () => ({ default: ({ sandbox }: { sandbox: { url: string } }) => <iframe title="Sandbox editor" src={sandbox.url} /> }));

const activeSince = new Date().toISOString();
const active = { attemptNumber: 1, startedAt: activeSince, activeSince, accumulatedActiveMs: 0, elapsedMs: 0, stage: 1, stageCount: 1 };
const course = { id: 'ai', title: 'AI', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'pair', title: 'Pair', contentType: 'ai-coding', kind: 'logic', estMinutes: 30, sourcePath: 'drills/ai/pair/workspace/src/index.ts', workspacePath: 'drills/ai/pair/workspace', testRunner: 'vitest', handoffPath: 'handoff.md', rubricPath: 'rubric.md', stageUnlock: { mode: 'manual' }, instructions: '## Milestone 1\nOne' }] }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  history.replaceState({}, '', '/?course=ai&drill=pair');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: LockOptions, callback: (lock: object) => Promise<void>) => callback({}) } });
});
afterEach(() => { history.replaceState({}, '', '/'); vi.unstubAllGlobals(); });

it('keeps the editor and sandbox stable while pausing, resuming and restarting an active attempt', async () => {
  let current = active;
  let finishMutation: ((response: Response) => void) | undefined;
  const requests: Array<{ url: string; method?: string }> = [];
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method });
    if (url === '/api/courses') return Promise.resolve(json([{ id: 'ai', title: 'AI', chapterCount: 1, drillCount: 1 }]));
    if (url === '/api/courses/ai') return Promise.resolve(json(course));
    if (url === '/api/attempts/ai') return Promise.resolve(json({ attempts: { pair: [current] } }));
    if (url === '/api/attempts/ai/pair' && init?.method === 'POST') return new Promise<Response>((resolve) => { finishMutation = resolve; });
    if (url === '/api/sandboxes' && init?.method === 'POST') return Promise.resolve(json({ id: 's1', url: '/sandbox/s1/' }));
    if (url === '/api/test-results') return Promise.resolve(json({ available: false }));
    if (url === '/api/library') return Promise.resolve(json({ categories: [], items: [] }));
    if (url === '/api/cheatsheets' || url === '/api/books') return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  }));
  const user = userEvent.setup();
  const view = render(<MantineProvider><CourseShell /></MantineProvider>);
  await screen.findByRole('button', { name: 'Pause' });
  const frame = await screen.findByTitle('Sandbox editor');
  const src = frame.getAttribute('src');
  for (const [label, running] of [['Pause', false], ['Resume attempt', true], ['Restart timer', true]] as const) {
    await user.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(finishMutation).toBeDefined());
    expect(screen.getByTitle('Sandbox editor')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(src);
    current = { ...current, activeSince: running ? new Date().toISOString() : '' };
    await act(async () => { finishMutation!(json({ attempts: [current] })); finishMutation = undefined; });
    expect(screen.getByTitle('Sandbox editor')).toBe(frame);
  }
  expect(requests.filter(({ url, method }) => url === '/api/sandboxes' && method === 'POST')).toHaveLength(1);
  expect(requests.filter(({ url, method }) => url.startsWith('/api/sandboxes/') && method && method !== 'GET')).toEqual([]);
  view.unmount();
  await waitFor(() => expect(requests.some(({ url, method }) => url === '/api/sandboxes/s1' && method === 'DELETE')).toBe(true));
});
