import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import CourseShell from './CourseShell';
vi.mock('@excalidraw/excalidraw', () => ({ CaptureUpdateAction: { NEVER: 'NEVER' }, hashElementsVersion: (elements: Array<{ id: string }>) => elements.reduce((hash, e) => hash + e.id.length, 0), Excalidraw: () => <div>Canvas</div>, getCommonBounds: () => [0, 0, 10, 10], exportToSvg: async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg') }));

vi.mock('markmap-view', () => ({ Markmap: class {
  constructor(_svg: SVGSVGElement, public options: { maxWidth: number }) {}
  svg = { on: () => this.svg, node: () => null, property: () => ({ k: 1 }) };
  zoom = { filter: () => this.zoom, on: () => this.zoom };
  state = {};
  setData = async () => {};
  toggleNode = async () => {};
  renderData = async () => {};
  destroy = () => {};
} }));

afterEach(() => vi.unstubAllGlobals());

it.each([{ contentType: 'recall', whiteboard: true }, { contentType: 'whiteboard' }])('opens the same standard-course whiteboard controls for $contentType', async (declaration) => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample&chapter=chapter&drill=first');
  const course = { id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'first', title: 'First', ...declaration, kind: 'scratch', estMinutes: 40, sourcePath: 'recall/sample/first.json', instructions: 'Practice.' }] }] };
  const lesson = { courseId: 'sample', drillId: 'first', title: 'Whiteboard', questions: [{ id: 'one', prompt: 'Question?', answer: 'Answer' }] };
  const fetcher = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw); const value = url === '/api/courses' ? [{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 1, drillCount: 1 }]
      : url === '/api/courses/sample' ? course : url === '/api/map-recall/sample/first' ? lesson
      : url === '/api/recall-whiteboards/sample/first' ? { snapshot: null, legacy: [{ id: 'one', snapshot: null }] }
      : url === '/api/progress/sample/first' && init?.method === 'PUT' ? { status: 'done', updatedAt: '2026-01-01' }
      : url === '/api/library' ? { categories: [], items: [], courseRepos: [] } : url === '/api/books' || url === '/api/cheatsheets' ? [] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher); render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByText('Canvas')).toBeInTheDocument();
  expect(within(screen.getByRole('button', { name: /First 40m, Whiteboard, not started, 40 minutes/ })).getByRole('img', { name: 'Whiteboard' })).toBeInTheDocument();
  expect(screen.getByRole('separator', { name: 'Resize question and whiteboard' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hold 3s for hint · Milestone 1 (hold for 3 seconds)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Mark as done' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/progress/sample/first', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'done' }) })));
});

