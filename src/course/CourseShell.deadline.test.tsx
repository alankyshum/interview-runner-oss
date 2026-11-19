import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'alpha' && drill === 'lesson' }; });
import CourseShell from './CourseShell';

beforeEach(() => { localStorage.clear(); history.replaceState({}, '', '/'); });

it.each([undefined, '2027-01-15'])('updates the selected heading after adding, editing and clearing a deadline (manifest: %s)', async (manifestDeadline) => {
  let override: string | null | undefined;
  const item = () => ({ kind: 'course', id: 'alpha', categoryId: 'uncategorized', position: 0, status: 'active', statusExplicit: false, manifestTitle: 'Alpha', title: 'Alpha', tags: [], doneDrills: 0, totalDrills: 1, remainingMinutes: 1, inProgress: false, manifestDeadline, deadline: override === null ? undefined : override ?? manifestDeadline, deadlineOverride: override });
  const snapshot = () => ({ categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [item()], courseRepos: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let payload: unknown = {};
    if (url === '/api/library') payload = snapshot();
    if (url === '/api/courses') payload = [{ id: 'alpha', title: 'Alpha', deadline: manifestDeadline, chapterCount: 1, drillCount: 1 }];
    // Keep this response stale after edits: the Library snapshot is the authority for the heading.
    if (url === '/api/courses/alpha') payload = { id: 'alpha', title: 'Alpha', deadline: manifestDeadline ?? '2027-01-15', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'lesson', title: 'Lesson', contentType: 'reading', kind: 'scratch', estMinutes: 1, instructions: 'Study.', sourcePath: 'outlines/alpha/lesson.md', outlinePath: 'outlines/alpha/lesson.json' }] }] };
    if (url === '/api/cheatsheets') payload = [];
    if (url === '/api/library/items/course/alpha/schedule') { const body = JSON.parse(String(init?.body)); override = body.deadlineCleared ? null : body.deadline ?? undefined; payload = snapshot(); }
    return new Response(JSON.stringify(payload));
  }));
  const user = userEvent.setup(); const { container } = render(<MantineProvider><CourseShell /></MantineProvider>);
  await screen.findByTestId('selected-course-label');
  if (manifestDeadline) await waitFor(() => expect(container.querySelector('.deadline-line-heading')).toHaveTextContent('Jan 15'));
  else expect(container.querySelector('.deadline-line-heading')).not.toBeInTheDocument();
  const edit = async (date: string) => {
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' }));
    fireEvent.change(await screen.findByLabelText('Deadline'), { target: { value: date } }); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(container.querySelector('.deadline-line-heading')).toHaveTextContent(date === '2026-12-01' ? 'Dec 1' : 'Dec 10'));
  };
  await edit('2026-12-01'); await edit('2026-12-10');
  await user.click(screen.getByRole('button', { name: 'Actions for Alpha' })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); await user.click(await screen.findByRole('button', { name: 'No deadline' })); await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(container.querySelector('.deadline-line-heading')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Actions for Alpha' })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); await user.click(await screen.findByRole('button', { name: 'Reset to manifest defaults' }));
  if (manifestDeadline) await waitFor(() => expect(container.querySelector('.deadline-line-heading')).toHaveTextContent('Jan 15'));
  else await waitFor(() => expect(container.querySelector('.deadline-line-heading')).not.toBeInTheDocument());
});
