import { MantineProvider } from "@mantine/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'book' && ['d1', 'd2'].includes(drill) || ['old', 'new'].includes(course) && drill === 'shared' }; });
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ instructions, watcherResult, preview }: any) => { const url = String(instructions).match(/https?:\/\/\S+/)?.[0]; return <section role="region" aria-label="Code practice workspace" data-testid="coding-workspace-columns"><div data-testid="instruction-pane">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : instructions}</div>{preview}<button aria-label="Toggle Test results" /><div role="region" aria-label="Results">{watcherResult?.stale && <span>Tests have not run since this drill changed.</span>}{watcherResult?.tests?.map((test: any) => <span key={test.name}>{test.name}</span>)}</div></section>; },
}));

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const courses = [{ id: "book", title: "Systems Book", chapterCount: 1, drillCount: 2 }];
const manifest = {
  id: "book",
  title: "Systems Book",
  chapters: [{
    id: "chapter",
    title: "Core",
    drills: [
      { contentType: "reading", outlinePath: "outlines/book/d1.json", id: "d1", title: "First drill", kind: "logic", estMinutes: 10, sourcePath: "reading/book/d1.ts", instructions: "Legacy first instructions." },
      { contentType: "reading", outlinePath: "outlines/book/d2.json", id: "d2", title: "Second drill", kind: "logic", estMinutes: 10, sourcePath: "reading/book/d2.ts", instructions: "Legacy second instructions." },
    ],
  }],
};
const outline = (drillId: string, title: string) => ({ courseId: "book", drillId, title, nodes: [{ id: "overview", type: "claim", text: `${title} content` }] });
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function baseFetch(outlineFetch: (url: string) => Promise<Response>) {
  return vi.fn((url: string) => {
    if (url === "/api/courses") return json(courses);
    if (url === "/api/courses/book") return json(manifest);
    if (url.startsWith("/api/outlines/")) return outlineFetch(url);
    if (url === "/api/books") return json([]);
    if (url === "/api/test-results") return json({ available: false });
    if (url === "/api/progress/book" || url === "/api/book-chapter-rank/book") return new Promise<Response>(() => {});
    return json({});
  });
}

