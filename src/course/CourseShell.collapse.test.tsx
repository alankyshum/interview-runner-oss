import { MantineProvider } from "@mantine/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'demo' && ['drill-1', 'drill-2', 'drill-3'].includes(drill) }; });
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ instructions, watcherResult, preview }: any) => { const url = String(instructions).match(/https?:\/\/\S+/)?.[0]; return <section role="region" aria-label="Code practice workspace" data-testid="coding-workspace-columns"><div data-testid="instruction-pane">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : instructions}</div>{preview}<button aria-label="Toggle Test results" /><div role="region" aria-label="Results">{watcherResult?.stale && <span>Tests have not run since this drill changed.</span>}{watcherResult?.tests?.map((test: any) => <span key={test.name}>{test.name}</span>)}</div></section>; },
}));
import { getUiState } from "./uiState";

const manifest = {
  id: "demo",
  title: "Demo Course",
  chapters: [
    {
      id: "chapter-1",
      title: "Chapter One",
      drills: [
        { contentType: "reading", id: "drill-1", title: "First Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/hooli-growth-loop/drill-1.ts", outlinePath: "outlines/demo/drill-1.json", instructions: "Build it." },
        { contentType: "reading", id: "drill-2", title: "Second Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/hooli-growth-loop/drill-2.ts", outlinePath: "outlines/demo/drill-2.json", instructions: "Build it too." },
        { testPath: "drills/demo/fixture.test.ts", contentType: "coding", id: "project-preview-card", title: "Coding Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/demo/fixture.ts", instructions: "Solve it." },
      ],
    },
    {
      id: "chapter-2",
      title: "Chapter Two",
      drills: [{ contentType: "reading", id: "drill-3", title: "Third Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/hooli-growth-loop/drill-3.ts", outlinePath: "outlines/demo/drill-3.json", instructions: "And this." }],
    },
  ],
};

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
let outlineAvailable = false;
let courseManifest = manifest;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1920 });
  localStorage.clear();
  // The shell writes the selection into the URL, so tests must start from a clean one.
  window.history.replaceState({}, "", "/");
  document.documentElement.removeAttribute("data-mantine-color-scheme");
  outlineAvailable = false;
  courseManifest = manifest;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/cheatsheets") return json([{ id: "classic-75-book", title: "Classic 75 Book" }]);
    if (url === '/api/cheatsheets/classic-75-book/content') return json({ layout: null, sections: [{ id: 'one', html: '<h2>Sheet section</h2><p>Reference content</p>' }] });
    if (url === '/api/cheatsheets/classic-75-book') return json({ type: 'cheatsheet', id: 'classic-75-book', title: 'Classic 75 Book', chapters: [{ id: 'chapter', title: 'Sheet chapter', drills: [{ id: 'one', title: 'Sheet section', contentType: 'cheatsheet', headingLevel: 2, sourcePath: 'cheatsheets/classic-75-book/sections/one.html' }] }] });
    if (url === '/cheatsheets/classic-75-book/page.html') return Promise.resolve(new Response('', { status: 404 }));
    if (url === '/cheatsheets/classic-75-book/sections/one.html') return Promise.resolve(new Response('<p>Reference content</p>'));
    if (url === "/api/courses") return json([{ id: "demo", title: "Demo Course", chapterCount: 2, drillCount: 4 }]);
    if (url === "/api/courses/demo") return json(courseManifest);
    if (url.startsWith("/api/outlines/")) { const drillId = url.split("/").pop() ?? ""; return outlineAvailable ? json({ courseId: "demo", drillId, title: "Reader outline", nodes: [{ id: "intro", type: "claim", text: "Intro", children: [{ id: "detail", type: "claim", text: "Detail" }] }] }) : Promise.resolve(new Response(JSON.stringify({ error: `No outline for ${drillId}` }), { status: 404, headers: { "Content-Type": "application/json" } })); }
    return json({});
  }));
});

const renderShell = () => render(<MantineProvider><CourseShell /></MantineProvider>);

