import { MantineProvider } from "@mantine/core";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryPanel, { categoryExpansionKey, persistedMoveIndex, positionalDropIndex, sortUpNext, statusDropAllowed, statusExpansionKey, type LibraryItem, type LibrarySnapshot } from "./LibraryPanel";
import { getUiState, setUiState } from "./uiState";

const alpha: LibraryItem = { kind: "course", id: "alpha", categoryId: "uncategorized", position: 0, status: "active", statusExplicit: false, manifestTitle: "Alpha course with a sufficiently long title", title: "Alpha course with a sufficiently long title", company: "Acme", tags: ["backend"], doneDrills: 2, totalDrills: 5, remainingMinutes: 30, inProgress: true };
const beta: LibraryItem = { kind: "cheatsheet", id: "beta", categoryId: "uncategorized", position: 1, status: "active", statusExplicit: false, manifestTitle: "Beta", title: "Beta", tags: [], doneDrills: 0, totalDrills: 0, remainingMinutes: 0, inProgress: false };
const done: LibraryItem = { ...beta, id: "done", title: "Done item", manifestTitle: "Done item", categoryId: "soon", status: "done", position: 2 };
const archived: LibraryItem = { ...beta, id: "archived", title: "Archived item", manifestTitle: "Archived item", categoryId: "soon", status: "archived", position: 3 };
const alphaAccessibleName = `${alpha.title} 2/5 · 30m left, 2 of 5 drills complete, 30 minutes left`;
const initial: LibrarySnapshot = { categories: [{ id: "uncategorized", name: "Uncategorized", position: 0, fixed: true }, { id: "soon", name: "Soon", position: 1, fixed: false }], items: [alpha, beta, done, archived], courseRepos: [] };

function Harness({ data = initial, activeKey, initialExpanded = {}, onExpansion = vi.fn(), onOpen = vi.fn() }: { data?: LibrarySnapshot; activeKey?: string; initialExpanded?: Record<string, boolean>; onExpansion?: (key: string, open: boolean) => void; onOpen?: (item: LibraryItem) => void }) {
  const [snapshot, setSnapshot] = useState(data); const [expanded, setExpanded] = useState(initialExpanded);
  return <LibraryPanel snapshot={snapshot} activeKey={activeKey} expanded={expanded} onExpandedChange={(key, open) => { setExpanded((current) => ({ ...current, [key]: open })); onExpansion(key, open); }} onChange={setSnapshot} onOpen={onOpen} />;
}
function PersistentHarness() { const [snapshot, setSnapshot] = useState(initial); const [expanded, setExpanded] = useState(() => getUiState().libraryExpanded); return <LibraryPanel snapshot={snapshot} expanded={expanded} onExpandedChange={(key, open) => { const next = { ...expanded, [key]: open }; setExpanded(next); setUiState({ ...getUiState(), libraryExpanded: next }); }} onChange={setSnapshot} onOpen={() => {}} />; }

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); const body = JSON.parse(String(init?.body ?? "{}")); const next = structuredClone(initial); if (url === "/api/library/categories" && init?.method === "POST") { next.categories.push({ id: "created", name: body.name, position: next.categories.length, fixed: false }); return new Response(JSON.stringify(next), { status: 201 }); } const item = next.items.find((candidate) => url.includes(`/items/${candidate.kind}/${candidate.id}/`)); if (url.endsWith("/title") && item) { item.titleOverride = body.title ?? undefined; item.title = body.title ?? item.manifestTitle; } if (url.endsWith("/status") && item) item.status = body.status; if (url.endsWith("/move") && item) { item.categoryId = body.categoryId; item.position = body.position; } return new Response(JSON.stringify(next), { status: 200 }); }));
});