describe("CourseShell outline loading states", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/?course=book&chapter=chapter&drill=d1");
  });
  afterEach(() => { window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); });

  it("shows reader loading chrome immediately and never flashes legacy panes before the outline", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", baseFetch(() => pending.promise));
    render(<MantineProvider><CourseShell /></MantineProvider>);

    expect(await screen.findByRole("status")).toHaveTextContent("Loading course outline");
    expect(screen.getByTestId("reader-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("instruction-region")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy first instructions.")).not.toBeInTheDocument();

    await act(async () => pending.resolve(await json(outline("d1", "New first outline"))));
    expect(await screen.findByRole("heading", { name: "New first outline" })).toBeInTheDocument();
    expect(screen.queryByTestId("instruction-region")).not.toBeInTheDocument();
  });

  it("renders the coding workspace when a deterministic TypeScript drill also has an outline", async () => {
    const codingManifest = {
      ...manifest,
      chapters: [{
        ...manifest.chapters[0],
        drills: [{
          ...manifest.chapters[0].drills[0],
          contentType: "coding",
          outlinePath: undefined,
          testPath: "d1.test.ts",
        }],
      }],
    };
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/courses") return json(courses);
      if (url === "/api/courses/book") return json(codingManifest);
      if (url === "/api/outlines/book/d1") return json(outline("d1", "Coding outline"));
      if (url === "/api/drills/book/d1/source") return json({ content: "export const answer = 0;", filename: "d1.ts" });
      if (url === "/api/drills/book/d1/tests") return json({ files: [{ path: "d1.test.ts", filename: "d1.test.ts", content: "" }] });
      if (url === "/api/progress/book" || url === "/api/book-chapter-rank/book") return json({});
      if (url === "/api/books") return json([]);
      if (url === "/api/test-results") return json({ available: false });
      if (url.startsWith("/api/progress/book/d1/submissions")) return json({ submissions: [], draftTimeline: [] });
      return json({});
    }));

    render(<MantineProvider><CourseShell /></MantineProvider>);

    expect(await screen.findByTestId("coding-workspace-columns")).toBeInTheDocument();
    expect(screen.queryByTestId("outline-reader")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reader-skeleton")).not.toBeInTheDocument();
  });

  it("ignores an old outline response after switching drills", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", baseFetch((url) => url.endsWith("/d1") ? first.promise : second.promise));
    render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByRole("status");

    const nav = document.querySelector("nav") as HTMLElement;
    await userEvent.click(await within(nav).findByText("Second drill"));
    await act(async () => first.resolve(await json(outline("d1", "Stale first outline"))));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Stale first outline" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Loading course outline");

    await act(async () => second.resolve(await json(outline("d2", "Current second outline"))));
    expect(await screen.findByRole("heading", { name: "Current second outline" })).toBeInTheDocument();
  });

  it("ignores old outline and progress responses after switching courses", async () => {
    const oldOutline = deferred<Response>();
    const oldProgress = deferred<Response>();
    const courseList = [
      { id: "old", title: "Old Course", chapterCount: 1, drillCount: 1 },
      { id: "new", title: "New Course", chapterCount: 1, drillCount: 1 },
    ];
    const courseManifest = (id: string, title: string) => ({ id, title, chapters: [{ id: "chapter", title: `${title} chapter`, drills: [{ contentType: "reading", outlinePath: `outlines/${id}/shared.json`, id: "shared", title: `${title} drill`, kind: "logic", estMinutes: 5, sourcePath: `reading/${id}/${id}.ts`, instructions: `${title} legacy.` }] }] });
    window.history.replaceState({}, "", "/?course=old");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/courses") return json(courseList);
      if (url === "/api/courses/old") return json(courseManifest("old", "Old Course"));
      if (url === "/api/courses/new") return json(courseManifest("new", "New Course"));
      if (url === "/api/outlines/old/shared") return oldOutline.promise;
      if (url === "/api/outlines/new/shared") return json({ courseId: "new", drillId: "shared", title: "New course outline", nodes: [{ id: "new-node", type: "claim", text: "Current" }] });
      if (url === "/api/progress/old") return oldProgress.promise;
      if (url === "/api/progress/new" || url.includes("book-chapter-rank") || url === "/api/books") return json(url === "/api/books" ? [] : {});
      if (url === "/api/test-results") return json({ available: false });
      return json({});
    }));
    render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByText("Old Course chapter");

    await userEvent.click(await screen.findByRole("button", { name: /^New Course .*0 of 1 drills complete/ }));
    expect(await screen.findByRole("heading", { name: "New course outline" })).toBeInTheDocument();

    await act(async () => {
      oldOutline.resolve(await json({ courseId: "old", drillId: "shared", title: "Stale old outline", nodes: [{ id: "old-node", type: "claim", text: "Stale" }] }));
      oldProgress.resolve(await json({ shared: { status: "done", updatedAt: "2026-01-01T00:00:00.000Z" } }));
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Stale old outline" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "New course outline" })).toBeInTheDocument();
    expect(within(document.querySelector("nav") as HTMLElement).getByText("0/1")).toBeInTheDocument();
  });

  it("reports a missing declared outline instead of switching lesson modes", async () => {
    vi.stubGlobal("fetch", baseFetch(() => json({ error: "No outline for d1" }, 404)));
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("declared reading outline is missing");
    expect(screen.queryByTestId("instruction-region")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reader-skeleton")).not.toBeInTheDocument();
  });

  it.each([
    ["server failure", () => json({ error: "failed" }, 500), /could not be loaded \(500\)/i],
    ["malformed payload", () => json({ courseId: "book", drillId: "d1" }), /invalid data/i],
    ["generic 404", () => json({ error: "Not found" }, 404), /could not be loaded \(404\)/i],
    ["unknown drill 404", () => json({ error: "Unknown drill: d1" }, 404), /could not be loaded \(404\)/i],
  ])("renders an explicit alert for %s instead of legacy panes", async (_name, load, message) => {
    vi.stubGlobal("fetch", baseFetch(load));
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByTestId("instruction-region")).not.toBeInTheDocument();
  });

  it("does not downgrade saved done progress before course and reader state hydrate", async () => {
    const savedProgress = deferred<Response>();
    const savedReader = deferred<Response>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/courses") return json(courses);
      if (url === "/api/courses/book") return json(manifest);
      if (url === "/api/outlines/book/d1") return json(outline("d1", "Saved outline"));
      if (url === "/api/progress/book") return savedProgress.promise;
      if (url === "/api/outline-state/book/d1") return savedReader.promise;
      if (url === "/api/books") return json([]);
      if (url === "/api/book-chapter-rank/book" || url === "/api/test-results") return json(url === "/api/test-results" ? { available: false } : {});
      if (url === "/api/progress/book/d1" && init?.method === "PUT") return json({ status: "in-progress", updatedAt: "2026-01-01T00:00:00.000Z" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("heading", { name: "Saved outline" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/progress/book/d1" && init?.method === "PUT")).toHaveLength(0);

    await act(async () => savedReader.resolve(await json({ overview: { checked: true } })));
    await waitFor(() => expect(screen.getByLabelText("Reading progress: 100%")).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/progress/book/d1" && init?.method === "PUT")).toHaveLength(0);

    await act(async () => savedProgress.resolve(await json({ d1: { status: "done", updatedAt: "2026-01-01T00:00:00.000Z" } })));
    await waitFor(() => expect(within(document.querySelector("nav") as HTMLElement).getByText("1/2")).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/progress/book/d1" && init?.method === "PUT")).toHaveLength(0);
  });

  it("ignores a late progress save response from the previous course", async () => {
    const oldSave = deferred<Response>();
    const courseList = [
      { id: "old", title: "Old Course", chapterCount: 1, drillCount: 1 },
      { id: "new", title: "New Course", chapterCount: 1, drillCount: 1 },
    ];
    const courseManifest = (id: string, title: string) => ({ id, title, chapters: [{ id: "chapter", title: `${title} chapter`, drills: [{ contentType: "reading", outlinePath: `outlines/${id}/shared.json`, id: "shared", title: `${title} drill`, kind: "logic", estMinutes: 5, sourcePath: `reading/${id}/${id}.ts`, instructions: `${title} legacy.` }] }] });
    window.history.replaceState({}, "", "/?course=old");
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/courses") return json(courseList);
      if (url === "/api/courses/old") return json(courseManifest("old", "Old Course"));
      if (url === "/api/courses/new") return json(courseManifest("new", "New Course"));
      if (url === "/api/outlines/old/shared") return json({ courseId: "old", drillId: "shared", title: "Old outline", nodes: [{ id: "old-node", type: "claim", text: "Old" }] });
      if (url === "/api/outlines/new/shared") return json({ courseId: "new", drillId: "shared", title: "New outline", nodes: [{ id: "new-node", type: "claim", text: "New" }] });
      if (url === "/api/outline-state/old/shared" || url === "/api/outline-state/new/shared") return json({});
      if (url === "/api/progress/old" || url === "/api/progress/new") return json({});
      if (url === "/api/progress/old/shared" && init?.method === "PUT") return oldSave.promise;
      if (url === "/api/progress/new/shared" && init?.method === "PUT") return json({ status: "in-progress", updatedAt: "2026-01-02T00:00:00.000Z" });
      if (url === "/api/books") return json([]);
      if (url.includes("book-chapter-rank") || url === "/api/test-results") return json(url === "/api/test-results" ? { available: false } : {});
      return json({});
    }));
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("heading", { name: "Old outline" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/progress/old/shared" && init?.method === "PUT")).toBe(true));

    await userEvent.click(await screen.findByRole("button", { name: /^New Course .*0 of 1 drills complete/ }));
    expect(await screen.findByRole("heading", { name: "New outline" })).toBeInTheDocument();
    await waitFor(() => expect(within(document.querySelector("nav") as HTMLElement).getByText("0/1")).toBeInTheDocument());

    await act(async () => oldSave.resolve(await json({ status: "done", updatedAt: "2026-01-03T00:00:00.000Z" })));
    await waitFor(() => expect(within(document.querySelector("nav") as HTMLElement).getByText("0/1")).toBeInTheDocument());
    expect(screen.queryByText("1/1")).not.toBeInTheDocument();
  });
});
