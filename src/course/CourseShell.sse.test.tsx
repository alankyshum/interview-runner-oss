import { MantineProvider } from "@mantine/core";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ instructions, watcherResult, preview }: any) => { const url = String(instructions).match(/https?:\/\/\S+/)?.[0]; return <section role="region" aria-label="Code practice workspace" data-testid="coding-workspace-columns"><div data-testid="instruction-pane">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : instructions}</div>{preview}<button aria-label="Toggle Test results" /><div role="region" aria-label="Results">{watcherResult?.stale && <span>Tests have not run since this drill changed.</span>}{watcherResult?.tests?.map((test: any) => <span key={test.name}>{test.name}</span>)}</div></section>; },
}));

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

class FakeEventSource {
  static instance: FakeEventSource;
  listeners = new Map<string, EventListener>();
  close = vi.fn();
  constructor(public url: string) { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  removeEventListener(type: string, listener: EventListener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>); }
}

const manifest = {
  id: "demo", title: "Demo", chapters: [{ id: "chapter-a", title: "First chapter", drills: [
    { contentType: "coding", id: "drill-a", title: "First drill", kind: "logic", estMinutes: 10, sourcePath: "drills/a.ts", testPath: "drills/a.test.ts", instructions: "Test it." },
    { contentType: "coding", id: "drill-b", title: "Second drill", kind: "logic", estMinutes: 10, sourcePath: "drills/b.ts", testPath: "drills/b.test.ts", instructions: "Test it." },
  ] }],
};

function response(body: unknown) { return Promise.resolve(new Response(JSON.stringify(body), { status: 200 })); }

describe("CourseShell SSE test results", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?course=demo");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/courses") return response([{ id: "demo", title: "Demo", chapterCount: 1, drillCount: 2 }]);
      if (url === "/api/courses/demo") return response(manifest);
      if (url.startsWith("/api/progress/")) return response({});
      if (url.startsWith("/api/outlines/")) return Promise.resolve(new Response(JSON.stringify({ error: `No outline for ${url.split("/").pop()}` }), { status: 404, headers: { "Content-Type": "application/json" } }));
      return response({});
    }));
  });
  afterEach(() => { window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); });

  it("applies an update only to the selected stable drill id", async () => {
    const view = render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByText("First chapter")).toBeInTheDocument();
    act(() => FakeEventSource.instance.emit("snapshot", { available: true, files: { "/host/drills/b.test.ts": { status: "failed", tests: [{ name: "wrong collision", status: "failed" }], updatedAt: "old" } } }));
    act(() => FakeEventSource.instance.emit("test-result", { courseId: "demo", chapterId: "chapter-a", drillId: "drill-b", testPath: "drills/b.test.ts", result: { status: "passed", updatedAt: "now", tests: [{ name: "only second", status: "passed" }] } }));
    expect(screen.queryByText("only second")).not.toBeInTheDocument();
    act(() => screen.getByText("Second drill").click());
    await waitFor(() => expect(screen.getByText("only second")).toBeInTheDocument());
    act(() => FakeEventSource.instance.emit("test-result", { courseId: "demo", chapterId: "chapter-a", drillId: "drill-a", testPath: "drills/a.test.ts", result: { status: "passed", updatedAt: "now", tests: [{ name: "only first", status: "passed" }] } }));
    act(() => screen.getByText("First drill").click());
    await waitFor(() => expect(screen.getByText("only first")).toBeInTheDocument());
    expect(await screen.findByText("only first")).toBeInTheDocument();
    view.unmount();
    expect(FakeEventSource.instance.close).toHaveBeenCalledOnce();
  });

  it("replaces a stale skipped result when the same drill reports fresh results", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByText("First chapter")).toBeInTheDocument();
    act(() => FakeEventSource.instance.emit("snapshot", { available: true, files: { "drills/a.test.ts": { status: "skipped", tests: [], updatedAt: "old", stale: true, staleReason: "drill-changed" } } }));
    expect(screen.getByText("Tests have not run since this drill changed.")).toBeInTheDocument();
    expect(screen.queryByText("This drill was skipped.")).not.toBeInTheDocument();
    act(() => FakeEventSource.instance.emit("test-result", { courseId: "demo", chapterId: "chapter-a", drillId: "drill-a", testPath: "drills/a.test.ts", result: { status: "passed", updatedAt: "new", tests: [{ name: "fresh assertion", status: "passed" }] } }));
    expect(await screen.findByText("fresh assertion")).toBeInTheDocument();
    expect(screen.queryByText("Tests have not run since this drill changed.")).not.toBeInTheDocument();
  });
});
