import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'mixed' && drill === 'read' }; });
import CourseShell from './CourseShell';

vi.mock('./SandboxWorkspace', () => ({ default: () => <div data-testid="coding-workspace">Coding workspace</div> }));
const reading = { id: 'read', title: 'Read lesson', contentType: 'reading', outlinePath: 'outlines/mixed/read.json', kind: 'scratch', estMinutes: 5, sourcePath: 'reading/mixed/read.md', instructions: 'Read.' };
const coding = { id: 'code', title: 'Code lesson', contentType: 'coding', kind: 'logic', estMinutes: 10, sourcePath: 'drills/mixed/drills/code.ts', testPath: 'drills/mixed/drills/code.test.ts', instructions: 'Implement.' };
const course = { id: 'mixed', title: 'Mixed course', chapters: [{ id: 'chapter', title: 'Chapter', drills: [reading, coding] }] };
const outline = { courseId: 'mixed', drillId: 'read', title: 'Reading outline', nodes: [{ id: 'claim', type: 'claim', text: 'Read this claim.' }] };
const response = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
let payload: unknown;
beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=mixed'); payload = course;
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/courses') return response([{ id: 'mixed', title: 'Mixed course', chapterCount: 1, drillCount: 2 }]);
    if (input === '/api/courses/mixed') return response(payload);
    if (input === '/api/outlines/mixed/read') return response(outline);
    // Even an existing stray outline must not turn a coding lesson into reading.
    if (input === '/api/outlines/mixed/code') return response({ ...outline, drillId: 'code' });
    if (input === '/api/cheatsheets') return response([]);
    if (input === '/api/test-results') return response({ available: false });
    if (init?.method === 'PUT') return response({ status: 'in-progress', updatedAt: '2026-10-22T00:00:00Z' });
    return response({});
  }));
});

it('switches reading → coding → reading in one course, with distinct icons and no inferred mode', async () => {
  const user = userEvent.setup(); render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByTestId('outline-reader')).toBeInTheDocument();
  const nav = within(screen.getByRole('complementary', { name: 'Course outline' }));
  expect(nav.getByRole('img', { name: 'Reading' })).toBeInTheDocument();
  expect(nav.getByRole('img', { name: 'Coding' })).toBeInTheDocument();
  await user.click(nav.getByText('Code lesson'));
  expect(await screen.findByTestId('coding-workspace')).toBeInTheDocument();
  expect(screen.queryByTestId('outline-reader')).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/outlines/mixed/code')).toBe(false);
  await user.click(nav.getByText('Read lesson'));
  expect(await screen.findByTestId('outline-reader')).toBeInTheDocument();
  expect(screen.queryByTestId('coding-workspace')).not.toBeInTheDocument();
});

it('shows a controlled validation error for an unsupported lesson type', async () => {
  payload = { ...course, chapters: [{ ...course.chapters[0], drills: [{ ...reading, contentType: 'video' }] }] };
  render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('contentType must be reading, coding, ai-coding, map, recall, or whiteboard');
  expect(screen.queryByTestId('coding-workspace')).not.toBeInTheDocument();
});

it('rejects instruction-only reading without probing an outline', async () => {
  payload = { ...course, chapters: [{ ...course.chapters[0], drills: [{ ...reading, outlinePath: undefined }] }] };
  render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('read.outlinePath is required for reading lessons');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/outlines/'))).toBe(false);
});