describe("LibraryPanel tree", () => {
  it.each([
    'Workspace: example, change workspace',
    'Actions for Up next',
    'Actions for category Uncategorized',
    `Actions for ${alpha.title}`,
  ])('references the menu for %s only while open', async (name) => {
    const data: LibrarySnapshot = { ...initial, courseRepos: ['example'], workspaceMode: true, items: initial.items.map((item) => ({ ...item, repo: 'example' })) };
    render(<MantineProvider><Harness data={data} /></MantineProvider>);
    const trigger = screen.getByRole('button', { name });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    fireEvent.click(trigger);
    const id = trigger.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('menu')).toBe(document.getElementById(id!)));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(trigger).not.toHaveAttribute('aria-controls');
  });
  it('opens item and category menus with context click and keyboard', async () => {
    render(<MantineProvider><Harness /></MantineProvider>);
    const title = screen.getByRole('button', { name: alphaAccessibleName });
    expect(getComputedStyle(title.closest('.library-item-row')!).gridTemplateColumns).toBe('24px minmax(0,1fr)');
    const itemAnchor = screen.getByRole('button', { name: `Actions for ${alpha.title}` });
    expect(itemAnchor).toHaveAttribute('tabindex', '-1'); expect(getComputedStyle(itemAnchor).opacity).toBe('0');
    expect(title).toHaveAttribute('aria-keyshortcuts', 'Shift+F10');
    fireEvent.contextMenu(title); expect(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit deadline and tier…' }), { key: 'Escape' });
    fireEvent.keyDown(title, { key: 'ContextMenu' }); expect(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit deadline and tier…' }), { key: 'Escape' });
    const category = screen.getByRole('button', { name: 'Collapse Uncategorized 2 in Up next' });
    fireEvent.keyDown(category, { key: 'F10', shiftKey: true }); expect(await screen.findByRole('menuitem', { name: 'New category' })).toBeInTheDocument();
  });
  it('opens a touch long-press menu without navigating', async () => {
    const open = vi.fn(); render(<MantineProvider><Harness onOpen={open} /></MantineProvider>);
    const title = screen.getByRole('button', { name: alphaAccessibleName });
    vi.useFakeTimers();
    try {
      const down = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 });
      Object.defineProperties(down, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, isPrimary: { value: true } });
      fireEvent(title, down); await act(async () => { await vi.advanceTimersByTimeAsync(600); }); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(screen.getByRole('menuitem', { name: 'Edit deadline and tier…' })).toBeInTheDocument();
      fireEvent.pointerUp(title, { pointerId: 1 }); fireEvent.click(title); expect(open).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('opens category actions on touch long-press without toggling the category', async () => {
    render(<MantineProvider><Harness /></MantineProvider>);
    const category = screen.getByRole('button', { name: 'Collapse Uncategorized 2 in Up next' });
    vi.useFakeTimers();
    try {
      const down = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 });
      Object.defineProperties(down, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, isPrimary: { value: true } });
      fireEvent(category, down); await act(async () => { await vi.advanceTimersByTimeAsync(600); }); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(screen.getByRole('menuitem', { name: 'New category' })).toBeInTheDocument();
      fireEvent.pointerUp(category, { pointerId: 1 }); fireEvent.click(category); expect(category).toHaveAttribute('aria-expanded', 'true');
    } finally { vi.useRealTimers(); }
  });
  it('suppresses navigation when the native touch context menu arrives before the timer', async () => {
    const open = vi.fn(); render(<MantineProvider><Harness onOpen={open} /></MantineProvider>);
    const title = screen.getByRole('button', { name: alphaAccessibleName });
    const down = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 });
    Object.defineProperties(down, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, isPrimary: { value: true } });
    fireEvent(title, down); fireEvent.contextMenu(title); expect(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })).toBeInTheDocument();
    fireEvent.pointerUp(title, { pointerId: 1 }); fireEvent.click(title); expect(open).not.toHaveBeenCalled();
  });
  it("keeps category disclosure at the parent edge and reserves trailing controls", () => {
    render(<MantineProvider><Harness /></MantineProvider>);
    const css = Array.from(document.querySelectorAll("nav[aria-label='Library'] style")).map((style) => style.textContent).join('');
    expect(css).toContain('.library-category-toggle{padding-inline:0 4px}');
    expect(css).toContain('.library-category-row:has(>.library-category-grip) .library-category-toggle{padding-right:44px}');
    expect(css).toContain('.library-category-grip{grid-column:2}');
    expect(css).toContain('.library-item-row[data-selected] .deadline-row-relative{color:var(--ir-color-selected-fg)}');
  });
  it('starts an empty workspace without categories and allows creating the first one', async () => {
    const user = userEvent.setup(); const data: LibrarySnapshot = { categories: [], items: [], courseRepos: ['pat'], workspaceMode: true };
    history.replaceState({}, '', '/?workspace=pat');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...data, categories: [{ id: 'one', name: 'First', position: 0, fixed: false }] }), { status: 201 })));
    try {
      render(<MantineProvider><Harness data={data} /></MantineProvider>);
      expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'New category' })).not.toBeInTheDocument();
      const status = screen.getByRole('button', { name: 'Collapse Up next 0' });
      expect(status).toHaveAttribute('aria-keyshortcuts', 'Shift+F10');
      fireEvent.contextMenu(status);
      await user.click(await screen.findByRole('menuitem', { name: 'New category' }));
      await user.type(await screen.findByLabelText('Category name'), 'First');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/library/categories?workspace=pat', expect.objectContaining({ method: 'POST' })));
      expect(await screen.findByRole('heading', { name: 'First' })).toBeInTheDocument();
    } finally { history.replaceState({}, '', '/'); }
  });
  it('opens the empty workspace status menu with keyboard and touch without toggling', async () => {
    const data: LibrarySnapshot = { categories: [], items: [], courseRepos: ['pat'], workspaceMode: true };
    render(<MantineProvider><Harness data={data} /></MantineProvider>);
    const status = screen.getByRole('button', { name: 'Collapse Up next 0' });
    fireEvent.keyDown(status, { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: 'New category' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'New category' }), { key: 'Escape' });
    vi.useFakeTimers();
    try {
      const down = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 });
      Object.defineProperties(down, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, isPrimary: { value: true } });
      fireEvent(status, down); await act(async () => { await vi.advanceTimersByTimeAsync(850); });
      expect(screen.getByRole('menuitem', { name: 'New category' })).toBeInTheDocument();
      fireEvent.pointerUp(status, { pointerId: 1 }); fireEvent.click(status); expect(status).toHaveAttribute('aria-expanded', 'true');
    } finally { vi.useRealTimers(); }
  });
  it('shows a first unassigned course without adding a stored category', () => {
    const data: LibrarySnapshot = { categories: [], items: [{ ...alpha, repo: 'pat' }], courseRepos: ['pat'], workspaceMode: true };
    render(<MantineProvider><Harness data={data} /></MantineProvider>);
    expect(screen.getByRole('button', { name: alphaAccessibleName })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(data.categories).toEqual([]);
  });
  it('can remove an assignment without creating an Uncategorized category', async () => {
    const user = userEvent.setup(); const item = { ...alpha, repo: 'pat', categoryId: 'one' };
    const data: LibrarySnapshot = { categories: [{ id: 'one', name: 'First', position: 0, fixed: false }], items: [item], courseRepos: ['pat'], workspaceMode: true };
    history.replaceState({}, '', '/?workspace=pat');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...data, items: [{ ...item, categoryId: 'uncategorized' }] }), { status: 200 })));
    try {
      render(<MantineProvider><Harness data={data} /></MantineProvider>);
      await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Move to category' }));
      await user.click(await screen.findByRole('menuitem', { name: 'No category' }));
      await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/library/items/course/alpha/move?workspace=pat', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('uncategorized') })));
      expect(screen.queryByRole('heading', { name: 'Uncategorized' })).not.toBeInTheDocument();
    } finally { history.replaceState({}, '', '/'); }
  });
  it("shows optional tier before the deadline and announces its priority on the course button", () => {
    const data: LibrarySnapshot = { ...initial, items: [{ ...alpha, tier: 1, deadline: '2026-11-12' }, { ...beta }, { ...alpha, id: 'gamma', title: 'Gamma', manifestTitle: 'Gamma', tier: 2, position: 2 }, { ...alpha, id: 'delta', title: 'Delta', manifestTitle: 'Delta', tier: 3, position: 3 }, { ...alpha, id: 'epsilon', title: 'Epsilon', manifestTitle: 'Epsilon', position: 4 }] };
    render(<MantineProvider><Harness data={data} activeKey="course:alpha" /></MantineProvider>);
    const button = screen.getByRole('button', { name: /Alpha course.*Interview priority tier 1 of 3, highest priority/ });
    expect(button).toHaveAttribute('aria-current', 'page');
    const pill = within(button).getByText('T1');
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill).toHaveAttribute('data-tier', '1');
    expect(pill.nextElementSibling).toHaveClass('deadline-row-line');
    expect(within(screen.getByRole('button', { name: /Gamma.*Interview priority tier 2 of 3/ })).getByText('T2')).toHaveAttribute('data-tier', '2');
    expect(within(screen.getByRole('button', { name: /Delta.*Interview priority tier 3 of 3/ })).getByText('T3')).toHaveAttribute('data-tier', '3');
    expect(within(screen.getByRole('button', { name: 'Epsilon 2/5 · 30m left, 2 of 5 drills complete, 30 minutes left' })).queryByText(/^T[123]$/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Beta' })).queryByText(/^T[123]$/)).not.toBeInTheDocument();
  });
  it("renders nested lists and indents each child text level", () => { render(<MantineProvider><Harness /></MantineProvider>); expect(screen.getByRole("button", { name: "Collapse Up next 2" })).toHaveAttribute("aria-expanded", "true"); expect(screen.getByRole("button", { name: "Expand Done 1" })).toHaveAttribute("aria-expanded", "false"); expect(screen.getByRole("button", { name: "Expand Archived 1" })).toHaveAttribute("aria-expanded", "false"); expect(screen.getByRole("button", { name: "Collapse Uncategorized 2 in Up next" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: alphaAccessibleName })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Done item" })).not.toBeInTheDocument(); const statusGuide = document.querySelector<HTMLElement>(".library-branch"); const categoryGuide = document.querySelector<HTMLElement>(".library-category-items"); expect(statusGuide).toContainElement(categoryGuide); expect(categoryGuide?.lastElementChild).toHaveClass("library-item-row"); expect(categoryGuide?.closest(".library-category-node")).toHaveClass("expanded"); const css = Array.from(document.querySelectorAll("nav[aria-label='Library'] style")).map((style) => style.textContent).join(''); expect(css).toContain(".library-tree>li+li{margin-top:4px"); expect(css).toContain(".library-branch{position:relative;margin-left:18px!important;padding-left:5px!important"); expect(css).toContain(".library-category-toggle{grid-column:1/-1"); expect(css).toContain(".library-category-items{position:relative;margin-left:13px!important;padding-left:5px!important"); expect(css).toContain(".library-status-row,.library-category-row{height:44px;min-height:44px}"); expect(css).toContain(".library-item-row{grid-template-columns:24px minmax(0,1fr) 44px;min-height:44px}"); expect(css).toContain("var(--ir-color-text-secondary)"); expect(screen.getByRole("navigation", { name: "Library" }).querySelector(":scope > div")).toHaveStyle({ paddingLeft: "12px", paddingRight: "10px" }); expect(document.querySelector(".mantine-ScrollArea-viewport")).not.toHaveStyle({ paddingBottom: "68px" }); expect(document.querySelector(".deadline-calendar")).toBeInTheDocument(); });

  it("uses selected roles and a non-color cue with fixed in-flow action columns", () => { render(<MantineProvider><Harness activeKey="course:alpha" /></MantineProvider>); const title = screen.getByRole("button", { name: alphaAccessibleName }); const row = title.closest(".library-item-row") as HTMLElement; expect(title).toHaveAttribute("aria-current", "page"); expect(row).toHaveAttribute("data-selected", "true"); const css = Array.from(document.querySelectorAll("nav[aria-label='Library'] style")).map((style) => style.textContent).join(''); expect(css).toContain(".library-item-row{grid-template-columns:24px minmax(0,1fr) 44px;min-height:44px}"); expect(css).toContain("background:var(--ir-color-selected-bg);box-shadow:inset 3px 0 0 var(--ir-color-selected-fg)"); expect(css).toContain(".library-item-kind{grid-column:1;grid-row:1"); expect(css).not.toContain(".library-item-grip{position:absolute"); expect(css).toContain(".library-item-row[data-selected] .library-item-title{font-weight:600}"); });
  it("reserves the category grip gutter without rendering a grip for fixed categories", () => { render(<MantineProvider><Harness /></MantineProvider>); const css = Array.from(document.querySelectorAll("nav[aria-label='Library'] style")).map((style) => style.textContent).join(''); expect(css).toContain('.library-category-row{grid-template-columns:44px minmax(0,1fr) 44px}'); expect(css).toContain('.library-category-grip{grid-column:1;grid-row:1'); expect(css).toContain('.library-category-toggle{grid-column:1/-1;grid-row:1;padding-inline:44px}'); expect(css).toContain('.library-category-actions{z-index:2}'); expect(css).toContain('.library-category-row:hover .library-category-toggle'); expect(screen.queryByRole('button', { name: 'Reorder Uncategorized' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Reorder Soon' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Reorder Soon' })).toHaveAttribute('draggable', 'true'); });

  it('keeps full-width status and category toggles separate from category actions', () => {
    render(<MantineProvider><Harness /></MantineProvider>);
    const status = screen.getByRole('button', { name: 'Collapse Up next 2' });
    const category = screen.getByRole('button', { name: 'Collapse Uncategorized 2 in Up next' });
    const action = screen.getByRole('button', { name: 'Actions for category Uncategorized' });
    expect(status).toHaveClass('library-status-toggle');
    expect(category.closest('.library-category-row')).toContainElement(action);
    expect(category).not.toContainElement(action);
    expect(action).toBeEnabled();
  });

  it("persists status and category expansion keys across remounts", async () => { const user = userEvent.setup(); const first = render(<MantineProvider><PersistentHarness /></MantineProvider>); await user.click(screen.getByRole("button", { name: "Collapse Up next 2" })); expect(getUiState().libraryExpanded[statusExpansionKey("active")]).toBe(false); first.unmount(); render(<MantineProvider><PersistentHarness /></MantineProvider>); expect(screen.getByRole("button", { name: "Expand Up next 2" })).toHaveAttribute("aria-expanded", "false"); await user.click(screen.getByRole("button", { name: "Expand Up next 2" })); await user.click(screen.getByRole("button", { name: "Collapse Soon 0 in Up next" })); expect(getUiState().libraryExpanded[categoryExpansionKey("active", "soon")]).toBe(false); });

  it("filtering force-opens matching ancestors without overwriting saved expansion", async () => { const user = userEvent.setup(); const onExpansion = vi.fn(); render(<MantineProvider><Harness initialExpanded={{ [statusExpansionKey("done")]: false, [categoryExpansionKey("done", "soon")]: false }} onExpansion={onExpansion} /></MantineProvider>); await user.type(screen.getByRole("textbox", { name: /Filter courses/ }), "Done item"); expect(screen.getByRole("button", { name: "Collapse Done 1" })).toHaveAttribute("aria-expanded", "true"); expect(screen.getByRole("button", { name: "Collapse Soon 1 in Done" })).toHaveAttribute("aria-expanded", "true"); expect(screen.getByRole("button", { name: "Done item" })).toBeInTheDocument(); expect(onExpansion).not.toHaveBeenCalled(); });

  it("shows a matching cheatsheet without a false no-courses message or preceding empty categories", async () => {
    const user = userEvent.setup();
    const repo = "me";
    const categories = [{ id: "uncategorized", name: "Uncategorized", position: 0, fixed: true }, ...["interview-prep", "job-list", "coding", "system-design"].map((id, index) => ({ id, name: id, position: index + 1, fixed: false }))];
    const atlas = { ...beta, id: "system-design-patterns-cheatsheet", repo, categoryId: "system-design", title: "System Design Interview Atlas", manifestTitle: "System Design Interview Atlas" };
    render(<MantineProvider><LibraryPanel snapshot={{ categories, items: [atlas], courseRepos: [repo] }} courseRepo={repo} onOpen={() => {}} onChange={() => {}} /></MantineProvider>);
    const search = screen.getByRole("textbox", { name: /Filter courses/ });
    for (const query of ["system design atlas", "atlas system", "SYSTEM atlas"]) {
      await user.clear(search); await user.type(search, query);
      expect(screen.getByRole("button", { name: atlas.title })).toBeInTheDocument();
      expect(screen.queryByText(/No courses in .* match/)).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "interview-prep" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Uncategorized" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "system-design" })).toBeInTheDocument();
    }
    await user.clear(search); await user.type(search, "no match");
    expect(screen.getByText('No library items in me match “no match”.')).toBeInTheDocument();
    await user.clear(search);
    expect(screen.getByRole("heading", { name: "interview-prep" })).toBeInTheDocument();
  });

  it("filters courses and cheatsheets by unordered words across searchable fields", async () => {
    const user = userEvent.setup();
    const course = { ...alpha, title: "System Design Interview Atlas", company: "Initrode" };
    const sheet = { ...beta, title: "System Design Interview Atlas", tags: ["Architecture"] };
    render(<MantineProvider><Harness data={{ ...initial, items: [course, sheet] }} /></MantineProvider>);
    const search = screen.getByRole("textbox", { name: /Filter courses/ });
    for (const query of ["system design atlas", "SYSTEM atlas", "atlas system", "ＡＴＬＡＳ system"]) {
      await user.clear(search); await user.type(search, query);
      expect(screen.getByRole("button", { name: /System Design Interview Atlas 2\/5 · 30m left, 2 of 5/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "System Design Interview Atlas" })).toBeInTheDocument();
    }
    await user.clear(search); await user.type(search, "initrode system design");
    expect(screen.getByRole("button", { name: /System Design Interview Atlas .*2 of 5/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "System Design Interview Atlas" })).not.toBeInTheDocument();
    await user.clear(search); await user.type(search, "architecture atlas");
    expect(screen.getByRole("button", { name: "System Design Interview Atlas" })).toBeInTheDocument();
    await user.clear(search); await user.type(search, "system atlas missing");
    expect(screen.getByText(/No library items match/)).toBeInTheDocument();
  });

  it("rejects a pointer drop across status sections", async () => { render(<MantineProvider><Harness initialExpanded={{ [statusExpansionKey("done")]: true }} /></MantineProvider>); const source = screen.getByRole("button", { name: alphaAccessibleName }); const target = screen.getByRole("button", { name: "Done item" }).closest("li")!; source.setPointerCapture = vi.fn(); Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target }); const send = (type: string, x: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); fireEvent(source, event); }; send("pointerdown", 0); send("pointermove", 10); send("pointerup", 10); expect(await screen.findByRole("alert")).toHaveTextContent("across status sections"); expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/move"), expect.anything()); });

  it("keeps positional moves correct when hidden statuses occupy persisted positions", () => { const activeSecond = { ...alpha, id: "active-second", title: "Active second", manifestTitle: "Active second", position: 4 }; const items = [{ ...alpha, position: 0 }, { ...done, categoryId: "uncategorized", position: 1 }, { ...archived, categoryId: "uncategorized", position: 2 }, { ...beta, position: 3 }, activeSecond]; expect(positionalDropIndex([alpha, beta, activeSecond], alpha, activeSecond, "before")).toBe(1); expect(persistedMoveIndex(items, alpha, "uncategorized", 1)).toBe(3); expect(persistedMoveIndex(items, activeSecond, "uncategorized", 0)).toBe(0); });
});

describe("LibraryPanel actions", () => {
  it("edits and clears deadline and tier overrides, announces changes and restores focus", async () => {
    const user = userEvent.setup(); const manifest = { ...alpha, manifestDeadline: '2027-01-15', deadline: '2027-01-15', manifestTier: 2 as const, tier: 2 as const }; let current: LibrarySnapshot = { ...initial, items: [manifest, beta] };
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); current = { ...current, items: current.items.map((item) => item.id !== 'alpha' ? item : { ...item, deadlineOverride: body.deadlineCleared ? null : body.deadline ?? undefined, tierOverride: body.tierCleared ? null : body.tier ?? undefined, deadline: body.deadlineCleared ? undefined : body.deadline ?? manifest.manifestDeadline, tier: body.tierCleared ? undefined : body.tier ?? manifest.manifestTier }) }; return new Response(JSON.stringify(current)); }));
    render(<MantineProvider><Harness data={current} /></MantineProvider>);
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' }));
    expect(await screen.findByRole('dialog', { name: 'Edit deadline and tier' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Deadline'), { target: { value: '2026-12-01' } });
    await user.click(await screen.findByLabelText('Interview priority tier', { selector: 'input' })); await user.click(await screen.findByRole('option', { name: 'Tier 1 — highest priority' })); await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(`Updated deadline and tier for ${alpha.title}.`)).toBeInTheDocument();
    const updated = await screen.findByRole('button', { name: /Alpha course.*Interview priority tier 1/ }); expect(within(updated).getByText('T1')).toBeInTheDocument(); await waitFor(() => expect(updated).toHaveFocus());
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); expect(await screen.findByText(/Manifest default: 2027-01-15/)).toBeInTheDocument(); await user.click(screen.getByRole('button', { name: 'Reset to manifest defaults' }));
    expect(await screen.findByText(`Reset deadline and tier for ${alpha.title} to manifest defaults.`)).toBeInTheDocument(); expect(await screen.findByRole('button', { name: /Alpha course.*Interview priority tier 2/ })).toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith('/api/library/items/course/alpha/schedule', expect.objectContaining({ body: JSON.stringify({ deadline: null, tier: null }) }));
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' }));
    await user.click(await screen.findByRole('button', { name: 'Clear deadline' })); expect(screen.getByRole('button', { name: 'No deadline' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByLabelText('Interview priority tier', { selector: 'input' })); await user.click(await screen.findByRole('option', { name: 'No tier' })); await user.click(screen.getByRole('button', { name: 'Save' }));
    const cleared = await screen.findByRole('button', { name: alphaAccessibleName }); expect(within(cleared).queryByText(/^T[123]$/)).not.toBeInTheDocument(); expect(cleared.querySelector('.deadline-row-line')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith('/api/library/items/course/alpha/schedule', expect.objectContaining({ body: JSON.stringify({ deadline: null, tier: null, deadlineCleared: true, tierCleared: true }) }));
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); expect(await screen.findByRole('button', { name: 'No deadline' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByLabelText('Interview priority tier', { selector: 'input' })).toHaveValue('No tier');
    await user.click(screen.getByRole('button', { name: 'Use manifest deadline' })); await user.click(screen.getByRole('button', { name: 'Save' }));
    const deadlineOnly = await screen.findByRole('button', { name: /Alpha course.*Jan 15/ }); expect(deadlineOnly.querySelector('.deadline-row-line')).toBeInTheDocument(); expect(within(deadlineOnly).queryByText(/^T[123]$/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); await user.click(await screen.findByRole('button', { name: 'No deadline' })); await user.click(screen.getByLabelText('Interview priority tier', { selector: 'input' })); await user.click(await screen.findByRole('option', { name: 'Use manifest default (tier 2)' })); await user.click(screen.getByRole('button', { name: 'Save' }));
    const tierOnly = await screen.findByRole('button', { name: /Alpha course.*Interview priority tier 2/ }); expect(tierOnly.querySelector('.deadline-row-line')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); await user.click(await screen.findByRole('button', { name: 'Reset to manifest defaults' }));
    expect(await screen.findByRole('button', { name: /Alpha course.*Interview priority tier 2/ })).toBeInTheDocument();
  });
  it('explains why tiers are unavailable and does not offer editing for cheatsheets', async () => {
    const user = userEvent.setup(); render(<MantineProvider><Harness data={{ ...initial, items: [{ ...alpha, company: undefined }, beta] }} /></MantineProvider>);
    await user.click(screen.getByRole('button', { name: 'Actions for Beta' })); expect(screen.queryByRole('menuitem', { name: 'Edit deadline and tier…' })).not.toBeInTheDocument(); await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' })); expect(await screen.findByLabelText('Interview priority tier', { selector: 'input' })).toBeDisabled(); expect(screen.getByText('Priority tiers require a course with a company.')).toBeInTheDocument();
  });
  it('keeps the dialog open with an inline error and preserves an unchanged datetime', async () => {
    const user = userEvent.setup(); const datetime = '2027-01-15T10:30+05:30';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Could not save schedule' }), { status: 400 })));
    render(<MantineProvider><Harness data={{ ...initial, items: [{ ...alpha, deadline: datetime, deadlineOverride: datetime }, beta] }} /></MantineProvider>);
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' }));
    await user.click(await screen.findByRole('button', { name: 'Save' })); expect(await screen.findByRole('alert')).toHaveTextContent('Could not save schedule');
    expect(screen.getByRole('dialog', { name: 'Edit deadline and tier' })).toBeInTheDocument(); expect(fetch).toHaveBeenCalledWith('/api/library/items/course/alpha/schedule', expect.objectContaining({ body: JSON.stringify({ deadline: datetime, tier: null }) }));
  });
  it('associates invalid date errors with the input and explains an absent tier default', async () => {
    const user = userEvent.setup(); render(<MantineProvider><Harness /></MantineProvider>);
    await user.click(screen.getByRole('button', { name: `Actions for ${alpha.title}` })); await user.click(await screen.findByRole('menuitem', { name: 'Edit deadline and tier…' }));
    const date = await screen.findByLabelText('Deadline'); const tier = screen.getByLabelText('Interview priority tier', { selector: 'input' });
    expect(tier).toHaveValue('Use manifest default (none)'); expect(screen.getByText('Tier 1 is highest priority.')).toBeInTheDocument();
    Object.defineProperty(date, 'validity', { configurable: true, value: { badInput: true } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const error = screen.getByText('Enter a valid calendar date.'); expect(date).toHaveAttribute('aria-invalid', 'true'); expect(date.getAttribute('aria-describedby')?.split(' ')).toContain(error.id); expect(fetch).not.toHaveBeenCalled();
    Object.defineProperty(date, 'validity', { configurable: true, value: { badInput: false } }); fireEvent.change(date, { target: { value: '2027-01-15' } }); expect(screen.queryByText('Enter a valid calendar date.')).not.toBeInTheDocument();
  });
  it("removes the header category button while retaining category-menu creation", async () => { const user = userEvent.setup(); render(<MantineProvider><Harness /></MantineProvider>); expect(screen.queryByRole("button", { name: "New category" })).not.toBeInTheDocument(); await user.click(screen.getByRole("button", { name: "Actions for category Uncategorized" })); await user.click(await screen.findByRole("menuitem", { name: "New category" })); await user.type(await screen.findByRole("textbox", { name: "Category name" }), "Interview prep test"); await user.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument()); expect(screen.getByRole("heading", { name: "Interview prep test" })).toBeInTheDocument(); });
  it("names courses with progress while cheatsheets stay title-only", async () => { const open = vi.fn(); const user = userEvent.setup(); render(<MantineProvider><Harness onOpen={open} /></MantineProvider>); const button = screen.getByRole("button", { name: alphaAccessibleName }); expect(within(button).getByTitle(alpha.title)).toBeInTheDocument(); expect(within(button).getByText("2/5 · 30m left")).toBeInTheDocument(); expect(within(button).queryByRole("progressbar")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument(); await user.click(button); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha" })); await user.type(screen.getByRole("textbox", { name: /Filter courses/ }), "backend"); expect(screen.getByRole("button", { name: alphaAccessibleName })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument(); });
  it("supports F2 rename and menu movement", async () => { const user = userEvent.setup(); render(<MantineProvider><Harness /></MantineProvider>); const title = screen.getByRole("button", { name: alphaAccessibleName }); title.focus(); await user.keyboard("{F2}"); const input = screen.getByRole("textbox", { name: `Rename ${alpha.title}` }); await user.clear(input); await user.type(input, "Priority Alpha{Enter}"); await waitFor(() => expect(screen.getByRole("button", { name: "Priority Alpha 2/5 · 30m left, 2 of 5 drills complete, 30 minutes left" })).toHaveFocus()); await user.click(screen.getByRole("button", { name: "Actions for Beta" })); await user.click(await screen.findByRole("menuitem", { name: "Move up" })); expect(fetch).toHaveBeenCalledWith("/api/library/items/cheatsheet/beta/move", expect.objectContaining({ method: "PUT" })); });
  it("preserves manual category and item priority", () => { expect(sortUpNext([beta, alpha], initial.categories).map((item) => item.id)).toEqual(["alpha", "beta"]); expect(statusDropAllowed(alpha, "active")).toBe(true); expect(statusDropAllowed(alpha, "done")).toBe(false); });
});

describe("LibraryPanel course repositories", () => {
  const repoAlpha = { ...alpha, repo: "me/interview-courses" };
  const repoCheatsheet = { ...beta, repo: repoAlpha.repo };
  const repoCourse = { ...alpha, id: "gamma", repo: "example/second-courses", title: "Gamma course", manifestTitle: "Gamma course", position: 2 };
  const repoCourseTwo = { ...repoCourse, id: "delta", title: "Delta course", manifestTitle: "Delta course", position: 3 };
  const trigger = (repo: string, workspace = false) => screen.getByRole('button', { name: `${workspace ? 'Workspace' : 'Course repository'}: ${repo}, change ${workspace ? 'workspace' : 'course repository'}` });
  it('uses the single repository as the header and keeps header actions on the same row', async () => {
    const user = userEvent.setup(); render(<MantineProvider><LibraryPanel headerActions={<button>Header action</button>} snapshot={{ ...initial, items: [repoAlpha, repoCheatsheet], courseRepos: [repoAlpha.repo] }} courseRepo={repoAlpha.repo} onOpen={() => {}} onChange={() => {}} /></MantineProvider>);
    const repo = trigger(repoAlpha.repo), header = repo.closest('.library-header')!, filter = screen.getByRole('textbox', { name: /Filter courses/ });
    expect(screen.getByRole('navigation', { name: 'Library' })).toContainElement(header);
    expect(screen.queryByRole('heading', { name: 'Library' })).not.toBeInTheDocument();
    expect(repo).toHaveTextContent(repoAlpha.repo); expect(repo).toHaveAttribute('title', repoAlpha.repo); expect(repo).toHaveAttribute('aria-haspopup', 'menu'); expect(repo).toHaveAttribute('aria-expanded', 'false');
    expect(repo.querySelector('svg')).toHaveClass('tabler-icon-chevron-down'); expect(header).toContainElement(screen.getByRole('button', { name: 'Header action' })); expect(header).not.toContainElement(filter);
    await user.click(repo); expect(await screen.findByRole('menuitemradio', { name: repoAlpha.repo })).toHaveAttribute('aria-checked', 'true');
  });
  it('shows cheatsheets only for their owning repository', async () => {
    const user = userEvent.setup(), emptyRepo = 'me/sam-courses';
    function RepoHarness() { const [repo, setRepo] = useState(repoAlpha.repo); return <LibraryPanel snapshot={{ ...initial, items: [repoAlpha, repoCheatsheet], courseRepos: [repoAlpha.repo, emptyRepo] }} courseRepo={repo} onCourseRepoChange={setRepo} onOpen={() => {}} onChange={() => {}} />; }
    render(<MantineProvider><RepoHarness /></MantineProvider>); expect(screen.getByRole('button', { name: alphaAccessibleName })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
    await user.click(trigger(repoAlpha.repo)); await user.click(await screen.findByRole('menuitemradio', { name: emptyRepo })); expect(trigger(emptyRepo)).toHaveTextContent(emptyRepo);
    expect(screen.queryByRole('button', { name: alphaAccessibleName })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument(); expect(screen.getByText(`No courses are available from ${emptyRepo}.`)).toBeInTheDocument();
  });
  it('keeps a long workspace name accessible while the header truncates it', () => {
    const repo = 'extraordinary-team-with-an-unusually-long-workspace-name/systems-and-practice-repository';
    render(<MantineProvider><LibraryPanel snapshot={{ ...initial, workspaceMode: true, courseRepos: [repo] }} courseRepo={repo} onOpen={() => {}} onChange={() => {}} /></MantineProvider>);
    const button = trigger(repo, true); expect(button).toHaveAttribute('title', repo); expect(button).toHaveTextContent(repo);
    const label = button.querySelector('.mantine-Button-label')!;
    expect(getComputedStyle(label).display).toBe('block'); expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
    const css = document.querySelector('.library-repo-heading')?.closest('nav')?.textContent ?? '';
    expect(css).toContain('text-overflow:ellipsis;white-space:nowrap');
  });
  it('opens and selects by keyboard and restores focus on Escape', async () => {
    const user = userEvent.setup(); function RepoHarness() { const [repo, setRepo] = useState(repoAlpha.repo); return <LibraryPanel snapshot={{ ...initial, workspaceMode: true, items: [repoAlpha, repoCourse], courseRepos: [repoAlpha.repo, repoCourse.repo] }} courseRepo={repo} onCourseRepoChange={setRepo} onOpen={() => {}} onChange={() => {}} />; }
    render(<MantineProvider><RepoHarness /></MantineProvider>); const button = trigger(repoAlpha.repo, true); button.focus(); await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true'); const first = await screen.findByRole('menuitemradio', { name: repoAlpha.repo }); expect(first).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}'); expect(screen.getByRole('menuitemradio', { name: repoCourse.repo })).toHaveFocus(); await user.keyboard('{Enter}'); expect(trigger(repoCourse.repo, true)).toBeInTheDocument();
    const updated = trigger(repoCourse.repo, true); await user.click(updated); await user.keyboard('{Escape}'); await waitFor(() => expect(updated).toHaveFocus()); expect(updated).toHaveAttribute('aria-expanded', 'false');
  });
  it('announces repository changes with the filtered course count', async () => {
    const user = userEvent.setup(); function RepoHarness() { const [repo, setRepo] = useState(repoAlpha.repo); return <LibraryPanel snapshot={{ ...initial, items: [repoAlpha, repoCourse, repoCourseTwo], courseRepos: [repoAlpha.repo, repoCourse.repo] }} courseRepo={repo} onCourseRepoChange={setRepo} onOpen={() => {}} onChange={() => {}} />; }
    render(<MantineProvider><RepoHarness /></MantineProvider>); await user.type(screen.getByRole('textbox', { name: /Filter courses/ }), 'Gamma'); await user.click(trigger(repoAlpha.repo)); await user.click(await screen.findByRole('menuitemradio', { name: repoCourse.repo })); expect(await screen.findByText('Course repository changed to example/second-courses. Showing 1 course.')).toBeInTheDocument();
  });
});