describe("panel collapse", () => {
  beforeEach(() => { outlineAvailable = true; });
  it("folds and restores an outline branch", async () => {
    const user = userEvent.setup();
    renderShell();
    const toggle = await screen.findByRole("button", { name: /Intro/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText('Detail')).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText('Detail')).not.toBeInTheDocument();
  });

  it("hides folded outline descendants from the accessibility tree", async () => {
    const user = userEvent.setup();
    renderShell();
    const toggle = await screen.findByRole("button", { name: /Intro/ });
    await user.click(toggle);
    expect(screen.getByRole('checkbox', { name: 'Mark Detail' })).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByRole('checkbox', { name: 'Mark Detail' })).not.toBeInTheDocument();
  });

  it("does not render a legacy preview panel for an outline lesson", async () => {
    renderShell();
    expect(await screen.findByTestId('outline-reader')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Toggle Preview' })).not.toBeInTheDocument();
  });

  it("updates reading progress when a leaf is checked", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole('button', { name: /Intro/ }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Mark Detail' });
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByLabelText('Reading progress: 100%')).toBeInTheDocument();
  });

  it("renders coding drills inside the sandbox workspace", async () => {
    window.history.replaceState({}, "", "/?course=demo&chapter=chapter-1&drill=project-preview-card");
    renderShell();
    expect(await screen.findByTestId("coding-workspace-columns")).toBeInTheDocument();
  });

  it("sends folded state through the reader state API", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole('button', { name: /Intro/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).includes('/api/outline-state/demo/drill-1/intro') && init?.method === 'PUT')).toBe(true));
  });
});

