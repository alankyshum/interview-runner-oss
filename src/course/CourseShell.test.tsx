import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ instructions, watcherResult, preview }: any) => { const url = String(instructions).match(/https?:\/\/\S+/)?.[0]; return <section role="region" aria-label="Code practice workspace" data-testid="coding-workspace-columns"><div data-testid="instruction-pane">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : instructions}</div>{preview}<button aria-label="Toggle Test results" /><div role="region" aria-label="Results">{watcherResult?.stale && <span>Tests have not run since this drill changed.</span>}{watcherResult?.tests?.map((test: any) => <span key={test.name}>{test.name}</span>)}</div></section>; },
}));

  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const manifest = { id: "demo", title: "Demo Course", chapters: [{ id: "chapter-1", title: "Chapter One", drills: [
  { contentType: "coding", id: "project-preview-card", title: "Coding Drill", kind: "logic", estMinutes: 10, sourcePath: "drills/demo/code.ts", testPath: "drills/demo/code.test.ts", instructions: "Build it.\n\n```text\nconst unbroken = 'averylongunbrokenvalue';\n```" },
  { contentType: "coding", id: "token-sse-partials", title: "Second Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/demo/other.ts", testPath: "drills/demo/other.test.ts", instructions: "Handle errors." },
] }] };

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })); }

describe("CourseShell", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/");
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/courses") return response([{ id: "demo", title: "Demo Course", chapterCount: 1, drillCount: 2 }]);
      if (url === "/api/courses/demo") return response(manifest);
      if (url === "/api/progress/demo") return response({});
      if (url === "/api/test-results") return response({ watcherRunning: true, tests: [] });
      if (url.startsWith("/api/outlines/")) return response({ error: `No outline for ${url.split("/").pop()}` }, 404);
      return response({});
    }));
  });

  it("lists chapters and drills and opens a coding workspace", async () => {
    const user = userEvent.setup();
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByText("Chapter One")).toBeInTheDocument();
    expect(screen.getAllByText("Coding Drill").length).toBeGreaterThan(0);
    expect(await screen.findByRole("textbox", { name: "Filter courses by title, company, role, or tag" })).toBeInTheDocument();
    await user.click(screen.getByText("Second Drill"));
    await waitFor(() => expect(screen.getAllByText("Second Drill").length).toBeGreaterThan(1));
  });

  it("does not navigate questions with page-level arrow keys", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByText("Chapter One");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(new URLSearchParams(location.search).get("drill")).toBe("project-preview-card");
  });

  it("passes question text to the sandbox workspace", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    const pane = await screen.findByTestId("instruction-pane");
    expect(pane).toHaveTextContent("Build it.");
  });
});
