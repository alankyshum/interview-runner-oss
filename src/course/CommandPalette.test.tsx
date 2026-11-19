import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CourseShell from "./CourseShell";
import CommandPalette from "./CommandPalette";
import { CourseRunnerHotkeysProvider, HOTKEYS_STORAGE_KEY } from "./appHotkeys";
import type { LibraryCategory, LibraryItem } from "./LibraryPanel";
import { getUiState } from "./uiState";

const items = ["alpha", "beta", "gamma", "delta"].map((id) => ({ kind: "course", id, repo: `repos/${id}`, categoryId: "uncategorized", position: 0, status: "active", statusExplicit: false, manifestTitle: `${id} course`, title: `${id} course`, tags: [], doneDrills: 0, totalDrills: 0, remainingMinutes: 0, inProgress: false }));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
beforeEach(() => {
  localStorage.clear(); history.replaceState({}, "", "/");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/library") return json({ categories: [{ id: "uncategorized", name: "Uncategorized", position: 0, fixed: true }], items, courseRepos: ["repos/alpha", "repos/beta"] });
    if (url === "/api/courses") return json(items.map((item) => ({ ...item, chapterCount: 0, drillCount: 0 })));
    if (url.startsWith("/api/courses/")) return json({ id: url.split("/").at(-1), title: "Selected course", chapters: [] });
    if (url === "/api/cheatsheets") return json([]);
    return json({});
  }));
});