describe("sidebar collapse", () => {
  it('references the sidebar controls menu only while open', async () => {
    const user = userEvent.setup(); renderShell();
    const trigger = await screen.findByRole('button', { name: 'Sidebar and theme controls' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const id = trigger.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(screen.getByRole('menu')).toBe(document.getElementById(id!));
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
  });
  it("keeps floating controls in place and focused when the Library collapses", async () => {
    const user = userEvent.setup(); renderShell();
    const library = await screen.findByRole("navigation", { name: "Library" });
    const outline = await screen.findByRole("complementary", { name: "Course outline" });
    expect(outline).toHaveStyle({ height: "100%" });
    const heading = library.querySelector('.library-header')!;
    const trigger = screen.getByRole("button", { name: "Sidebar and theme controls" });
    expect(heading).not.toContainElement(trigger);
    expect(trigger.closest('[data-testid="sidebar-controls"]')).toHaveAttribute("data-floating", "true");
    await user.click(trigger);
    expect(screen.queryByRole('tooltip', { name: 'Sidebar and theme controls' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Hide library/ }));
    expect(screen.queryByRole("navigation", { name: "Library" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Course outline" })).toHaveStyle({ height: "100%" });
    const fallback = screen.getByRole("button", { name: "Sidebar and theme controls" });
    expect(fallback).toBe(trigger);
    expect(fallback.closest('[data-testid="sidebar-controls"]')).toHaveAttribute("data-floating", "true");
    expect(fallback.closest('[data-testid="sidebar-controls"]')).toHaveAttribute("data-opened", "true");
    await waitFor(() => expect(document.activeElement === fallback || Boolean(screen.getByRole("menu").contains(document.activeElement))).toBe(true));
    const showLibrary = screen.getByRole("menuitemcheckbox", { name: /Show library/ });
    act(() => showLibrary.focus());
    await user.keyboard('{Escape}'); await waitFor(() => expect(fallback).toHaveFocus());
    expect(fallback.closest('[data-testid="sidebar-controls"]')).not.toHaveAttribute("data-opened");
  });
  it("collapses only the course outline and persists that state across a remount", async () => {
    const user = userEvent.setup();
    outlineAvailable = true;
    const first = renderShell();
    await screen.findByRole("complementary", { name: "Course outline" });
    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    const toggle = await screen.findByRole("menuitemcheckbox", { name: /Hide course chapters/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    expect(getUiState().outlineCollapsed).toBe(true);
    expect(getUiState().sidebarCollapsed).toBe(false);
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Course outline" })).not.toBeInTheDocument();

    first.unmount();
    renderShell();
    await user.click(await screen.findByRole("button", { name: "Sidebar and theme controls" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Show course chapters/ })).toHaveAttribute("aria-checked", "false");
  });

  it("supports all four desktop visibility states without coupling the toggles", async () => {
    const user = userEvent.setup();
    outlineAvailable = true;
    renderShell();
    const library = await screen.findByRole("navigation", { name: "Library" });
    expect(screen.getByRole("complementary", { name: "Course outline" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Hide library/ }));
    expect(getUiState().sidebarCollapsed).toBe(true);
    expect(getUiState().outlineCollapsed).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Library" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Course outline" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Show library/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: /Hide course chapters/ })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("menuitemcheckbox", { name: /Hide course chapters/ }));
    expect(getUiState().sidebarCollapsed).toBe(true);
    expect(getUiState().outlineCollapsed).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Course outline" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Show course chapters/ })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /Show library/ }));
    expect(getUiState().sidebarCollapsed).toBe(false);
    expect(getUiState().outlineCollapsed).toBe(true);
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Course outline" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /Show course chapters/ }));
    expect(getUiState().sidebarCollapsed).toBe(false);
    expect(getUiState().outlineCollapsed).toBe(false);
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Course outline" })).toBeInTheDocument();
  });

  it("keeps the chapter navigator when the selected outline is unavailable", async () => {
    const user = userEvent.setup();
    outlineAvailable = false;
    renderShell();
    await screen.findByText('The declared reading outline is missing.');
    expect(screen.getByRole("complementary", { name: "Course outline" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Hide course chapters/ })).toHaveAttribute("aria-checked", "true");
  });

  it("hides the outline panel and toggle for a course with no navigable chapters or drills", async () => {
    const user = userEvent.setup();
    courseManifest = { ...manifest, chapters: [] };
    renderShell();
    await waitFor(() => expect(document.title).toBe("Demo Course · Courses"));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Course outline" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    await screen.findByRole("menuitemcheckbox", { name: /Hide library/ });
    expect(screen.queryByRole("menuitemcheckbox", { name: /course outline/i })).not.toBeInTheDocument();
  });

  it("shows and collapses the heading navigator for a cheatsheet view", async () => {
    const user = userEvent.setup();
    renderShell();
    const library = await screen.findByRole("navigation", { name: "Library" });
    await user.click(within(library).getByRole("button", { name: "Classic 75 Book" }));
    expect(await screen.findByRole('article', { name: 'Classic 75 Book' })).toHaveTextContent('Reference content');
    expect(screen.queryByRole("complementary", { name: "Course outline" })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Cheatsheet headings' })).toHaveStyle({ height: '100%' });
    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Hide library/ }));
    expect(screen.getByRole('complementary', { name: 'Cheatsheet headings' })).toHaveStyle({ height: '100%' });
    expect(screen.getByTestId('sidebar-controls')).toHaveAttribute('data-floating', 'true');
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Show library/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Hide course chapters/ }));
    expect(screen.queryByRole('complementary', { name: 'Cheatsheet headings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Show course chapters/ }));
    expect(screen.getByRole('complementary', { name: 'Cheatsheet headings' })).toBeInTheDocument();
  });
});

describe("chapter persistence", () => {
  it("remembers a closed chapter per course and defaults unseen chapters to open", async () => {
    const user = userEvent.setup();
    outlineAvailable = true;
    const first = renderShell();
    await screen.findByText("Chapter One");

    await user.click(screen.getByText("Chapter One"));
    expect(getUiState().chapters.demo["chapter-1"]).toBe(false);

    first.unmount();
    renderShell();
    await screen.findByText("Chapter Two");
    const nav = document.querySelector("nav") as HTMLElement;
    // The drill title also renders as the Main heading, so scope to the navbar.
    const navDrill = (title: string) =>
      Array.from(nav.querySelectorAll("p")).find((el) => el.textContent?.trim() === title) ?? null;
    // Chapter One was closed by the user, so its drills return inside an aria-hidden
    // Collapse. Chapter Two was never touched and must still default to open.
    expect(navDrill("First Drill")?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(navDrill("Third Drill")?.closest("[aria-hidden='true']")).toBeNull();
  });
});

describe("corrupt storage", () => {
  it("falls back to defaults instead of throwing", async () => {
    localStorage.setItem("interview-runner-ui-state", "{not json");
    outlineAvailable = true;
    renderShell();
    await screen.findByRole("complementary", { name: "Course outline" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Hide course chapters/ })).toBeInTheDocument();
    expect(getUiState().sidebarCollapsed).toBe(false);
    expect(getUiState().outlineCollapsed).toBe(false);
  });

  it("ignores wrong-typed fields but keeps valid ones", () => {
    localStorage.setItem(
      "interview-runner-ui-state",
      JSON.stringify({ sidebarCollapsed: "yes", outlineCollapsed: "yes", panels: { build: true, preview: 3 }, chapters: { demo: { "chapter-1": false } } }),
    );
    const state = getUiState();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.outlineCollapsed).toBe(false);
    expect(state.panels.build).toBe(true);
    expect(state.panels.preview).toBe(false);
    expect(state.chapters.demo["chapter-1"]).toBe(false);
  });
});
