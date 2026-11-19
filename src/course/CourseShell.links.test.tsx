import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ instructions, watcherResult, preview }: any) => { const url = String(instructions).match(/https?:\/\/\S+/)?.[0]; return <section role="region" aria-label="Code practice workspace" data-testid="coding-workspace-columns"><div data-testid="instruction-pane">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : instructions}</div>{preview}<button aria-label="Toggle Test results" /><div role="region" aria-label="Results">{watcherResult?.stale && <span>Tests have not run since this drill changed.</span>}{watcherResult?.tests?.map((test: any) => <span key={test.name}>{test.name}</span>)}</div></section>; },
}));

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const url = "https://web.mit.edu/6.031/www/sp22/classes/10-abstract-data-types/";
const manifest = { id: "demo", title: "Demo Course", chapters: [{ id: "chapter-1", title: "Chapter One", drills: [
  { contentType: "coding", id: "project-preview-card", title: "Coding Drill", kind: "logic", estMinutes: 10, sourcePath: "drills/demo/code.ts", testPath: "drills/demo/code.test.ts", instructions: `Read this: ${url}` },
] }] };

function response(body: unknown) { return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })); }

describe("CourseShell links", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((requestUrl: string) => {
      if (requestUrl === "/api/courses") return response([{ id: "demo", title: "Demo Course", chapterCount: 1, drillCount: 1 }]);
      if (requestUrl === "/api/courses/demo") return response(manifest);
      if (requestUrl === "/api/progress/demo") return response({});
      if (requestUrl === "/api/test-results") return response({ watcherRunning: true, tests: [] });
      if (requestUrl.startsWith("/api/outlines/")) return Promise.resolve(new Response(JSON.stringify({ error: `No outline for ${requestUrl.split("/").pop()}` }), { status: 404, headers: { "Content-Type": "application/json" } }));
      return response({});
    }));
  });

  it("autolinks bare URLs in drill instructions and opens them in a new tab", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    const link = await screen.findByRole("link", { name: url });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
