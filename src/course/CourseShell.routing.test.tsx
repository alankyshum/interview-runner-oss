import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'hooli-growth-loop' && drill === 'signal-hub-deep-dive' }; });
import CourseShell from "./CourseShell";

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const courses = [
  { id: "hooli-growth-loop", title: "Hooli Growth Loop", chapterCount: 1, drillCount: 1 },
  { id: "globex-loop-prep", title: "Globex Loop Prep", chapterCount: 2, drillCount: 3 },
];
const manifests = {
  "hooli-growth-loop": { id: "hooli-growth-loop", title: "Hooli Growth Loop", chapters: [{ id: "chapter", title: "Growth Stories", drills: [{ contentType: "reading", id: "signal-hub-deep-dive", title: "Account IQ deep dive", kind: "scratch", estMinutes: 5, sourcePath: "drills/hooli-growth-loop/account.ts", outlinePath: "outlines/hooli-growth-loop/signal-hub-deep-dive.json", instructions: "Growth instructions." }] }] },
  "globex-loop-prep": {
    id: "globex-loop-prep",
    title: "Globex Loop Prep",
    chapters: [
      { id: "day-1", title: "Concurrency Core", drills: [{ contentType: "coding", id: "bounded-parallel-runner", title: "Bounded Runner", kind: "logic", estMinutes: 5, sourcePath: "drills/globex-loop-prep/runner.ts", testPath: "drills/globex-loop-prep/runner.test.ts", instructions: "Runner instructions." }] },
      { id: "day-2", title: "Deployment Workflows", drills: [{ contentType: "coding", id: "build-graph-cache-invalidation", title: "Cache Invalidation", kind: "logic", estMinutes: 5, sourcePath: "drills/globex-loop-prep/cache.ts", testPath: "drills/globex-loop-prep/cache.test.ts", instructions: "Cache instructions." }, { contentType: "coding", id: "idempotent-partial-deploy-retry", title: "Deploy Retry", kind: "logic", estMinutes: 5, sourcePath: "drills/globex-loop-prep/deploy.ts", testPath: "drills/globex-loop-prep/deploy.test.ts", instructions: "Deploy instructions." }] },
    ],
  },
};
function response(body: unknown) { return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })); }
function mockApi() {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/courses") return response(courses);
    const match = url.match(/^\/api\/courses\/([^/]+)$/);
    if (match) return response(manifests[decodeURIComponent(match[1]) as keyof typeof manifests]);
    if (url.startsWith("/api/progress/")) return response({});
    if (url === "/api/test-results") return response({ available: false });
    if (url.startsWith("/api/outlines/")) return Promise.resolve(new Response(JSON.stringify({ error: `No outline for ${url.split("/").pop()}` }), { status: 404, headers: { "Content-Type": "application/json" } }));
    return response({});
  }));
}
describe("CourseShell URL routing", () => {
  beforeEach(() => { localStorage.clear(); mockApi(); });
  afterEach(() => { window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); });
  it("loads an empty workspace without opening another workspace's course", async () => {
    window.history.replaceState({}, "", "/?workspace=pat");
    const fetcher = vi.mocked(fetch); const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, ...rest) => {
      if (typeof url === 'string' && url.startsWith('/api/library')) return response({ categories: [], items: [], courseRepos: ['me', 'pat'], workspaceMode: true });
      if (url === '/api/courses') return response(courses.map((course) => ({ ...course, repo: 'me' })));
      return original(url, ...rest);
    });
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByText(/No courses are available from pat/)).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => typeof url === 'string' && url.startsWith('/api/courses/'))).toBe(false);
  });
  it("resolves an unscoped course link to its workspace", async () => {
    localStorage.setItem('interview-runner-category', 'cheatsheets');
    window.history.replaceState({}, "", "/?course=globex-loop-prep&chapter=day-2&drill=idempotent-partial-deploy-retry");
    const fetcher = vi.mocked(fetch); const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, ...rest) => {
      if (typeof url === 'string' && url.startsWith('/api/library')) return response({ categories: [], items: [], courseRepos: ['me', 'pat'], workspaceMode: true });
      if (url === '/api/courses') return response(courses.map((course) => ({ ...course, repo: 'me' })));
      return original(url, ...rest);
    });
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole('heading', { name: 'Deploy Retry' })).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get('workspace')).toBe('me');
  });
  it.each([["globex-loop-prep", "Globex Loop Prep", "Concurrency Core"], ["hooli-growth-loop", "Hooli Growth Loop", "Growth Stories"]])("selects the course requested by ?course=%s", async (id, title, chapter) => {
    window.history.replaceState({}, "", `/?course=${id}`);
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect((await screen.findAllByText(title)).length).toBeGreaterThan(0);
    expect(await screen.findByText(chapter)).toBeInTheDocument();
  });
  it("reports an unknown URL course id with available ids", async () => {
    window.history.replaceState({}, "", "/?course=does-not-exist");
    render(<MantineProvider><CourseShell /></MantineProvider>);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("does-not-exist");
    expect(alert).toHaveTextContent("hooli-growth-loop");
    expect(alert).toHaveTextContent("globex-loop-prep");
  });
  it("selects the requested chapter and keeps it in the URL", async () => {
    window.history.replaceState({}, "", "/?course=globex-loop-prep&chapter=day-2");
    const first = render(<MantineProvider><CourseShell /></MantineProvider>);

    expect(await screen.findByRole("heading", { name: "Cache Invalidation" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("chapter")).toBe("day-2");

    first.unmount();
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("heading", { name: "Cache Invalidation" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("chapter")).toBe("day-2");
  });
  it("keeps the selected drill in the URL and restores it on reload", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?course=globex-loop-prep");
    const first = render(<MantineProvider><CourseShell /></MantineProvider>);

    // The second drill of a non-default chapter: neither the course nor the chapter
    // default would land here, so only the drill param can restore it.
    await user.click(await screen.findByText("Deploy Retry"));
    expect(await screen.findByRole("heading", { name: "Deploy Retry" })).toBeInTheDocument();
    const params = new URLSearchParams(window.location.search);
    expect({ chapter: params.get("chapter"), drill: params.get("drill") }).toEqual({ chapter: "day-2", drill: "idempotent-partial-deploy-retry" });

    first.unmount();
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("heading", { name: "Deploy Retry" })).toBeInTheDocument();
  });
  it("falls back to the chapter's first drill when the drill id is unknown", async () => {
    window.history.replaceState({}, "", "/?course=globex-loop-prep&chapter=day-2&drill=does-not-exist");
    render(<MantineProvider><CourseShell /></MantineProvider>);

    expect(await screen.findByRole("heading", { name: "Cache Invalidation" })).toBeInTheDocument();
    const params = new URLSearchParams(window.location.search);
    expect({ chapter: params.get("chapter"), drill: params.get("drill") }).toEqual({ chapter: "day-2", drill: "build-graph-cache-invalidation" });
  });
  it("updates the chapter URL when a drill is selected", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?course=globex-loop-prep");
    render(<MantineProvider><CourseShell /></MantineProvider>);

    await user.click(await screen.findByText("Cache Invalidation"));

    expect(await screen.findByRole("heading", { name: "Cache Invalidation" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("chapter")).toBe("day-2");
  });
});