it('opens and counts a first-class whiteboard in a map + recall course', async () => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample&chapter=chapter&drill=first');
  const course = { type: 'map-recall', id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 0, sourcePath: 'mindmaps/sample/map.md', instructions: 'Study.' }, { id: 'first', title: 'First', contentType: 'whiteboard', kind: 'scratch', estMinutes: 40, sourcePath: 'recall/sample/first.json', instructions: 'Practice.' }] }] };
  const lesson = { courseId: 'sample', drillId: 'first', title: 'Whiteboard', questions: [{ id: 'one', prompt: 'Question?', answer: 'Answer' }] };
  vi.stubGlobal('fetch', vi.fn(async (raw: string | URL | Request) => {
    const url = String(raw); const value = url === '/api/courses' ? [{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 1, drillCount: 2 }]
      : url === '/api/courses/sample' ? course : url === '/api/map-recall/sample/first' ? lesson
      : url === '/api/recall-progress/sample' ? { first: { checked: 0, total: 1, hasStoredChecks: false } }
      : url === '/api/recall-whiteboards/sample/first' ? { snapshot: null, legacy: [{ id: 'one', snapshot: null }] }
      : url === '/api/library' ? { categories: [], items: [], courseRepos: [] } : url === '/api/books' || url === '/api/cheatsheets' ? [] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByText('Canvas')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /First Whiteboard · Not done/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mark as done' })).toBeInTheDocument();
});

it('opens a standard course map and retains normal drill completion', async () => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample&chapter=chapter&drill=map');
  const course = { id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/sample/map.md', instructions: 'Study.' }] }] };
  let failLoad = false;
  const fetcher = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (url === '/api/progress/sample' && failLoad) return new Response('{}', { status: 500 });
    const value = url === '/api/courses' ? [{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 1, drillCount: 1 }]
      : url === '/api/courses/sample' ? course : url === '/api/map-recall/sample/map' ? { source: '# Map\n- Branch' }
      : url === '/api/progress/sample' ? { map: { status: 'done' } } : url === '/api/progress/sample/map' && init?.method === 'PUT' ? { status: 'not-started' }
      : url === '/api/library' ? { categories: [], items: [], courseRepos: [] } : url === '/api/books' || url === '/api/cheatsheets' ? [] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = <MantineProvider><CourseShell /></MantineProvider>;
  const rendered = render(view);
  expect(await screen.findByText('Reference · counts as a drill')).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveClass('map-lesson-main');
  expect(await screen.findByRole('button', { name: 'Mark not done' })).toBeEnabled();
  let controls = document.querySelector('.map-recall-controls')!;
  expect(controls).toContainElement(screen.getByRole('button', { name: 'Mark not done' }));
  expect(controls).toContainElement(screen.getByRole('button', { name: 'More map actions' }));
  expect(screen.getByRole('button', { name: 'More map actions' }).compareDocumentPosition(screen.getByRole('button', { name: 'Mark not done' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Mark not done' }).compareDocumentPosition(screen.getByRole('radiogroup', { name: 'Reference view' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  await waitFor(() => expect(document.querySelector('.map-recall-fullscreen-body')).toContainElement(screen.getByTestId('sidebar-controls')));
  expect(readFileSync('src/reader/mapRecall.css', 'utf8')).toContain('background: var(--ir-color-canvas); color: var(--ir-color-text);');
  fireEvent.click(screen.getByRole('button', { name: 'Sidebar and theme controls' }));
  expect(await screen.findByRole('menuitemcheckbox', { name: /Hide library/ })).toBeInTheDocument();
  expect(screen.queryByRole('tooltip', { name: 'Sidebar and theme controls' })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
  await waitFor(() => expect(screen.getByTestId('sidebar-controls').closest('.map-recall-fullscreen-body')).toBeNull());
  controls = document.querySelector('.map-recall-controls')!;
  fireEvent.click(screen.getByRole('radio', { name: 'Text outline' }));
  expect(controls).toContainElement(screen.getByRole('button', { name: 'Mark not done' }));
  expect(screen.queryByRole('button', { name: 'More map actions' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mark not done' }).compareDocumentPosition(screen.getByRole('radiogroup', { name: 'Reference view' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Mark not done' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/progress/sample/map', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'not-started' }) })));
  rendered.unmount(); failLoad = true; render(view);
  expect(await screen.findByText('Progress unavailable. Reload to try again.')).toBeInTheDocument();
  expect(document.querySelector('.map-recall-controls')).toContainElement(screen.getByRole('button', { name: 'Mark as done' }));
  expect(screen.getByRole('button', { name: 'Mark as done' })).toBeDisabled();
});

it('opens a map course using answer-free progress summaries, without fetching recall answers', async () => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample');
  const lesson = (id: string, type: 'map' | 'recall') => ({ id, title: id, contentType: type, kind: 'scratch', estMinutes: 1, sourcePath: `${type === 'map' ? 'mindmaps' : 'recall'}/sample/${id}.${type === 'map' ? 'md' : 'json'}`, instructions: 'Study.' });
  const course = { type: 'map-recall', id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [lesson('map', 'map'), lesson('first', 'recall'), lesson('second', 'recall')] }] };
  const received: string[] = [];
  const reply = (value: unknown) => { const body = JSON.stringify(value); received.push(body); return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })); };
  const fetcher = vi.fn((raw: string | URL | Request) => {
    const url = String(raw);
    if (url === '/api/courses') return reply([{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 1, drillCount: 3 }]);
    if (url === '/api/courses/sample') return reply(course);
    if (url === '/api/map-recall/sample/map') return reply({ source: '# Map' });
    if (url === '/api/map-recall/sample/first' || url === '/api/map-recall/sample/second') return reply({ questions: [{ answer: 'SECRET ANSWER' }] });
    if (url === '/api/recall-progress/sample') return reply({ first: { checked: 1, total: 2, hasStoredChecks: true }, second: { checked: 0, total: 3, hasStoredChecks: false } });
    if (url === '/api/library') return reply({ categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [], courseRepos: [] });
    if (url === '/api/books' || url === '/api/cheatsheets') return reply([]);
    if (url === '/api/test-results') return reply({ available: false });
    return reply({});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByText('Reference · not counted')).toBeInTheDocument();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/recall-progress/sample')).toBe(true));
  expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain('/api/map-recall/sample/first');
  expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain('/api/map-recall/sample/second');
  expect(received.join('\n')).not.toContain('SECRET ANSWER');
  expect(screen.getByRole('main')).toHaveClass('map-lesson-main');
  const mapPadding = screen.getByRole('main').style.paddingBottom;
  fireEvent.click(screen.getByRole('button', { name: 'Sidebar and theme controls' }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Hide library/ }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Hide course chapters/ }));
  expect(screen.getByTestId('sidebar-controls')).toHaveAttribute('data-floating', 'true');
  expect(screen.getByRole('main')).not.toHaveAttribute('data-settings-overlap');
  expect(screen.getByRole('main').style.paddingBottom).toBe(mapPadding);
  expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Show course chapters/ }));
  fireEvent.click(screen.getByRole('button', { name: /^first Recall/ }));
  await waitFor(() => expect(screen.getByRole('main')).not.toHaveClass('map-lesson-main'));
  expect(screen.getByRole('main').getAttribute('style')).toContain('3.5rem');
});