const renderShell = () => render(<MantineProvider><CourseShell /></MantineProvider>);
const key = (target: Element, code = "KeyK", value = "k") => fireEvent.keyDown(target, { key: value, code, metaKey: true });
const openPalette = async () => { key(document.body); return within(await screen.findByRole("dialog", { name: "Command palette" })); };
const paletteItem = (id: string, title: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({ kind: "course", id, categoryId: "other", position: 0, status: "active", statusExplicit: false, manifestTitle: title, title, tags: [], doneDrills: 0, totalDrills: 0, remainingMinutes: 0, inProgress: false, ...extra });
const renderPalette = (courses: LibraryItem[], cheatsheets: LibraryItem[], categories: LibraryCategory[], repositories: string[] = []) => {
  const onOpenCourse = vi.fn(); const onOpenCheatsheet = vi.fn();
  render(<MantineProvider><CourseRunnerHotkeysProvider><CommandPalette menu={[]} courses={courses} cheatsheets={cheatsheets} categories={categories} repositories={repositories} onOpenCourse={onOpenCourse} onOpenCheatsheet={onOpenCheatsheet} onSwitchRepo={vi.fn()} /></CourseRunnerHotkeysProvider></MantineProvider>);
  return { onOpenCourse, onOpenCheatsheet };
};

describe("command palette", () => {
  it('opens the design system gallery in a separate tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = userEvent.setup(); renderShell();
    const dialog = await openPalette();
    await user.type(dialog.getByRole('combobox', { name: 'Search commands' }), 'design system');
    await user.click(dialog.getByRole('option', { name: /Open design system gallery/ }));
    expect(open).toHaveBeenCalledWith('/design-system', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
  it('uses effective library deadlines to order the initial course suggestions', async () => {
    const scheduled = items.map((item, index) => ({ ...item, position: index, ...(item.id === 'delta' ? { deadline: '2027-01-01', deadlineOverride: '2027-01-01' } : {}) }));
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/library') return json({ categories: [{ id: 'uncategorized', name: 'Uncategorized', position: 0, fixed: true }], items: scheduled, courseRepos: [] });
      if (url === '/api/courses') return json(scheduled.map((item) => ({ ...item, chapterCount: 0, drillCount: 0 })));
      if (url.startsWith('/api/courses/')) return json({ id: url.split('/').at(-1), title: 'Selected course', chapters: [] });
      if (url === '/api/cheatsheets') return json([]);
      return json({});
    }));
    renderShell(); await screen.findByRole('button', { name: /delta course .*0 of 0 drills/ }); const dialog = await openPalette();
    const group = dialog.getByRole('group', { name: /Courses/ });
    expect(within(group).getAllByRole('option').map((option) => option.querySelector('.mantine-Spotlight-actionLabel')?.textContent?.trim())).toEqual(['delta course', 'alpha course', 'beta course']);
  });
  it('ranks titles, category and tag quality, then other and fuzzy matches without disturbing ties', async () => {
    const user = userEvent.setup();
    const categories: LibraryCategory[] = [
      { id: 'exact', name: 'Alpha', position: 0, fixed: false },
      { id: 'prefix', name: 'Alphabet', position: 1, fixed: false },
      { id: 'substring', name: 'Betalpha', position: 2, fixed: false },
    ];
    const courses = [
      paletteItem('exact-title', 'Alpha'), paletteItem('prefix-title', 'Alpha Guide'), paletteItem('word-title', 'The Alpha Guide'),
      paletteItem('cat-exact', 'Category Exact', { categoryId: 'exact' }), paletteItem('tag-exact', 'Tagged Exact', { tags: ['Alpha'] }),
      paletteItem('cat-prefix', 'Category Prefix', { categoryId: 'prefix' }), paletteItem('tag-prefix', 'Tagged Prefix', { tags: ['Alphabet'] }),
      paletteItem('cat-sub', 'Category Substring', { categoryId: 'substring' }), paletteItem('tag-sub', 'Tagged Substring', { tags: ['Betalpha'] }),
      paletteItem('title-sub', 'Prealpha'), paletteItem('repo-match', 'Repository Match', { repo: 'example/alpha' }),
      paletteItem('fuzzy-title', 'Axlpxhxa'),
    ];
    renderPalette(courses, [], categories); const dialog = await openPalette();
    const search = dialog.getByRole('combobox', { name: 'Search commands' });
    await user.type(search, 'alpha');
    const group = dialog.getByRole('group', { name: 'Courses' });
    const options = within(group).getAllByRole('option');
    expect(options.map((option) => option.querySelector('.mantine-Spotlight-actionLabel')?.textContent?.trim())).toEqual([
      'Alpha', 'Alpha Guide', 'The Alpha Guide', 'Category Exact', 'Tagged Exact', 'Category Prefix', 'Tagged Prefix', 'Category Substring', 'Tagged Substring', 'Prealpha', 'Repository Match', 'Axlpxhxa',
    ]);
    await waitFor(() => expect(search).toHaveAttribute('aria-activedescendant', options[0].id));
    fireEvent.keyDown(search, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(search).toHaveAttribute('aria-activedescendant', options[1].id));
    const category = within(group).getByRole('option', { name: 'Courses: Category Exact, category: Alpha' });
    expect(category).toHaveTextContent('category: Alpha');
    const tag = within(group).getByRole('option', { name: 'Courses: Tagged Exact, tag: Alpha' });
    expect(tag).toHaveTextContent('tag: Alpha');
    expect(within(group).getByRole('option', { name: 'Courses: Repository Match, repository: example/alpha' })).toHaveTextContent('repository: example/alpha');
  });

  it('surfaces archived cheatsheets and courses by category and orders groups by their best match', async () => {
    const user = userEvent.setup();
    const categories: LibraryCategory[] = [{ id: 'study', name: 'Alpha', position: 0, fixed: false }];
    const course = paletteItem('course', 'Graph practice', { categoryId: 'study' });
    const exactSheet = paletteItem('sheet', 'Alpha', { kind: 'cheatsheet', categoryId: 'study' });
    const archived = paletteItem('archived-sheet', 'Field Notes', { kind: 'cheatsheet', categoryId: 'study', status: 'archived' });
    const { onOpenCheatsheet } = renderPalette([course], [exactSheet, archived], categories, ['team/alpha-repo']);
    const dialog = await openPalette(); await user.type(dialog.getByRole('combobox', { name: 'Search commands' }), 'alpha');
    const list = dialog.getByRole('listbox', { name: 'Command results' });
    const groups = within(list).getAllByRole('group').map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent);
    expect(groups).toEqual(['Cheatsheets', 'Repositories', 'Courses']);
    expect(within(list).getByRole('option', { name: 'Courses: Graph practice, category: Alpha' })).toHaveTextContent('category: Alpha');
    const archivedOption = within(list).getByRole('option', { name: 'Cheatsheets: Field Notes, category: Alpha' });
    expect(archivedOption).toHaveTextContent('category: Alpha');
    await user.click(archivedOption);
    expect(onOpenCheatsheet).toHaveBeenCalledWith(archived);
  });

  it('preserves company and role matching with accessible match reasons', async () => {
    const user = userEvent.setup();
    renderPalette([paletteItem('role', 'Graph practice', { company: 'Acme', role: 'Staff Engineer' })], [], []);
    const dialog = await openPalette(); const search = dialog.getByRole('combobox', { name: 'Search commands' });
    await user.type(search, 'acme'); expect(dialog.getByRole('option', { name: 'Courses: Graph practice, company: Acme' })).toHaveTextContent('company: Acme');
    await user.clear(search); await user.type(search, 'staff'); expect(dialog.getByRole('option', { name: 'Courses: Graph practice, role: Staff Engineer' })).toHaveTextContent('role: Staff Engineer');
  });
  it('includes the visible match reason and repository in the option name', async () => {
    const user = userEvent.setup();
    renderPalette([paletteItem('role', 'Graph practice', { repo: 'team/one', tags: ['Algorithms'] })], [], []);
    const dialog = await openPalette();
    await user.type(dialog.getByRole('combobox', { name: 'Search commands' }), 'algorithms');
    expect(dialog.getByRole('option', { name: 'Courses: Graph practice, tag: Algorithms · team/one' })).toHaveTextContent('tag: Algorithms');
  });
  it('matches words in any order across fields and ranks title matches above metadata', async () => {
    const user = userEvent.setup();
    renderPalette([
      paletteItem('metadata', 'Other course', { tags: ['system design atlas'] }),
      paletteItem('scattered', 'System Design Interview Atlas', { company: "Initrode" }),
      paletteItem('prefix', 'System Design Atlas Handbook'),
      paletteItem('exact', 'System Design Atlas'),
    ], [paletteItem('sheet', 'System Design Interview Atlas', { kind: 'cheatsheet', tags: ['Architecture'] })], []);
    const dialog = await openPalette(); const search = dialog.getByRole('combobox', { name: 'Search commands' });
    await user.type(search, 'system design atlas');
    const group = dialog.getByRole('group', { name: 'Courses' });
    expect(within(group).getAllByRole('option').map((option) => option.querySelector('.mantine-Spotlight-actionLabel')?.textContent?.trim())).toEqual(['System Design Atlas', 'System Design Atlas Handbook', 'System Design Interview Atlas', 'Other course']);
    expect(dialog.getByRole('option', { name: 'Cheatsheets: System Design Interview Atlas' })).toBeInTheDocument();
    for (const query of ['SYSTEM atlas', 'atlas system', 'ＡＴＬＡＳ system']) {
      await user.clear(search); await user.type(search, query);
      expect(dialog.getByRole('option', { name: 'Courses: System Design Interview Atlas' })).toBeInTheDocument();
    }
    await user.clear(search); await user.type(search, 'initrode system design');
    expect(dialog.getByRole('option', { name: 'Courses: System Design Interview Atlas, company: Initrode' })).toBeInTheDocument();
    await user.clear(search); await user.type(search, 'architecture atlas');
    expect(dialog.getByRole('option', { name: 'Cheatsheets: System Design Interview Atlas, tag: Architecture' })).toBeInTheDocument();
    await user.clear(search); await user.type(search, 'system atlas missing');
    expect(dialog.getByRole('status')).toHaveTextContent('Nothing found');
  });
  it('keeps long role hints compact and does not produce scattered fuzzy matches for punctuated tags', async () => {
    const user = userEvent.setup(); const longRole = `${'Platform work '.repeat(15)}Kubernetes reliability ${'engineering '.repeat(15)}`;
    renderPalette([
      paletteItem('role', 'Graph practice', { role: longRole }),
      paletteItem('tag', 'Console Coding', { tags: ['no-ai'] }),
      paletteItem('unrelated', 'Blind Coding', { tags: ['essential-code-practise'] }),
    ], [], []);
    const dialog = await openPalette(); const search = dialog.getByRole('combobox', { name: 'Search commands' });
    await user.type(search, 'kubernetes');
    const role = dialog.getByRole('option', { name: /Courses: Graph practice, role: .*Kubernetes/ });
    expect(role.getAttribute('aria-label')!.length).toBeLessThan(150);
    expect(role).toHaveTextContent('Kubernetes');
    await user.clear(search); await user.type(search, 'no-ai');
    expect(dialog.getAllByRole('option')).toHaveLength(1);
    expect(dialog.getByRole('option', { name: 'Courses: Console Coding, tag: no-ai' })).toBeInTheDocument();
  });
  it("opens outside inputs, shows groups, filters, and restores focus on Escape", async () => {
    const user = userEvent.setup(); renderShell();
    await screen.findByRole("navigation", { name: "Library" });
    const trigger = screen.getByRole("button", { name: "Sidebar and theme controls" }); trigger.focus(); key(trigger);
    const dialog = within(await screen.findByRole("dialog", { name: "Command palette" }));
    const list = within(dialog.getByRole("listbox", { name: "Command results" }));
    expect(list.getByRole("group", { name: "Sidebar and theme controls" })).toBeInTheDocument();
    expect(list.getByRole("group", { name: "Courses · search all 4" })).toBeInTheDocument();
    expect(list.getByRole("group", { name: "Repositories" })).toBeInTheDocument();
    await user.type(dialog.getByRole("combobox", { name: "Search commands" }), "nonexistent");
    expect(dialog.getByRole("status")).toHaveTextContent("Nothing found");
    await user.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("leaves input and Monaco chords untouched and honors customized binding", async () => {
    localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify({ "palette.open": "Mod+[KeyP]" })); renderShell();
    const input = await screen.findByRole("textbox", { name: /Filter courses/ }); input.focus(); key(input, "KeyP", "p");
    const editor = document.createElement("div"); editor.className = "monaco-editor"; editor.tabIndex = 0; document.body.append(editor); editor.focus();
    const event = new KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: true, bubbles: true, cancelable: true }); editor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument(); editor.remove();
    key(document.body); expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    key(document.body, "KeyP", "p"); expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });
  it('lets Excalidraw receive Mod+K while the app palette handles it elsewhere', async () => {
    renderShell(); await screen.findByRole('navigation', { name: 'Library' });
    const canvas = document.createElement('div'); canvas.className = 'excalidraw'; canvas.tabIndex = 0; document.body.append(canvas); canvas.focus();
    const reached = vi.fn(); canvas.addEventListener('keydown', reached);
    const inside = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true }); canvas.dispatchEvent(inside);
    expect(reached).toHaveBeenCalledOnce(); expect(inside.defaultPrevented).toBe(false); expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    canvas.remove(); key(document.body); expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it("does not consume Cmd+K in a text input, textarea or Monaco editor", async () => {
    renderShell(); const input = await screen.findByRole("textbox", { name: /Filter courses/ });
    const textarea = document.createElement("textarea");
    const editor = document.createElement("div"); editor.className = "monaco-editor"; editor.tabIndex = 0;
    document.body.append(textarea, editor);
    for (const element of [input, textarea, editor]) {
      element.focus();
      const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    }
    textarea.remove(); editor.remove();
  });

  it("opens a course through the library selection path", async () => {
    const user = userEvent.setup(); renderShell(); await screen.findByRole("navigation", { name: "Library" });
    const dialog = await openPalette(); await user.click(dialog.getByRole("option", { name: /beta course/ }));
    await waitFor(() => expect(location.search).toContain("course=beta"));
    await waitFor(() => expect(getUiState().courseRepo).toBe("repos/beta"));
    expect(fetch).toHaveBeenCalledWith("/api/courses/beta", expect.objectContaining({ headers: { "X-Interview-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone } }));
  });

  it("searches courses beyond the initial preview", async () => {
    const user = userEvent.setup(); renderShell(); await screen.findByRole("navigation", { name: "Library" });
    const dialog = await openPalette();
    expect(dialog.queryByRole("option", { name: /delta course/ })).not.toBeInTheDocument();
    await user.type(dialog.getByRole("combobox", { name: "Search commands" }), "delta");
    await user.click(dialog.getByRole("option", { name: /delta course/ }));
    await waitFor(() => expect(location.search).toContain("course=delta"));
  });

  it("switches repositories and toggles the same library setting as the menu", async () => {
    const user = userEvent.setup(); renderShell(); await screen.findByRole("navigation", { name: "Library" });
    let dialog = await openPalette(); await user.click(dialog.getByRole("option", { name: "Repositories: beta repos/beta" }));
    await waitFor(() => expect(getUiState().courseRepo).toBe("repos/beta"));
    dialog = await openPalette(); await user.click(dialog.getByRole("option", { name: /Hide library/ }));
    await waitFor(() => expect(getUiState().sidebarCollapsed).toBe(true));
    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Show library/ }));
    expect(getUiState().sidebarCollapsed).toBe(false);
  });

  it("supports arrow-key selection and opening keyboard shortcuts", async () => {
    const user = userEvent.setup(); renderShell(); await screen.findByRole("navigation", { name: "Library" });
    const dialog = await openPalette();
    const search = dialog.getByRole("combobox", { name: "Search commands" });
    await user.click(search); await user.type(search, "Keyboard shortcuts");
    fireEvent.keyDown(search, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    expect(await screen.findByRole("dialog", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
  });

  it("keeps combobox selection, active descendant and grouped options synchronized", async () => {
    const user = userEvent.setup(); renderShell(); await screen.findByRole("navigation", { name: "Library" });
    const dialog = await openPalette();
    const search = dialog.getByRole("combobox", { name: "Search commands" });
    const list = dialog.getByRole("listbox", { name: "Command results" });
    expect(search).toHaveAttribute("placeholder", "Search…");
    expect(search).toHaveAccessibleDescription("Search commands, courses, cheatsheets, and repositories");
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(search).toHaveAttribute("aria-controls", list.id);
    expect(search).not.toHaveAttribute("aria-activedescendant");
    await user.click(search);
    const options = within(list).getAllByRole("option");
    expect(options[0].style.minHeight).toBe("2.75rem");
    expect(options[0].querySelector("kbd")?.style.color).toBe("var(--ir-color-text)");
    fireEvent.keyDown(search, { key: "ArrowDown", code: "ArrowDown" });
    expect(search).toHaveFocus(); await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", options[0].id));
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "ArrowDown", code: "ArrowDown" });
    await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", options[1].id));
    expect(options[0]).toHaveAttribute("aria-selected", "false"); expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.type(search, "library");
    const library = await dialog.findByRole("option", { name: /Hide library/ });
    expect(library.id).toBe(options[0].id);
    await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", library.id));
    await user.clear(search);
    await user.type(search, "delta");
    const result = await dialog.findByRole("option", { name: /delta course/ });
    await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", result.id));
    expect(result).toHaveAttribute("aria-selected", "true");
    await user.clear(search); await user.type(search, "not-found");
    expect(dialog.getByRole("status")).toHaveTextContent("Nothing found");
    expect(search).not.toHaveAttribute("aria-activedescendant");
    expect(within(list).queryByRole("option")).not.toBeInTheDocument();
  });
});