it('navigates distinct maps across chapters and reports their actual count', async () => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample&chapter=chapter&drill=map');
  const lesson = (id: string, type: 'map' | 'recall') => ({ id, title: id, contentType: type, kind: 'scratch', estMinutes: 1, sourcePath: `${type === 'map' ? 'mindmaps' : 'recall'}/sample/${id}.${type === 'map' ? 'md' : 'json'}`, instructions: 'Study.' });
  const course = { type: 'map-recall', id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [lesson('map', 'map'), lesson('first', 'recall')] }, { id: 'two', title: 'Second chapter', drills: [lesson('map-two', 'map'), lesson('map-three', 'map')] }] };
  const item = { kind: 'course', id: 'sample', repo: 'fixture', categoryId: 'uncategorized', position: 0, status: 'active', statusExplicit: false, manifestTitle: 'Sample', title: 'Sample', tags: [], type: 'map-recall', mapLessonCount: 3, recallLessonCount: 1, doneDrills: 1, totalDrills: 2, remainingMinutes: 0, inProgress: true };
  const fetcher = vi.fn(async (raw: string | URL | Request) => {
    const url = String(raw);
    const value = url === '/api/courses' ? [{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 2, drillCount: 4 }]
      : url === '/api/courses/sample' ? course : url === '/api/map-recall/sample/map' ? { source: '# First Map' }
      : url === '/api/map-recall/sample/map-two' ? { source: '# Second Map' } : url === '/api/map-recall/sample/map-three' ? { source: '# Third Map' }
      : url === '/api/recall-progress/sample' ? { first: { checked: 1, total: 2, hasStoredChecks: true } }
      : url.startsWith('/api/library') ? { categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [item], courseRepos: [] }
      : url === '/api/books' || url === '/api/cheatsheets' ? [] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher); render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByRole('button', { name: /Sample .*Map \+ recall, 3 reference maps, 1 recall lessons, 1 of 2 recalled/ })).toBeInTheDocument();
  expect(screen.getAllByText(/Map \+ recall · 3 reference maps · 1 recall lessons/).length).toBeGreaterThan(0);
  const chapter = screen.getByRole('button', { name: /Second chapter/ });
  if (chapter.getAttribute('aria-expanded') === 'false') fireEvent.click(chapter);
  fireEvent.click(await screen.findByRole('button', { name: 'map-two Reference · not counted' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/map-recall/sample/map-two'));
  fireEvent.click(screen.getByRole('button', { name: 'map-three Reference · not counted' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/map-recall/sample/map-three'));
  expect(screen.getByRole('button', { name: /first Recall · 1\/2 recalled/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mark as done' })).not.toBeInTheDocument();
});

it('opens an opted-in whiteboard without changing desktop navigation preferences', async () => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample&chapter=chapter&drill=first');
  const course = { type: 'map-recall', id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/sample/map.md', instructions: 'Study.' }, { id: 'first', title: 'First', contentType: 'recall', whiteboard: true, kind: 'scratch', estMinutes: 1, sourcePath: 'recall/sample/first.json', instructions: 'Study.' }] }] };
  const lesson = { courseId: 'sample', drillId: 'first', title: 'Recall', questions: [{ id: 'one', prompt: 'Question?', answer: 'Answer' }] };
  vi.stubGlobal('fetch', vi.fn(async (raw: string | URL | Request) => {
    const url = String(raw);
    const value = url === '/api/courses' ? [{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 1, drillCount: 2 }]
      : url === '/api/courses/sample' ? course : url === '/api/map-recall/sample/first' ? lesson
      : url === '/api/recall-whiteboards/sample/first' ? { snapshot: null, legacy: [{ id: 'one', snapshot: null }] }
      : url === '/api/library' ? { categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [], courseRepos: [] }
      : url === '/api/books' || url === '/api/cheatsheets' ? [] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  render(<MantineProvider><CourseShell /></MantineProvider>);
  expect(await screen.findByText('Canvas')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'Library' })).toBeInTheDocument();
  const divider = screen.getByRole('separator', { name: 'Resize question and whiteboard' });
  expect(divider).toHaveAttribute('aria-valuenow', '65');
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider).toHaveAttribute('aria-valuenow', '67');
  expect(JSON.parse(localStorage.getItem('interview-runner-ui-state')!).editorPercent).toBe(67);
  fireEvent.keyDown(divider, { key: 'End' }); expect(divider).toHaveAttribute('aria-valuenow', '80');
  fireEvent.keyDown(divider, { key: 'Home' }); expect(divider).toHaveAttribute('aria-valuenow', '45');
  fireEvent.doubleClick(divider); expect(divider).toHaveAttribute('aria-valuenow', '65');
  expect(screen.getByRole('button', { name: 'Hide questions' })).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Hide questions' }));
  expect(screen.queryByRole('separator', { name: 'Resize question and whiteboard' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show questions' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Question' })).not.toBeInTheDocument();
  expect(document.getElementById('whiteboard-questions')).toHaveAttribute('inert');
  expect(screen.getByRole('navigation', { name: 'Library' })).toBeInTheDocument();
  expect(screen.getByText(/01:00/)).toBeInTheDocument();
});

it('marks a whiteboard done and undone, updates chapter and library counts, and preserves the canvas across remounts', async () => {
  localStorage.clear(); window.history.replaceState({}, '', '/?course=sample&chapter=chapter&drill=first');
  const course = { type: 'map-recall', id: 'sample', title: 'Sample', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/sample/map.md', instructions: 'Study.' }, { id: 'first', title: 'First', contentType: 'recall', whiteboard: true, kind: 'scratch', estMinutes: 1, sourcePath: 'recall/sample/first.json', instructions: 'Study.' }, { id: 'second', title: 'Second', contentType: 'recall', kind: 'scratch', estMinutes: 1, sourcePath: 'recall/sample/second.json', instructions: 'Study.' }] }] };
  const lesson = { courseId: 'sample', drillId: 'first', title: 'Recall', questions: [{ id: 'one', prompt: 'Question?', answer: 'Answer' }] };
  let status = 'not-started'; let fail = false; let failLoad = false;
  const board = { scene: { elements: [{ id: 'shape' }], appState: {}, files: {} }, svg: '', updatedAt: 1 };
  const fetcher = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw); const done = status === 'done';
    if (url === '/api/progress/sample/first' && init?.method === 'PUT') { if (fail) return new Response('{}', { status: 500 }); status = JSON.parse(String(init.body)).status; return new Response(JSON.stringify({ status, updatedAt: '2026-01-01' }), { status: 200 }); }
    if (url === '/api/progress/sample' && failLoad) return new Response('{}', { status: 500 });
    const item = { kind: 'course', id: 'sample', repo: 'fixture', categoryId: 'uncategorized', position: 0, status: 'active', statusExplicit: false, manifestTitle: 'Sample', title: 'Sample', tags: [], type: 'map-recall', recallLessonCount: 2, whiteboardLessonCount: 1, doneDrills: done ? 1 : 0, totalDrills: 2, remainingMinutes: 0, inProgress: done };
    const value = url === '/api/courses' ? [{ id: 'sample', title: 'Sample', repo: 'fixture', chapterCount: 1, drillCount: 3 }]
      : url === '/api/courses/sample' ? course : url === '/api/map-recall/sample/first' ? lesson
      : url === '/api/progress/sample' ? { first: { status, updatedAt: '2026-01-01' } }
      : url === '/api/recall-progress/sample' ? { first: { checked: done ? 1 : 0, total: 1, hasStoredChecks: false }, second: { checked: 0, total: 1, hasStoredChecks: false } }
      : url === '/api/recall-whiteboards/sample/first' ? { snapshot: board, legacy: [{ id: 'one', snapshot: null }] }
      : url === '/api/library' ? { categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: [item], courseRepos: [] }
      : url === '/api/books' || url === '/api/cheatsheets' ? [] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = <MantineProvider><CourseShell /></MantineProvider>;
  const first = render(view); const mark = await screen.findByRole('button', { name: 'Mark as done' }); await waitFor(() => expect(mark).toBeEnabled());
  const row = await screen.findByRole('button', { name: 'First Whiteboard · Not done' });
  expect(within(row).getByRole('img', { name: 'Whiteboard' }).querySelector('svg')).toHaveClass('tabler-icon-chalkboard');
  expect(within(screen.getByRole('button', { name: /Second Recall/ })).getByRole('img', { name: 'Recall' }).querySelector('svg')).toHaveClass('tabler-icon-question-mark');
  expect(screen.getByRole('heading', { name: 'Recall' }).parentElement).toContainElement(screen.getAllByRole('img', { name: 'Whiteboard' }).at(-1)!);
  fireEvent.click(mark); expect(await screen.findByRole('button', { name: 'Mark not done' })).toBeEnabled();
  expect(await screen.findByRole('button', { name: 'First Whiteboard · Done' })).toBeInTheDocument();
  expect(await screen.findAllByText('1/2 completed')).toHaveLength(2);
  await waitFor(() => expect(screen.getByRole('button', { name: /Sample .*Map \+ recall.*1 of 2 completed/ })).toBeInTheDocument());
  expect(fetcher.mock.calls.some(([url, init]) => String(url).includes('recall-whiteboards') && init?.method === 'PUT')).toBe(false);
  first.unmount(); const second = render(view); expect(await screen.findByRole('button', { name: 'Mark not done' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Mark not done' })); expect(await screen.findByRole('button', { name: 'Mark as done' })).toBeEnabled();
  expect(await screen.findByRole('button', { name: 'First Whiteboard · Not done' })).toBeInTheDocument();
  fail = true; fireEvent.click(screen.getByRole('button', { name: 'Mark as done' }));
  expect(await screen.findByText('Whiteboard completion could not be saved.')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Mark as done' })).toBeInTheDocument();
  expect(board.scene.elements).toEqual([{ id: 'shape' }]);
  const writes = fetcher.mock.calls.filter(([url, init]) => String(url) === '/api/progress/sample/first' && init?.method === 'PUT').length;
  second.unmount(); failLoad = true; render(view);
  expect(await screen.findByText('Progress unavailable. Reload to try again.')).toBeInTheDocument();
  const disabled = screen.getByRole('button', { name: 'Mark as done' }); expect(disabled).toBeDisabled(); fireEvent.click(disabled);
  expect(fetcher.mock.calls.filter(([url, init]) => String(url) === '/api/progress/sample/first' && init?.method === 'PUT')).toHaveLength(writes);
});
